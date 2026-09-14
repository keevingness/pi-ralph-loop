/**
 * Offline tests for the ralph-loop extension's pure logic:
 * workflow validation, directive building, init file generation.
 * Run: node --experimental-strip-types test.mts (from the extension dir)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateWorkflow, buildDirective, DEFAULT_WORKFLOW_YAML } from "../extensions/ralph-loop.ts";

let passed = 0;
function ok(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`ok - ${name}`);
}

// --- validateWorkflow ---

function defaultWorkflowYaml(): string {
	return DEFAULT_WORKFLOW_YAML;
}

ok("default workflow yaml parses and validates", () => {
	const raw = parseYaml(defaultWorkflowYaml());
	const result = validateWorkflow(raw);
	assert.ok(result.workflow, result.error);
	assert.equal(result.workflow.initial, "coding");
	assert.equal(result.workflow.no_progress_limit, 3);
	assert.equal(result.workflow.done_marker, "[RALPH:DONE]");
	assert.deepEqual(Object.keys(result.workflow.states), ["coding", "review"]);
	assert.equal(result.workflow.states.coding.transition, "review");
	assert.equal(result.workflow.states.review.transition, "coding");
	assert.equal(result.workflow.states.coding.records_commit_range, true);
	assert.equal(result.workflow.states.review.consumes_commit_range, true);
	assert.equal(result.workflow.states.review.expect_no_commit, true);
	assert.deepEqual(result.workflow.states.review.block, {
		tools: ["edit", "write"],
		bash_patterns: ["(^|[;&|]\\s*|\\bgit\\s+)(commit\\b|reset\\b|revert\\b|merge\\b|rebase\\b|checkout\\s+--)", "git add"],
	});
});

ok("rejects unknown transition target", () => {
	const result = validateWorkflow({ initial: "a", states: { a: { prompt: "p.md", transition: "nope" } } });
	assert.ok(result.error?.includes("指向未定义状态"));
});

ok("rejects missing initial", () => {
	const result = validateWorkflow({ states: { a: { prompt: "p.md", transition: "a" } } });
	assert.ok(result.error?.includes("initial"));
});

ok("rejects empty states", () => {
	const result = validateWorkflow({ initial: "a", states: {} });
	assert.ok(result.error?.includes("不能为空"));
});

ok("rejects missing prompt", () => {
	const result = validateWorkflow({ initial: "a", states: { a: { transition: "a" } } });
	assert.ok(result.error?.includes("prompt"));
});

ok("rejects invalid no_progress_limit", () => {
	const result = validateWorkflow({ initial: "a", no_progress_limit: 0, states: { a: { prompt: "p.md", transition: "a" } } });
	assert.ok(result.error?.includes("no_progress_limit"));
});

ok("rejects invalid bash regex", () => {
	const result = validateWorkflow({
		initial: "a",
		states: { a: { prompt: "p.md", transition: "a", block: { bash_patterns: ["("] } } },
	});
	assert.ok(result.error?.includes("无效正则"));
});

ok("parses per-state model as provider/modelId", () => {
	const result = validateWorkflow({
		initial: "a",
		states: { a: { prompt: "p.md", transition: "a", model: "newapi/glm-5.3" } },
	});
	assert.ok(result.workflow, result.error);
	assert.deepEqual(result.workflow.states.a.model, { provider: "newapi", modelId: "glm-5.3" });
});

ok("model id may contain slashes", () => {
	const result = validateWorkflow({
		initial: "a",
		states: { a: { prompt: "p.md", transition: "a", model: "openrouter/deepseek/deepseek-chat" } },
	});
	assert.ok(result.workflow, result.error);
	assert.deepEqual(result.workflow.states.a.model, { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
});

ok("rejects model without provider", () => {
	const result = validateWorkflow({ initial: "a", states: { a: { prompt: "p.md", transition: "a", model: "justamodel" } } });
	assert.ok(result.error?.includes("model"));
});

ok("rejects non-string model", () => {
	const result = validateWorkflow({ initial: "a", states: { a: { prompt: "p.md", transition: "a", model: 42 } } });
	assert.ok(result.error?.includes("model"));
});

ok("accepts 3-state cycle", () => {
	const result = validateWorkflow({
		initial: "coding",
		states: {
			coding: { prompt: "prompts/coding.md", transition: "review" },
			review: { prompt: "prompts/review.md", transition: "refactor", expect_no_commit: true },
			refactor: { prompt: "prompts/refactor.md", transition: "coding", records_commit_range: true },
		},
	});
	assert.ok(result.workflow, result.error);
	assert.equal(result.workflow.states.review.transition, "refactor");
});

ok("defaults no_progress_limit and done_marker", () => {
	const result = validateWorkflow({ initial: "a", states: { a: { prompt: "p.md", transition: "a" } } });
	assert.ok(result.workflow);
	assert.equal(result.workflow.no_progress_limit, 3);
	assert.equal(result.workflow.done_marker, "[RALPH:DONE]");
});

// --- buildDirective ---

const wf = validateWorkflow({
	initial: "a",
	done_marker: "[X]",
	states: {
		a: { prompt: "a.md", transition: "b" },
		b: { prompt: "b.md", transition: "a", consumes_commit_range: true, expect_no_commit: true },
		c: {
			prompt: "c.md",
			transition: "a",
			consumes_commit_range: true,
			directive: "state={{state}} range={% if from %}{{from}}..{{to}}{% else %}none{% endif %}",
		},
	},
}).workflow!;

ok("default directive: plain state", () => {
	const d = buildDirective(wf, { state: "a" });
	assert.equal(d, "---\n\n## 本轮模式（驱动程序注入）：a");
});

ok("default directive: consumes range + expect_no_commit", () => {
	const d = buildDirective(wf, { state: "b", from: "aaa", to: "bbb" });
	assert.equal(d, "---\n\n## 本轮模式（驱动程序注入）：b\n提交区间：aaa..bbb\n本轮不得产生任何 commit。");
});

ok("default directive: consuming state without range", () => {
	const d = buildDirective(wf, { state: "b" });
	assert.equal(d, "---\n\n## 本轮模式（驱动程序注入）：b\n本轮没有新提交区间。\n本轮不得产生任何 commit。");
});

ok("default directive: from===to counts as no range", () => {
	const d = buildDirective(wf, { state: "b", from: "same", to: "same" });
	assert.ok(d.includes("本轮没有新提交区间"));
});

ok("custom directive with if/else and placeholders", () => {
	const withRange = buildDirective(wf, { state: "c", from: "f1", to: "t1" });
	assert.equal(withRange, "state=c range=f1..t1");
	const noRange = buildDirective(wf, { state: "c" });
	assert.equal(noRange, "state=c range=none");
});

// --- initRalphFiles (via /ralph init equivalent, tested through file effects) ---

ok("generated default workflow yaml validates", () => {
	const result = validateWorkflow(parseYaml(defaultWorkflowYaml()));
	assert.ok(result.workflow, result.error);
});

console.log(`\n${passed} tests passed`);
