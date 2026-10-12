/**
 * Integration tests for preset workflows: drive the REAL command handler and the
 * tool_call / session_start hooks with a fake pi + ctx, against real temp dirs.
 * Run: node --experimental-strip-types test/preset-test.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../extensions/ralph-loop.ts";

let passed = 0;
async function ok(name: string, fn: () => void | Promise<void>) {
	await fn();
	passed++;
	console.log(`ok - ${name}`);
}

// --- harness -----------------------------------------------------------------

interface Harness {
	cwd: string;
	run: (args: string) => Promise<{ notes: string[]; errors: string[] }>;
	handler: any;
	toolCall: any;
	sessionStart: any;
	setModelCalls: Array<{ provider: string; modelId: string }>;
	dispose: () => void;
}

function makeRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-it-"));
	execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], {
		cwd,
		stdio: "ignore",
	});
	execFileSync("git", ["remote", "add", "origin", "https://cnb.cool/acme/demo.git"], { cwd, stdio: "ignore" });
	return cwd;
}

/** Write a minimal valid preset dir at `root/<name>/` and return its dir. */
function writePreset(root: string, name: string, original: { initial?: string; description?: string; prompt?: string } = {}): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "prompts"), { recursive: true });
	const initial = original.initial ?? "work";
	const next = initial === "work" ? "check" : "work";
	writeFileSync(
		join(dir, "workflow.yaml"),
		[
			`initial: ${initial}`,
			original.description ? `description: ${original.description}` : "",
			"states:",
			`  ${initial}:`,
			"    prompt: prompts/main.md",
			`    transition: ${next}`,
			`  ${next}:`,
			"    prompt: prompts/main.md",
			`    transition: ${initial}`,
		]
			.filter(Boolean)
			.join("\n") + "\n",
	);
	writeFileSync(join(dir, "prompts", "main.md"), original.prompt ?? `PROMPT:${name}:${initial}`);
	return dir;
}

function harness(opts: { doneMarker?: string; branch?: "done" | "plain"; model?: { provider: string; id: string } } = {}): Harness {
	const cwd = makeRepo();
	const globalRoot = mkdtempSync(join(tmpdir(), "ralph-global-"));
	process.env.PI_CODING_AGENT_DIR = globalRoot;

	const captured: any = {};
	const setModelCalls: Array<{ provider: string; modelId: string }> = [];
	const pi: any = {
		on: (event: string, fn: any) => { captured[event] = fn; },
		registerCommand: (_n: string, def: any) => { captured.command = def; },
		setModel: async (model: any) => { setModelCalls.push({ provider: model.provider, modelId: model.id }); },
		setThinkingLevel: () => {},
	};
	register(pi);

	const sentPrompts: string[] = [];
	const makeCtx = () => {
		const notes: string[] = [];
		const errors: string[] = [];
		const ctx: any = {
			cwd,
			hasUI: false,
			model: opts.model,
			thinkingLevel: undefined,
			modelRegistry: { find: (p: string, m: string) => (opts.model && opts.model.provider === p && opts.model.id === m ? opts.model : undefined) },
			ui: {
				notify: (message: string, type?: string) => { notes.push(message); if (type === "error") errors.push(message); },
				setWidget: () => {},
			},
		};
		const freshCtx: any = {
			...ctx,
			sendUserMessage: async (text: string) => { sentPrompts.push(text); },
			waitForIdle: async () => {},
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "assistant", content: opts.branch === "plain" ? "did work" : (opts.doneMarker ?? "[RALPH:DONE]") } },
				],
			},
			newSession: async (o: any) => { await o.withSession(freshCtx); return { cancelled: false }; },
		};
		ctx.newSession = async (o: any) => { await o.withSession(freshCtx); return { cancelled: false }; };
		ctx.notes = notes;
		ctx.errors = errors;
		ctx.sentPrompts = sentPrompts;
		return ctx;
	};

	// One shared ctx per run() call, so we can read its notes afterwards.
	const runs: Array<{ notes: string[]; errors: string[] }> = [];
	return {
		cwd,
		handler: captured.command,
		toolCall: captured.tool_call,
		sessionStart: captured.session_start,
		setModelCalls,
		async run(args: string) {
			const ctx = makeCtx();
			await captured.command.handler(args, ctx);
			const rec = { notes: ctx.notes, errors: ctx.errors };
			runs.push(rec);
			return rec;
		},
		dispose() {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(globalRoot, { recursive: true, force: true });
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...({ sentPrompts } as any),
	} as Harness & { sentPrompts: string[] };
}

// --- tests -------------------------------------------------------------------

// 1. /ralph init scaffolds from the builtin preset and is non-destructive
await ok("/ralph init scaffolds .ralph/ from the builtin preset", async () => {
	const h = harness();
	try {
		const r1 = await h.run("init");
		assert.ok(r1.errors.length === 0, r1.errors.join("|"));
		for (const f of ["workflow.yaml", "prompts/coding.md", "prompts/review.md", "state.json", "config.json"]) {
			assert.ok(existsSync(join(h.cwd, ".ralph", f)), `missing ${f}`);
		}
		// A user edit must survive a second init.
		writeFileSync(join(h.cwd, ".ralph", "prompts", "coding.md"), "MINE");
		await h.run("init");
		assert.equal(readFileSync(join(h.cwd, ".ralph", "prompts", "coding.md"), "utf8"), "MINE");
	} finally {
		h.dispose();
	}
});

// 2. /ralph presets lists origin + description across all three layers
await ok("/ralph presets lists builtin/global/project with descriptions", async () => {
	const h = harness();
	try {
		const globalRoot = join(process.env.PI_CODING_AGENT_DIR!, "ralph", "workflows");
		writePreset(globalRoot, "from-global", { description: "global one" });
		writePreset(join(h.cwd, ".ralph", "workflows"), "from-project", { description: "project one" });
		const r = await h.run("presets");
		const out = r.notes.join("\n");
		assert.match(out, /coding-review \[builtin\]/);
		assert.match(out, /from-global \[global\] - global one/);
		assert.match(out, /from-project \[project\] - project one/);
	} finally {
		h.dispose();
	}
});

// 3. project preset overrides a same-named global/builtin one
await ok("project layer overrides builtin with the same name", async () => {
	const h = harness();
	try {
		writePreset(join(h.cwd, ".ralph", "workflows"), "coding-review", { description: "project override" });
		const r = await h.run("presets");
		assert.match(r.notes.join("\n"), /coding-review \[project\] - project override/);
	} finally {
		h.dispose();
	}
});

// 4. start a builtin preset: read-only preset dir, no .ralph/workflow.yaml scaffold
await ok("/ralph start <builtin> uses the preset in place, does not scaffold .ralph/workflow.yaml", async () => {
	const h = harness();
	try {
		const r = await h.run("start coding-review");
		assert.ok(r.errors.length === 0, r.errors.join("|"));
		const driver = JSON.parse(readFileSync(join(h.cwd, ".ralph", "driver.json"), "utf8"));
		assert.ok(driver.workflowDir.endsWith(join("workflows", "coding-review")), driver.workflowDir);
		assert.equal(driver.running, false, "loop should finish on done marker");
		assert.ok(!existsSync(join(h.cwd, ".ralph", "workflow.yaml")), "must not scaffold plain workflow.yaml");
		assert.ok(r.notes.some((n) => n.includes("preset: coding-review")));
	} finally {
		h.dispose();
	}
});

// 5. a project preset's prompt content (not the builtin's) is what gets sent
await ok("/ralph start <project preset> sends that preset's prompt", async () => {
	const h = harness();
	try {
		writePreset(join(h.cwd, ".ralph", "workflows"), "mine", { prompt: "CUSTOM-PROMPT-BODY" });
		const r = await h.run("start mine");
		assert.ok(r.errors.length === 0, r.errors.join("|"));
		const sent = (h as any).sentPrompts as string[];
		assert.equal(sent.length, 1);
		assert.ok(sent[0].startsWith("CUSTOM-PROMPT-BODY"), sent[0]);
		assert.ok(sent[0].includes("## 本轮模式（驱动程序注入）：work"), sent[0]);
	} finally {
		h.dispose();
	}
});

// 6. plain mode (/ralph start) still scaffolds .ralph/workflow.yaml
await ok("/ralph start (plain) scaffolds .ralph/workflow.yaml", async () => {
	const h = harness();
	try {
		const r = await h.run("start");
		assert.ok(r.errors.length === 0, r.errors.join("|"));
		assert.ok(existsSync(join(h.cwd, ".ralph", "workflow.yaml")));
		assert.ok(existsSync(join(h.cwd, ".ralph", "prompts", "coding.md")));
		const driver = JSON.parse(readFileSync(join(h.cwd, ".ralph", "driver.json"), "utf8"));
		assert.equal(driver.workflowDir, join(h.cwd, ".ralph"));
	} finally {
		h.dispose();
	}
});

// 7. numeric first arg keeps the legacy maxRounds form
await ok("/ralph start 5 keeps legacy maxRounds", async () => {
	const h = harness();
	try {
		await h.run("start 5");
		const driver = JSON.parse(readFileSync(join(h.cwd, ".ralph", "driver.json"), "utf8"));
		assert.equal(driver.maxRounds, 5);
		assert.equal(driver.workflowDir, join(h.cwd, ".ralph"));
	} finally {
		h.dispose();
	}
});

// 8. /ralph start <preset> <rounds>
await ok("/ralph start <preset> <rounds> parses both", async () => {
	const h = harness();
	try {
		await h.run("start coding-review 7");
		const driver = JSON.parse(readFileSync(join(h.cwd, ".ralph", "driver.json"), "utf8"));
		assert.equal(driver.maxRounds, 7);
		assert.ok(driver.workflowDir.endsWith(join("workflows", "coding-review")));
	} finally {
		h.dispose();
	}
});

// 9. unknown preset / illegal name are rejected without side effects
await ok("unknown preset is rejected, nothing written", async () => {
	const h = harness();
	try {
		const r = await h.run("start nope");
		assert.ok(r.errors.some((e) => e.includes("未找到")), r.errors.join("|"));
		assert.ok(!existsSync(join(h.cwd, ".ralph", "driver.json")));
	} finally {
		h.dispose();
	}
});

await ok("illegal preset name (path traversal) is rejected", async () => {
	const h = harness();
	try {
		const r = await h.run("start ../../etc");
		assert.ok(r.errors.length > 0, "expected an error");
		assert.ok(!existsSync(join(h.cwd, ".ralph", "driver.json")));
	} finally {
		h.dispose();
	}
});

// 10. broken preset: missing prompt file -> error before starting
await ok("preset with a missing prompt file fails fast", async () => {
	const h = harness();
	try {
		const dir = writePreset(join(h.cwd, ".ralph", "workflows"), "broken");
		rmSync(join(dir, "prompts", "main.md"));
		const r = await h.run("start broken");
		assert.ok(r.errors.some((e) => e.includes("prompt 文件不存在")), r.errors.join("|"));
		assert.ok(!existsSync(join(h.cwd, ".ralph", "driver.json")));
	} finally {
		h.dispose();
	}
});

await ok("preset with malformed workflow.yaml fails fast", async () => {
	const h = harness();
	try {
		const dir = writePreset(join(h.cwd, ".ralph", "workflows"), "bad-yaml");
		writeFileSync(join(dir, "workflow.yaml"), "states: {}\n");
		const r = await h.run("start bad-yaml");
		assert.ok(r.errors.length > 0, r.errors.join("|"));
		assert.ok(!existsSync(join(h.cwd, ".ralph", "driver.json")));
	} finally {
		h.dispose();
	}
});

// 10b. a failed start must not mutate state.json (validation happens before any write)
await ok("failed start leaves state.json untouched", async () => {
	const h = harness();
	try {
		const dir = writePreset(join(h.cwd, ".ralph", "workflows"), "broken2");
		rmSync(join(dir, "prompts", "main.md"));
		mkdirSync(join(h.cwd, ".ralph"), { recursive: true });
		writeFileSync(join(h.cwd, ".ralph", "state.json"), JSON.stringify({ state: "keepme", done: false }));
		const r = await h.run("start broken2");
		assert.ok(r.errors.some((e) => e.includes("prompt 文件不存在")), r.errors.join("|"));
		const state = JSON.parse(readFileSync(join(h.cwd, ".ralph", "state.json"), "utf8"));
		assert.equal(state.state, "keepme", "state must not be reset on a failed start");
		assert.ok(!existsSync(join(h.cwd, ".ralph", "driver.json")));
	} finally {
		h.dispose();
	}
});

// 11. stale state from another workflow is reset to the new initial
await ok("state left over from another workflow is reset", async () => {
	const h = harness();
	try {
		mkdirSync(join(h.cwd, ".ralph"), { recursive: true });
		writeFileSync(join(h.cwd, ".ralph", "state.json"), JSON.stringify({ state: "ghost", done: false }));
		const r = await h.run("start coding-review");
		assert.ok(r.notes.some((n) => n.includes("不属于该 workflow")), r.notes.join("|"));
		const state = JSON.parse(readFileSync(join(h.cwd, ".ralph", "state.json"), "utf8"));
		assert.equal(state.state, "coding");
	} finally {
		h.dispose();
	}
});

// 12. tool_call enforcement resolves the pinned preset's block config
await ok("tool_call enforcement uses the pinned preset's block rules", async () => {
	const h = harness();
	try {
		const dir = writePreset(join(h.cwd, ".ralph", "workflows"), "locked");
		writeFileSync(
			join(dir, "workflow.yaml"),
			[
				"initial: work",
				"states:",
				"  work:",
				"    prompt: prompts/main.md",
				"    transition: work",
				"    block:",
				"      tools: [edit, write]",
				"      bash_patterns: ['git commit']",
			].join("\n") + "\n",
		);
		mkdirSync(join(h.cwd, ".ralph"), { recursive: true });
		writeFileSync(join(h.cwd, ".ralph", "driver.json"), JSON.stringify({ running: true, round: 1, maxRounds: 3, startedAt: "", workflowDir: dir }));
		writeFileSync(join(h.cwd, ".ralph", "state.json"), JSON.stringify({ state: "work", done: false }));

		const blocked = h.toolCall({ toolName: "edit", input: {} }, { cwd: h.cwd });
		assert.ok(blocked?.block === true, "edit should be blocked");
		const blockedBash = h.toolCall({ toolName: "bash", input: { command: "git commit -m x" } }, { cwd: h.cwd });
		assert.ok(blockedBash?.block === true, "git commit should be blocked");
		const allowed = h.toolCall({ toolName: "read", input: {} }, { cwd: h.cwd });
		assert.ok(!allowed, "read should be allowed");
	} finally {
		h.dispose();
	}
});

// 13. session_start pins the state-specific model from the preset
await ok("session_start honors a preset state's model", async () => {
	const h = harness();
	try {
		const dir = writePreset(join(h.cwd, ".ralph", "workflows"), "modeled");
		writeFileSync(
			join(dir, "workflow.yaml"),
			[
				"initial: work",
				"states:",
				"  work:",
				"    prompt: prompts/main.md",
				"    transition: work",
				"    model: acme/thinking-1",
			].join("\n") + "\n",
		);
		mkdirSync(join(h.cwd, ".ralph"), { recursive: true });
		writeFileSync(join(h.cwd, ".ralph", "driver.json"), JSON.stringify({ running: true, round: 1, maxRounds: 3, startedAt: "", workflowDir: dir }));
		writeFileSync(join(h.cwd, ".ralph", "state.json"), JSON.stringify({ state: "work", done: false }));

		const h2 = harness({ model: { provider: "acme", id: "thinking-1" } });
		try {
			// reuse h2's registry (has acme/thinking-1); point it at h's files
			mkdirSync(join(h2.cwd, ".ralph"), { recursive: true });
			writeFileSync(join(h2.cwd, ".ralph", "driver.json"), JSON.stringify({ running: true, round: 1, maxRounds: 3, startedAt: "", workflowDir: dir }));
			writeFileSync(join(h2.cwd, ".ralph", "state.json"), JSON.stringify({ state: "work", done: false }));
			await h2.sessionStart({}, { cwd: h2.cwd, model: undefined, modelRegistry: { find: (p: string, m: string) => (p === "acme" && m === "thinking-1" ? { provider: "acme", id: "thinking-1" } : undefined) }, ui: { notify: () => {} } });
			assert.deepEqual(h2.setModelCalls, [{ provider: "acme", modelId: "thinking-1" }]);
		} finally {
			h2.dispose();
		}
	} finally {
		h.dispose();
	}
});

// 14. status reports the active preset name
await ok("/ralph status reports the active preset", async () => {
	const h = harness();
	try {
		writePreset(join(h.cwd, ".ralph", "workflows"), "mine");
		mkdirSync(join(h.cwd, ".ralph"), { recursive: true });
		writeFileSync(join(h.cwd, ".ralph", "driver.json"), JSON.stringify({ running: false, round: 2, maxRounds: 5, startedAt: "", workflowDir: join(h.cwd, ".ralph", "workflows", "mine") }));
		const r = await h.run("status");
		assert.ok(r.notes.join("\n").includes("preset: mine"), r.notes.join("|"));
	} finally {
		h.dispose();
	}
});

// 15. usage text mentions presets
await ok("unknown subcommand prints the updated usage", async () => {
	const h = harness();
	try {
		const r = await h.run("bogus");
		assert.match(r.notes.join("\n"), /\/ralph presets/);
	} finally {
		h.dispose();
	}
});

console.log(`\n${passed} preset integration tests passed`);
