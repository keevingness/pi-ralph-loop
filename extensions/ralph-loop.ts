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
 *   prompt                 - prompt file path, relative to .ralph/
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
 * Termination: done_marker in the agent reply, /ralph stop, maxRounds,
 * or the no-progress circuit breaker.
 *
 * Usage:
 *   /ralph init                create .ralph/ with default workflow, prompts, state, config
 *   /ralph start [maxRounds]   start the loop (default maxRounds: 20)
 *   /ralph stop                stop after the current round
 *   /ralph status              show current round / state
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export const DEFAULT_WORKFLOW_YAML = `# ralph loop 状态机配置（有向有环图，每状态仅一条出边）。
#
# 顶层字段：
#   initial           起始状态
#   no_progress_limit 连续 N 轮（任意状态累计）无新 commit 即熔断，默认 3
#   done_marker       agent 回复中出现该标记则结束循环，默认 [RALPH:DONE]
#
# states.<name> 字段：
#   prompt                 提示词文件路径（相对 .ralph/）
#   transition             唯一出边：本轮结束后无条件流转到该状态
#   records_commit_range   本轮结束时记录 HEAD 区间（from/to）供后续状态消费
#   consumes_commit_range  指令中注入提交区间 from..to，本轮结束后清空
#   expect_no_commit       本轮结束后 HEAD 有变化则告警违规
#   directive              自定义指令模板，支持 {{state}}/{{from}}/{{to}} 占位符
#   model                   本状态使用的模型，格式 provider/modelId（省略则用启动时钉定的模型）
#   block.tools            本状态下拦截的工具名列表
#   block.bash_patterns    本状态下拦截的 bash 命令正则列表

initial: coding
no_progress_limit: 3

states:
  coding:
    prompt: prompts/coding.md
    transition: review
    records_commit_range: true
  review:
    prompt: prompts/review.md
    transition: coding
    consumes_commit_range: true
    expect_no_commit: true
    directive: |-
      ---
      ## 本轮模式（驱动程序注入）：review
      执行 review 轮流程。
      {% if from %}本轮审查 coding 轮产生的全部提交：区间 {{from}}..{{to}}，不得产生任何 commit。{% else %}本轮 coding 没有产生新提交。确认后回复"无新提交"即可，不要创建 issue，不得产生任何 commit。{% endif %}
    block:
      tools:
        - edit
        - write
      bash_patterns:
        - '(^|[;&|]\\s*|\\bgit\\s+)(commit\\b|reset\\b|revert\\b|merge\\b|rebase\\b|checkout\\s+--)'
        - 'git add'
`;

const DEFAULT_CODING_PROMPT = `你是 ralph loop 的单轮执行者，当前处于 coding 状态。只执行 coding 轮流程，不要向用户提问，自主完成本轮。轮次状态由驱动程序管理，禁止读写 .ralph/ 目录下任何文件。

cnb 仓库坐标在 .ralph/config.json 的 "repo" 字段（格式：组织/仓库）。

## coding 轮流程
1. 用 cnb CLI 查询待办：cnb issues list-issues --repo <repo> --labels ${TODO_LABEL} --state open --order-by created_at --page-size 100，取最早创建的一条。
2. 若没有任何待办 issue：直接回复 ${DONE_MARKER} 和一段完成情况总结，不做任何其他事（驱动程序会结束循环）。
3. 按 issue 需求编码，遵循仓库的 AGENTS.md / CLAUDE.md。只做 issue 描述范围内的事，不顺手改无关代码。
4. 运行测试直到通过；如仓库要求 npm run check 则必须通过。
5. commit：只 add 你改动的文件（禁止 git add -A / git add .），消息格式 fix|feat: ...（refs #<issue号>）。
6. 用 cnb issues post-issue-comment 在该 issue 下评论改动摘要与 commit hash。不要关闭 issue，关闭由 review 轮负责。

## 结束条件
- coding 轮发现待办为空 → 回复 ${DONE_MARKER}。
- 除此之外永远不要输出 ${DONE_MARKER}。`;

const DEFAULT_REVIEW_PROMPT = `你是 ralph loop 的单轮执行者，当前处于 review 状态。只执行 review 轮流程，不要向用户提问，自主完成本轮。轮次状态由驱动程序管理，禁止读写 .ralph/ 目录下任何文件。

cnb 仓库坐标在 .ralph/config.json 的 "repo" 字段（格式：组织/仓库）。

## review 轮流程
1. 审查范围由驱动程序注入的提交区间给出（from..to，覆盖 coding 轮产生的全部提交）：
   - git log --oneline from..to 列出全部提交，逐个查看；git diff from..to 查看整体改动。
   - 结合 code review skill 审查每一个提交。只审查区间内的提交。
   - 若注入显示本轮没有新提交区间：确认后回复"无新提交"即可，不要创建 issue，结束本轮。
2. 确定性问题（会导致构建或测试失败、逻辑错误、违反仓库明文规范）→ 每条用 cnb issues create-issue 创建 issue，加 label ${TODO_LABEL}，正文包含：文件与行号、问题描述、期望的修复方式。标题加 [review] 前缀。
3. 建议性问题（风格偏好、可选优化）→ 不建 issue，直接忽略。
4. 处理被审查的需求 issue（从区间内各 commit 消息中的 refs #N 收集全部 issue 编号）：
   - 无确定性问题 → 逐个用 cnb issues update-issue --state closed --state-reason completed 关闭，并评论审查结论。
   - 有确定性问题 → 同样全部关闭，但评论中注明剩余工作由新创建的 fix issue（#A、#B...）跟踪。
   - 解析不到 issue 编号 → 不关闭，在回复中说明。
5. review 轮绝对不能修改代码、不能产生任何 commit（驱动程序会强制拦截）。`;

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
}

function ralphPath(cwd: string, name: string): string {
	return join(cwd, RALPH_DIR, name);
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

	return { workflow: { initial, done_marker: doneMarker, no_progress_limit: noProgressLimit, states } };
}

/** Load and validate .ralph/workflow.yaml. */
function loadWorkflow(cwd: string): WorkflowResult {
	const path = ralphPath(cwd, WORKFLOW_FILE);
	if (!existsSync(path)) return { error: `${RALPH_DIR}/${WORKFLOW_FILE} 不存在（先运行 /ralph init）` };
	let raw: unknown;
	try {
		raw = parseYaml(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: `${RALPH_DIR}/${WORKFLOW_FILE} 解析失败: ${error instanceof Error ? error.message : String(error)}` };
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

/** Create .ralph/ with default files if missing. Returns notify messages. */
function initRalphFiles(cwd: string): Array<{ message: string; type: "info" | "warning" }> {
	mkdirSync(join(cwd, RALPH_DIR), { recursive: true });
	const messages: Array<{ message: string; type: "info" | "warning" }> = [];
	if (!existsSync(ralphPath(cwd, WORKFLOW_FILE))) {
		writeFileSync(ralphPath(cwd, WORKFLOW_FILE), DEFAULT_WORKFLOW_YAML);
	}
	if (!existsSync(ralphPath(cwd, "prompts/coding.md"))) {
		mkdirSync(join(cwd, RALPH_DIR, "prompts"), { recursive: true });
		writeFileSync(ralphPath(cwd, "prompts/coding.md"), DEFAULT_CODING_PROMPT);
	}
	if (!existsSync(ralphPath(cwd, "prompts/review.md"))) {
		mkdirSync(join(cwd, RALPH_DIR, "prompts"), { recursive: true });
		writeFileSync(ralphPath(cwd, "prompts/review.md"), DEFAULT_REVIEW_PROMPT);
	}
	if (!existsSync(ralphPath(cwd, "state.json"))) {
		// Start from the workflow's initial state when it already exists.
		const loaded = loadWorkflow(cwd);
		const initial = loaded.workflow?.initial ?? "coding";
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
			const { workflow } = loadWorkflow(ctx.cwd);
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
		const { workflow } = loadWorkflow(cwd);
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
		description: "Ralph loop: init/start/stop/status - repeat state prompts in fresh sessions until done",
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
				const workflow = loadWorkflow(cwd);
				ctx.ui.notify(
					[
						`ralph: ${driver.running ? "RUNNING" : "stopped"} · round ${driver.round}/${driver.maxRounds}`,
						workflow.workflow
							? `workflow: ${Object.entries(workflow.workflow.states)
								.map(([n, c]) => (c.model ? `${n}(${c.model.provider}/${c.model.modelId})` : n))
								.join(" -> ")} (initial: ${workflow.workflow.initial})`
							: `workflow: invalid - ${workflow.error}`,
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

			if (sub === "init") {
				for (const { message, type } of initRalphFiles(cwd)) {
					ctx.ui.notify(message, type);
				}
				ctx.ui.notify(`ralph: initialized .ralph/ (${WORKFLOW_FILE}, prompts/, state.json, config.json)`, "info");
				return;
			}

			if (sub !== "start") {
				ctx.ui.notify("Usage: /ralph init | /ralph start [maxRounds] | /ralph stop | /ralph status", "info");
				return;
			}

			// /ralph start
			const maxRounds = Math.min(Math.max(Number.parseInt(args.trim().split(/\s+/)[1] ?? "", 10) || DEFAULT_MAX_ROUNDS, 1), 200);

			const existing = readJson<RalphDriver>(ralphPath(cwd, "driver.json"));
			if (existing?.running) {
				ctx.ui.notify("ralph: already running (check /ralph status). If stale, run /ralph stop first.", "error");
				return;
			}

			for (const { message, type } of initRalphFiles(cwd)) {
				ctx.ui.notify(message, type);
			}

			const workflowResult = loadWorkflow(cwd);
			if (!workflowResult.workflow) {
				ctx.ui.notify(`ralph: ${workflowResult.error}`, "error");
				return;
			}
			const workflow = workflowResult.workflow;

			// Load and validate every state's prompt file up front.
			const prompts: Record<string, string> = {};
			for (const [name, config] of Object.entries(workflow.states)) {
				if (config.model && !ctx.modelRegistry.find(config.model.provider, config.model.modelId)) {
					ctx.ui.notify(`ralph: states.${name}.model 未找到: ${config.model.provider}/${config.model.modelId}`, "error");
					return;
				}
				const promptPath = ralphPath(cwd, config.prompt);
				if (!existsSync(promptPath)) {
					ctx.ui.notify(`ralph: states.${name}.prompt 文件不存在: ${RALPH_DIR}/${config.prompt}`, "error");
					return;
				}
				const prompt = readFileSync(promptPath, "utf8");
				if (!prompt.trim()) {
					ctx.ui.notify(`ralph: states.${name}.prompt 文件为空: ${RALPH_DIR}/${config.prompt}`, "error");
					return;
				}
				prompts[name] = prompt;
			}

			writeJson(ralphPath(cwd, "driver.json"), {
				running: true,
				round: 0,
				maxRounds,
				startedAt: new Date().toISOString(),
				model: ctx.model
					? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel }
					: undefined,
			} satisfies RalphDriver);

			ctx.ui.notify(`ralph: starting loop (max ${maxRounds} rounds, workflow: ${Object.keys(workflow.states).join(" -> ")})`, "info");
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
