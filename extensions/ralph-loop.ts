/**
 * Ralph loop extension - repeat state-specific prompts in fresh sessions until the task is done.
 *
 * Install as a pi package:
 *   pi install git:github.com/<user>/pi-ralph-loop   (or a local path)
 *
 * The state machine is user-configurable via .ralph/workflow.yaml: a directed
 * cyclic graph where each state has EXACTLY ONE outgoing edge (transition).
 * The machine is OWNED BY THE EXTENSION (persisted in .ralph/state.json; the
 * agent never reads or writes it) and flips deterministically after each round.
 *
 * Per-state configuration (all in workflow.yaml):
 *   prompt                 - prompt file path, relative to the workflow dir
 *   transition             - the single next state (enforced at validation)
 *   records_commit_range   - record HEAD before/after the round as from/to
 *   consumes_commit_range  - inject from/to into the directive, clear them after
 *   expect_no_commit       - warn if HEAD changed during the round (violation)
 *   directive              - custom directive template; {{state}}/{{from}}/{{to}}
 *   model                   - "provider/modelId" to run this state's rounds on
 *                             (falls back to the model pinned at /ralph start)
 *   block.tools            - tool names to block in this state
 *   block.bash_patterns    - regexes; matching bash commands are blocked
 *
 * Top-level configuration:
 *   initial             - the state the loop starts from
 *   no_progress_limit   - circuit breaker: stop after N consecutive rounds
 *                         (any state) without a new commit (default 3)
 *   done_marker         - marker in an assistant reply that ends the loop
 *
 * The extension drives the loop: each round it starts a brand-new session
 * (fresh context), sends the state's prompt plus an injected "本轮模式"
 * directive, waits for the agent to settle, then applies the transition.
 *
 * Presets (预制工作流): a preset is a directory holding workflow.yaml plus its
 * prompt files. Presets are layered - builtin (<package>/workflows/), global
 * ($PI_CODING_AGENT_DIR/ralph/workflows/, default ~/.pi/agent/ralph/workflows/)
 * and project (.ralph/workflows/). Same name at a later layer wins. Preset
 * directories are read-only: runtime state (state.json/driver.json/config.json)
 * always lives in .ralph/, and driver.json records which workflow dir is active.
 *
 * Termination: done_marker in the agent reply, /ralph stop, maxRounds,
 * or the no-progress circuit breaker.
 *
 * Usage:
 *   /ralph init                     create .ralph/ from the builtin default preset
 *   /ralph start [preset] [rounds]  start the loop (no preset: .ralph/workflow.yaml)
 *   /ralph presets                  list available presets and their origin
 *   /ralph stop                     stop after the current round
 *   /ralph status                   show current round / state
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const RALPH_DIR = ".ralph";
const TODO_LABEL = "ralph:todo";
const DONE_MARKER = "[RALPH:DONE]";
const NO_PROGRESS_LIMIT = 3;
const DEFAULT_MAX_ROUNDS = 20;
const WIDGET_KEY = "ralph-loop";

const WORKFLOW_FILE = "workflow.yaml";
const WORKFLOWS_DIR = "workflows";
const DEFAULT_PRESET = "coding-review";
const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface BlockConfig {
	tools?: string[];
	bash_patterns?: string[];
}

interface WorkflowStateConfig {
	/** Prompt file path relative to .ralph/. */
	prompt: string;
	/** The single outgoing edge: unconditionally transition to this state after the round. */
	transition: string;
	/** Record HEAD before/after this round as the commit range (from/to). */
	records_commit_range?: boolean;
	/** Inject the recorded commit range into the directive; clear it after the round. */
	consumes_commit_range?: boolean;
	/** Warn if HEAD changed during this round (violation). */
	expect_no_commit?: boolean;
	/** Custom directive template with {{state}}/{{from}}/{{to}} placeholders. */
	directive?: string;
	/** Model to run this state's rounds on; falls back to the pinned model. */
	model?: { provider: string; modelId: string };
	block?: BlockConfig;
}

interface Workflow {
	initial: string;
	done_marker: string;
	no_progress_limit: number;
	/** Optional human-readable summary, shown by /ralph presets. */
	description?: string;
	states: Record<string, WorkflowStateConfig>;
}

type WorkflowResult = { workflow: Workflow; error?: undefined } | { workflow?: undefined; error: string };

interface RalphState {
	state: string;
	last_commit?: string;
	/** Commit range recorded by a state with records_commit_range; cleared after consumption. */
	from?: string;
	to?: string;
	done?: boolean;
}

interface RalphDriver {
	running: boolean;
	round: number;
	maxRounds: number;
	startedAt: string;
	lastMessage?: string;
	/** Model/thinking level pinned from the window where /ralph start ran. */
	model?: { provider: string; modelId: string; thinkingLevel?: string };
	/** Absolute dir holding the active workflow.yaml + prompts (a preset dir, or .ralph/). */
	workflowDir?: string;
}

function ralphPath(cwd: string, name: string): string {
	return join(cwd, RALPH_DIR, name);
}

/** Directory of the presets shipped inside this package (<package>/workflows/). */
export function builtinWorkflowsDir(): string {
	return fileURLToPath(new URL(`../${WORKFLOWS_DIR}/`, import.meta.url));
}

/**
 * Preset lookup roots, lowest precedence first: builtin < global < project.
 * The global root follows pi's PI_CODING_AGENT_DIR convention (default ~/.pi/agent).
 */
export function presetRoots(cwd: string): Array<{ dir: string; origin: string }> {
	const globalDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "ralph", WORKFLOWS_DIR);
	return [
		{ dir: builtinWorkflowsDir(), origin: "builtin" },
		{ dir: globalDir, origin: "global" },
		{ dir: join(cwd, RALPH_DIR, WORKFLOWS_DIR), origin: "project" },
	];
}

/** Effective presets across all layers; a later layer overrides an earlier one with the same name. */
export function findPresets(cwd: string): Array<{ name: string; dir: string; origin: string }> {
	const found = new Map<string, { name: string; dir: string; origin: string }>();
	for (const { dir: root, origin } of presetRoots(cwd)) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!PRESET_NAME_RE.test(name)) continue;
			const dir = join(root, name);
			try {
				if (!statSync(dir).isDirectory()) continue;
			} catch {
				continue;
			}
			if (!existsSync(join(dir, WORKFLOW_FILE))) continue;
			found.set(name, { name, dir, origin });
		}
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a preset by name (rejecting path traversal); project beats global beats builtin. */
export function resolvePreset(cwd: string, name: string): { dir: string; origin: string } | { error: string } {
	if (!PRESET_NAME_RE.test(name)) {
		return { error: `预设名 "${name}" 非法（仅允许字母、数字及 . _ -，且不以符号开头）` };
	}
	const presets = findPresets(cwd);
	const hit = presets.find((preset) => preset.name === name);
	if (!hit) {
		return { error: `预设 "${name}" 未找到。可用：${presets.map((preset) => preset.name).join(", ") || "(无)"}` };
	}
	return { dir: hit.dir, origin: hit.origin };
}

/** Dir holding the active workflow.yaml + prompts: the pinned preset dir, or .ralph/. */
function activeWorkflowDir(cwd: string): string {
	const driver = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
	return driver?.workflowDir ?? join(cwd, RALPH_DIR);
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function gitHead(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

/** Extract "org/repo" from a git remote URL, only for cnb.cool remotes. */
function repoFromRemote(cwd: string): string | undefined {
	try {
		let url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim();
		// Strip proxy prefixes like https://gh-proxy.org/https://github.com/...
		while (/^[a-z][a-z0-9+.-]*:\/\//.test(url)) url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
		url = url.replace(/^git@/, "").replace(/^[^/@]*@/, "");
		const match = url.match(/^(?<host>[^/:]+)[:/](?<path>.+?)(?:\.git)?$/);
		if (!match?.groups) return undefined;
		if (!/(^|\.)cnb\.cool$/.test(match.groups.host)) return undefined;
		return match.groups.path || undefined;
	} catch {
		return undefined;
	}
}

/** Validate a parsed workflow.yaml document. Throws nothing; returns a result. */
export function validateWorkflow(raw: unknown): WorkflowResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { error: "workflow 根节点必须是映射" };
	}
	const root = raw as Record<string, unknown>;

	const statesRaw = root.states;
	if (typeof statesRaw !== "object" || statesRaw === null || Array.isArray(statesRaw)) {
		return { error: "states 必须是映射" };
	}
	const states: Record<string, WorkflowStateConfig> = {};
	for (const [name, value] of Object.entries(statesRaw)) {
		if (typeof value !== "object" || value === null) return { error: `states.${name} 必须是映射` };
		const s = value as Record<string, unknown>;
		if (typeof s.prompt !== "string" || !s.prompt.trim()) {
			return { error: `states.${name}.prompt 必须是非空字符串（相对 .ralph/ 的路径）` };
		}
		if (typeof s.transition !== "string" || !s.transition.trim()) {
			return { error: `states.${name}.transition 必须是非空字符串（每状态仅一条出边）` };
		}
		let block: BlockConfig | undefined;
		if (s.block !== undefined) {
			if (typeof s.block !== "object" || s.block === null || Array.isArray(s.block)) {
				return { error: `states.${name}.block 必须是映射` };
			}
			const b = s.block as Record<string, unknown>;
			if (b.tools !== undefined && (!Array.isArray(b.tools) || b.tools.some((t) => typeof t !== "string"))) {
				return { error: `states.${name}.block.tools 必须是字符串列表` };
			}
			if (
				b.bash_patterns !== undefined &&
				(!Array.isArray(b.bash_patterns) || b.bash_patterns.some((p) => typeof p !== "string"))
			) {
				return { error: `states.${name}.block.bash_patterns 必须是字符串列表` };
			}
			for (const pattern of (b.bash_patterns as string[] | undefined) ?? []) {
				try {
					new RegExp(pattern);
				} catch (error) {
					return { error: `states.${name}.block.bash_patterns 含无效正则 "${pattern}": ${error instanceof Error ? error.message : String(error)}` };
				}
			}
			block = { tools: b.tools as string[] | undefined, bash_patterns: b.bash_patterns as string[] | undefined };
		}
		if (s.directive !== undefined && typeof s.directive !== "string") {
			return { error: `states.${name}.directive 必须是字符串` };
		}
		let model: { provider: string; modelId: string } | undefined;
		if (s.model !== undefined) {
			// Split on the FIRST slash: model ids may contain slashes themselves.
			if (typeof s.model !== "string" || !s.model.includes("/")) {
				return { error: `states.${name}.model 必须是 "provider/modelId" 格式` };
			}
			const slash = s.model.indexOf("/");
			model = { provider: s.model.slice(0, slash), modelId: s.model.slice(slash + 1) };
			if (!model.provider.trim() || !model.modelId.trim()) {
				return { error: `states.${name}.model 必须是 "provider/modelId" 格式` };
			}
		}
		states[name] = {
			prompt: s.prompt,
			transition: s.transition,
			records_commit_range: s.records_commit_range === true,
			consumes_commit_range: s.consumes_commit_range === true,
			expect_no_commit: s.expect_no_commit === true,
			directive: typeof s.directive === "string" ? s.directive : undefined,
			model,
			block,
		};
	}
	if (Object.keys(states).length === 0) return { error: "states 不能为空" };

	const initial = typeof root.initial === "string" ? root.initial : "";
	if (!states[initial]) return { error: `initial 状态 "${initial}" 未在 states 中定义` };
	for (const [name, config] of Object.entries(states)) {
		if (!states[config.transition]) {
			return { error: `states.${name}.transition 指向未定义状态 "${config.transition}"` };
		}
	}

	let noProgressLimit = NO_PROGRESS_LIMIT;
	if (root.no_progress_limit !== undefined) {
		if (typeof root.no_progress_limit !== "number" || !Number.isInteger(root.no_progress_limit) || root.no_progress_limit < 1) {
			return { error: "no_progress_limit 必须是 >= 1 的整数" };
		}
		noProgressLimit = root.no_progress_limit;
	}

	let doneMarker = DONE_MARKER;
	if (root.done_marker !== undefined) {
		if (typeof root.done_marker !== "string" || !root.done_marker.trim()) {
			return { error: "done_marker 必须是非空字符串" };
		}
		doneMarker = root.done_marker;
	}

	let description: string | undefined;
	if (root.description !== undefined) {
		if (typeof root.description !== "string") return { error: "description 必须是字符串" };
		description = root.description.trim() || undefined;
	}

	return { workflow: { initial, done_marker: doneMarker, no_progress_limit: noProgressLimit, description, states } };
}

/** Load and validate <dir>/workflow.yaml. The dir is either a preset dir or .ralph/. */
function loadWorkflow(dir: string): WorkflowResult {
	const path = join(dir, WORKFLOW_FILE);
	if (!existsSync(path)) return { error: `${path} 不存在（先运行 /ralph init 或检查预设）` };
	let raw: unknown;
	try {
		raw = parseYaml(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: `${path} 解析失败: ${error instanceof Error ? error.message : String(error)}` };
	}
	return validateWorkflow(raw);
}

/**
 * Build the "本轮模式" directive appended to the user prompt.
 * A custom per-state directive template wins; placeholders {{state}}/{{from}}/{{to}}
 * are substituted. The template supports a minimal {% if from %}...{% else %}...{% endif %}
 * branch so consuming states can phrase the "no new commits" case themselves.
 */
export function buildDirective(workflow: Workflow, state: RalphState): string {
	const name = state.state;
	const config = workflow.states[name];
	if (!config) return `---\n\n## 本轮模式（驱动程序注入）：${name}`;
	const hasRange = Boolean(state.from && state.to && state.from !== state.to);
	const vars = { state: name, from: hasRange ? state.from : "", to: hasRange ? state.to : "" };
	if (config.directive) {
		let text = config.directive;
		text = text.replace(/\{%\s*if\s+from\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g, (_m, ifPart: string, elsePart: string) => (hasRange ? ifPart : elsePart));
		return text.replace(/\{\{\s*(state|from|to)\s*\}\}/g, (_m, key: string) => vars[key as keyof typeof vars]);
	}
	const lines = [`## 本轮模式（驱动程序注入）：${name}`];
	if (config.consumes_commit_range) {
		lines.push(hasRange ? `提交区间：${state.from}..${state.to}` : "本轮没有新提交区间。");
	}
	if (config.expect_no_commit) {
		lines.push("本轮不得产生任何 commit。");
	}
	return `---\n\n${lines.join("\n")}`;
}

/** Recursively copy src into dest, creating dirs and never overwriting existing files. */
function copyMissing(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		if (entry.isDirectory()) copyMissing(from, to);
		else if (!existsSync(to)) copyFileSync(from, to);
	}
}

/** Materialize the builtin default preset into .ralph/ (plain mode), never overwriting. */
function materializeDefaultWorkflow(cwd: string): void {
	const src = join(builtinWorkflowsDir(), DEFAULT_PRESET);
	if (existsSync(src)) copyMissing(src, join(cwd, RALPH_DIR));
}

/** Create the runtime files (.ralph/state.json, .ralph/config.json) if missing. */
function ensureRuntimeFiles(cwd: string, initial: string): Array<{ message: string; type: "info" | "warning" }> {
	mkdirSync(join(cwd, RALPH_DIR), { recursive: true });
	const messages: Array<{ message: string; type: "info" | "warning" }> = [];
	if (!existsSync(ralphPath(cwd, "state.json"))) {
		writeJson(ralphPath(cwd, "state.json"), { state: initial, done: false } satisfies RalphState);
	}
	if (!existsSync(ralphPath(cwd, "config.json"))) {
		const repo = repoFromRemote(cwd);
		writeJson(ralphPath(cwd, "config.json"), repo ? { repo } : {});
		messages.push(
			repo
				? { message: `ralph: repo = ${repo}`, type: "info" }
				: { message: "ralph: could not detect repo from git remote; set .ralph/config.json manually", type: "warning" },
		);
	}
	return messages;
}

/** /ralph init: scaffold .ralph/ from the builtin default preset, without overwriting. */
function initRalphFiles(cwd: string): Array<{ message: string; type: "info" | "warning" }> {
	const initial = loadWorkflow(join(builtinWorkflowsDir(), DEFAULT_PRESET)).workflow?.initial ?? "coding";
	materializeDefaultWorkflow(cwd);
	return ensureRuntimeFiles(cwd, initial);
}

export default function (pi: ExtensionAPI) {
	// Re-apply the model on every session replacement. A state-specific model
	// (workflow.yaml states.<name>.model) takes precedence over the model pinned
	// at /ralph start. The new session's extension instance is bound to that
	// session, so its pi.setModel() works here (model_change entries alone are
	// not enough: createAgentSession only restores the model from session entries
	// when messages already exist).
	pi.on("session_start", async (_event, ctx) => {
		const driver = readJson<RalphDriver>(ralphPath(ctx.cwd, "driver.json"));
		if (!driver?.running) return;

		let stateModel: { provider: string; modelId: string } | undefined;
		const state = readJson<RalphState>(ralphPath(ctx.cwd, "state.json"));
		if (state) {
			const { workflow } = loadWorkflow(activeWorkflowDir(ctx.cwd));
			stateModel = workflow?.states[state.state]?.model;
		}
		const target = stateModel ?? driver.model;
		if (!target) return;
		if (ctx.model?.provider === target.provider && ctx.model?.id === target.modelId) return;
		const model = ctx.modelRegistry.find(target.provider, target.modelId);
		if (!model) {
			ctx.ui.notify(`ralph: could not pin model ${target.provider}/${target.modelId}: not found`, "warning");
			return;
		}
		try {
			await pi.setModel(model);
			// The thinking level captured at /ralph start belongs to the pinned
			// model; do not force it onto a state-specific model.
			if (!stateModel && driver.model?.thinkingLevel) {
				pi.setThinkingLevel(driver.model.thinkingLevel as ThinkingLevel);
			}
		} catch (error) {
			ctx.ui.notify(`ralph: could not pin model ${target.provider}/${target.modelId}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	// Hard enforcement of the state machine. Reads state from disk so it keeps
	// working across session replacements (extension instances are reloaded).
	pi.on("tool_call", (event, ctx) => {
		const cwd = ctx.cwd;
		const driver = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
		if (!driver?.running) return;
		const state = readJson<RalphState>(ralphPath(cwd, "state.json"));
		if (!state) return;
		const { workflow } = loadWorkflow(activeWorkflowDir(cwd));
		const config = workflow?.states[state.state];
		if (!config?.block) return;

		if (config.block.tools?.includes(event.toolName)) {
			return { block: true, reason: `ralph ${state.state} 轮禁止使用 ${event.toolName}（state machine enforcement）` };
		}
		if (event.toolName === "bash" && config.block.bash_patterns) {
			const command = (event.input as { command?: string } | undefined)?.command ?? "";
			for (const pattern of config.block.bash_patterns) {
				try {
					if (new RegExp(pattern).test(command)) {
						return { block: true, reason: `ralph ${state.state} 轮禁止执行该命令（state machine enforcement）` };
					}
				} catch {
					// Invalid regex slipped past validation; skip it.
				}
			}
		}
	});

	pi.registerCommand("ralph", {
		description: "Ralph loop: init/start [preset]/presets/stop/status - repeat state prompts in fresh sessions until done",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const sub = args.trim().split(/\s+/)[0] ?? "";

			if (sub === "status") {
				const driver = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
				const state = readJson<RalphState>(ralphPath(cwd, "state.json"));
				if (!driver) {
					ctx.ui.notify("ralph: not initialized (run /ralph start)", "info");
					return;
				}
				const workflowDir = activeWorkflowDir(cwd);
				const workflow = loadWorkflow(workflowDir);
				ctx.ui.notify(
					[
						`ralph: ${driver.running ? "RUNNING" : "stopped"} · round ${driver.round}/${driver.maxRounds}`,
						workflow.workflow
							? `workflow: ${Object.entries(workflow.workflow.states)
								.map(([n, c]) => (c.model ? `${n}(${c.model.provider}/${c.model.modelId})` : n))
								.join(" -> ")} (initial: ${workflow.workflow.initial})`
							: `workflow: invalid - ${workflow.error}`,
						workflowDir === join(cwd, RALPH_DIR) ? "" : `preset: ${basename(workflowDir)}`,
						`state: ${state ? JSON.stringify(state) : "(none)"}`,
						driver.lastMessage ? `last: ${driver.lastMessage}` : "",
					]
						.filter(Boolean)
						.join("\n"),
					"info",
				);
				return;
			}

			if (sub === "stop") {
				const driver = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
				if (driver?.running) {
					writeFileSync(ralphPath(cwd, "stop"), "");
					ctx.ui.notify("ralph: will stop after the current round finishes", "warning");
				} else {
					rmSync(ralphPath(cwd, "stop"), { force: true });
					ctx.ui.notify("ralph: not running", "info");
				}
				return;
			}

			if (sub === "presets") {
				const presets = findPresets(cwd);
				if (presets.length === 0) {
					ctx.ui.notify("ralph: 没有找到任何预设", "warning");
					return;
				}
				const lines = presets.map(({ name, dir, origin }) => {
					const { workflow } = loadWorkflow(dir);
					return `${name} [${origin}]${workflow?.description ? ` - ${workflow.description}` : ""}${workflow ? "" : " (invalid)"}`;
				});
				ctx.ui.notify(`ralph presets:\n${lines.join("\n")}\n\nrun: /ralph start <name> [maxRounds]`, "info");
				return;
			}

			if (sub === "init") {
				for (const { message, type } of initRalphFiles(cwd)) {
					ctx.ui.notify(message, type);
				}
				ctx.ui.notify(`ralph: initialized .ralph/ (${WORKFLOW_FILE}, prompts/, state.json, config.json)`, "info");
				return;
			}

			if (sub !== "start") {
				ctx.ui.notify("Usage: /ralph init | /ralph start [preset] [maxRounds] | /ralph presets | /ralph stop | /ralph status", "info");
				return;
			}

			// /ralph start [preset] [maxRounds]. A leading integer keeps the legacy
			// plain form (/ralph start 30) reading .ralph/workflow.yaml.
			const parts = args.trim().split(/\s+/).slice(1);
			let presetName: string | undefined;
			let roundsArg: string | undefined;
			if (parts[0] && /^\d+$/.test(parts[0])) {
				roundsArg = parts[0];
			} else if (parts[0]) {
				presetName = parts[0];
				roundsArg = parts[1];
			}
			const maxRounds = Math.min(Math.max(Number.parseInt(roundsArg ?? "", 10) || DEFAULT_MAX_ROUNDS, 1), 200);

			const existing = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
			if (existing?.running) {
				ctx.ui.notify("ralph: already running (check /ralph status). If stale, run /ralph stop first.", "error");
				return;
			}

			let workflowDir = join(cwd, RALPH_DIR);
			if (presetName) {
				const resolved = resolvePreset(cwd, presetName);
				if ("error" in resolved) {
					ctx.ui.notify(`ralph: ${resolved.error}`, "error");
					return;
				}
				workflowDir = resolved.dir;
			} else {
				materializeDefaultWorkflow(cwd);
			}

			const workflowResult = loadWorkflow(workflowDir);
			if (!workflowResult.workflow) {
				ctx.ui.notify(`ralph: ${workflowResult.error}`, "error");
				return;
			}
			const workflow = workflowResult.workflow;

			// Validate every state's prompt file (and model) up front, before any
			// runtime side effect, so a failed start never mutates state.
			const prompts: Record<string, string> = {};
			for (const [name, config] of Object.entries(workflow.states)) {
				if (config.model && !ctx.modelRegistry.find(config.model.provider, config.model.modelId)) {
					ctx.ui.notify(`ralph: states.${name}.model 未找到: ${config.model.provider}/${config.model.modelId}`, "error");
					return;
				}
				const promptPath = join(workflowDir, config.prompt);
				if (!existsSync(promptPath)) {
					ctx.ui.notify(`ralph: states.${name}.prompt 文件不存在: ${promptPath}`, "error");
					return;
				}
				const prompt = readFileSync(promptPath, "utf8");
				if (!prompt.trim()) {
					ctx.ui.notify(`ralph: states.${name}.prompt 文件为空: ${promptPath}`, "error");
					return;
				}
				prompts[name] = prompt;
			}

			for (const { message, type } of ensureRuntimeFiles(cwd, workflow.initial)) {
				ctx.ui.notify(message, type);
			}

			// A state left over from a different workflow cannot be advanced; reset it.
			const persisted = readJson<RalphState>(ralphPath(cwd, "state.json"));
			if (persisted && !workflow.states[persisted.state]) {
				writeJson(ralphPath(cwd, "state.json"), { state: workflow.initial, done: false } satisfies RalphState);
				ctx.ui.notify(`ralph: state "${persisted.state}" 不属于该 workflow，重置为 "${workflow.initial}"`, "warning");
			}

			writeJson(ralphPath(cwd, "driver.json"), {
				running: true,
				round: 0,
				maxRounds,
				startedAt: new Date().toISOString(),
				model: ctx.model
					? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel }
					: undefined,
				workflowDir,
			} satisfies RalphDriver);

			ctx.ui.notify(
				`ralph: starting loop (max ${maxRounds} rounds, ${presetName ? `preset: ${presetName}, ` : ""}workflow: ${Object.keys(workflow.states).join(" -> ")})`,
				"info",
			);
			if (ctx.model) {
				ctx.ui.notify(`ralph: pinned model ${ctx.model.provider}/${ctx.model.id}`, "info");
			}

			// Loop state lives in this closure. The handler keeps running across
			// session replacements; cross-instance signals (stop) go through files.
			// Global no-progress counter: any round without a new commit increments it,
			// any round with a commit resets it, regardless of state.
			let noProgressRounds = 0;

			const finish = (roundCtx: ExtensionCommandContext, message: string) => {
				const driver = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
				writeJson(ralphPath(cwd, "driver.json"), { ...(driver ?? { round: 0, maxRounds, startedAt: "" }), running: false, lastMessage: message });
				rmSync(ralphPath(cwd, "stop"), { force: true });
				if (roundCtx.hasUI) roundCtx.ui.setWidget(WIDGET_KEY, undefined);
				roundCtx.ui.notify(`ralph: ${message}`, "info");
			};

			const setWidget = (roundCtx: ExtensionCommandContext, round: number, state: RalphState) => {
				if (!roundCtx.hasUI) return;
				const model = workflow.states[state.state]?.model;
				roundCtx.ui.setWidget(WIDGET_KEY, [
					`ralph loop · round ${round}/${maxRounds} · state: ${state.state}${model ? ` · model: ${model.provider}/${model.modelId}` : ""}`,
					`/ralph stop to halt · reply ${workflow.done_marker} ends the loop`,
				]);
			};

			/** Extension-owned transition after a finished round. ALWAYS applies the single outgoing edge. */
			const advance = (state: RalphState, headBefore: string | undefined): { violation?: string } => {
				const headAfter = gitHead(cwd);
				const committed = headAfter !== undefined && headAfter !== headBefore;
				const config = workflow.states[state.state];

				if (committed) noProgressRounds = 0;
				else noProgressRounds += 1;

				const violation =
					config?.expect_no_commit && committed
						? `WARNING: ${state.state} round produced commits (${headBefore} -> ${headAfter}) - agent bypassed enforcement`
						: undefined;

				let lastCommit = state.last_commit;
				if (committed) lastCommit = headAfter;
				// A consuming state hands the reviewed tip back as last_commit (mirrors the
				// old review->coding behavior).
				if (config?.consumes_commit_range && state.to) lastCommit = state.to;

				writeJson(ralphPath(cwd, "state.json"), {
					state: config?.transition ?? state.state,
					last_commit: lastCommit,
					from: config?.records_commit_range ? headBefore : config?.consumes_commit_range ? undefined : state.from,
					to: config?.records_commit_range ? headAfter : config?.consumes_commit_range ? undefined : state.to,
					done: false,
				} satisfies RalphState);
				return { violation };
			};

			const runRound = async (round: number, roundCtx: ExtensionCommandContext): Promise<void> => {
				const stopRequested = existsSync(ralphPath(cwd, "stop"));
				const state = readJson<RalphState>(ralphPath(cwd, "state.json"));

				if (stopRequested) {
					finish(roundCtx, `stopped by user at round ${round}`);
					return;
				}
				if (state?.done) {
					finish(roundCtx, `DONE at round ${round - 1}`);
					return;
				}
				if (round > maxRounds) {
					finish(roundCtx, `reached max rounds (${maxRounds})`);
					return;
				}
				if (!state) {
					finish(roundCtx, "state.json missing or invalid");
					return;
				}
				const stateConfig = workflow.states[state.state];
				if (!stateConfig) {
					finish(roundCtx, `state.json state "${state.state}" not defined in ${RALPH_DIR}/${WORKFLOW_FILE}`);
					return;
				}
				if (noProgressRounds >= workflow.no_progress_limit) {
					finish(roundCtx, `no new commits for ${noProgressRounds} consecutive rounds - stopping, likely stuck`);
					return;
				}

				const driver = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
				writeJson(ralphPath(cwd, "driver.json"), { ...(driver ?? {}), running: true, round, maxRounds });
				setWidget(roundCtx, round, state);

				// Machine-controlled mode directive appended to the user prompt.
				const directive = buildDirective(workflow, state);

				const headBefore = gitHead(cwd);
				const result = await roundCtx.newSession({
					withSession: async (freshCtx) => {
						try {
							await freshCtx.sendUserMessage(`${prompts[state.state]}\n\n${directive}`);
							await freshCtx.waitForIdle();
						} catch (error) {
							finish(freshCtx, `round ${round} failed: ${error instanceof Error ? error.message : String(error)}`);
							return;
						}

						// Termination by agent marker: scan the final assistant message.
						const branch = freshCtx.sessionManager.getBranch();
						let lastAssistant = "";
						for (let i = branch.length - 1; i >= 0; i--) {
							const entry = branch[i];
							if (entry.type === "message" && entry.message.role === "assistant") {
								lastAssistant = JSON.stringify(entry.message.content);
								break;
							}
						}
						if (lastAssistant.includes(workflow.done_marker)) {
							finish(freshCtx, `DONE at round ${round} (agent reported the task is complete)`);
							return;
						}

						const { violation } = advance(state, headBefore);
						if (violation) {
							freshCtx.ui.notify(`ralph: ${violation}`, "warning");
						}
						await runRound(round + 1, freshCtx);
					},
				});

				if (result.cancelled) {
					finish(roundCtx, `round ${round} session start was cancelled`);
				}
			};

			runRound(1, ctx).catch((error) => {
				finish(ctx, `loop crashed: ${error instanceof Error ? error.message : String(error)}`);
			});
		},
	});
}
