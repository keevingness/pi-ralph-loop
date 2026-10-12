/**
 * Tests for the ralph-workflow-author skill's validator script.
 * Spawns scripts/validate-preset.mts against crafted presets and asserts
 * exit codes + messages. Run: node --experimental-strip-types test/validate-preset-test.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VALIDATOR = resolve("./skills/ralph-workflow-author/scripts/validate-preset.mts");

let passed = 0;
function ok(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`ok - ${name}`);
}

function run(dir: string): { status: number; out: string } {
	try {
		const out = execFileSync("node", ["--experimental-strip-types", VALIDATOR, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { status: 0, out };
	} catch (error: any) {
		return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
	}
}

/** Build a preset dir. `files` maps relative path -> content. */
function preset(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "ralph-val-"));
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

const wf = (body: string) => ({ "workflow.yaml": body, "prompts/main.md": "do the thing [RALPH:DONE]\n" });
const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

ok("valid 2-state cycle passes", () => {
	const dir = preset(
		wf(["initial: a", "states:", "  a:", "    prompt: prompts/main.md", "    transition: b", "  b:", "    prompt: prompts/main.md", "    transition: a"].join("\n") + "\n"),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /环: a -> b/);
	} finally {
		cleanup(dir);
	}
});

ok("missing prompt file fails", () => {
	const dir = preset(wf(["initial: a", "states:", "  a:", "    prompt: prompts/nope.md", "    transition: a"].join("\n") + "\n"));
	try {
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.match(r.out, /prompt 不存在/);
	} finally {
		cleanup(dir);
	}
});

ok("tail + sub-cycle is rejected", () => {
	// start -> a, a -> b, b -> a  (a/b sub-cycle never returns to start)
	const dir = preset(
		wf(
			[
				"initial: start",
				"states:",
				"  start:",
				"    prompt: prompts/main.md",
				"    transition: a",
				"  a:",
				"    prompt: prompts/main.md",
				"    transition: b",
				"  b:",
				"    prompt: prompts/main.md",
				"    transition: a",
			].join("\n") + "\n",
		),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.match(r.out, /流转不成环/);
	} finally {
		cleanup(dir);
	}
});

ok("unreachable state is rejected", () => {
	// initial a <-> b, but c <-> d is a separate island
	const dir = preset(
		wf(
			[
				"initial: a",
				"states:",
				"  a:",
				"    prompt: prompts/main.md",
				"    transition: b",
				"  b:",
				"    prompt: prompts/main.md",
				"    transition: a",
				"  c:",
				"    prompt: prompts/main.md",
				"    transition: d",
				"  d:",
				"    prompt: prompts/main.md",
				"    transition: c",
			].join("\n") + "\n",
		),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.match(r.out, /走不到的状态: c, d/);
	} finally {
		cleanup(dir);
	}
});

ok("consumes without records fails", () => {
	const dir = preset(
		wf(["initial: a", "states:", "  a:", "    prompt: prompts/main.md", "    transition: b", "    consumes_commit_range: true", "  b:", "    prompt: prompts/main.md", "    transition: a"].join("\n") + "\n"),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.match(r.out, /区间永远是空的/);
	} finally {
		cleanup(dir);
	}
});

ok("records without consumes warns but passes", () => {
	const dir = preset(
		wf(["initial: a", "states:", "  a:", "    prompt: prompts/main.md", "    transition: b", "    records_commit_range: true", "  b:", "    prompt: prompts/main.md", "    transition: a"].join("\n") + "\n"),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /没有状态消费它/);
	} finally {
		cleanup(dir);
	}
});

ok("expect_no_commit without block warns", () => {
	const dir = preset(
		wf(["initial: a", "states:", "  a:", "    prompt: prompts/main.md", "    transition: a", "    expect_no_commit: true"].join("\n") + "\n"),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /拦不住修改/);
	} finally {
		cleanup(dir);
	}
});

ok("missing done_marker in every prompt warns", () => {
	const dir = preset({
		"workflow.yaml": ["initial: a", "states:", "  a:", "    prompt: prompts/main.md", "    transition: a"].join("\n") + "\n",
		"prompts/main.md": "no marker here\n",
	});
	try {
		const r = run(dir);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /没有任何提示词包含 done_marker/);
	} finally {
		cleanup(dir);
	}
});

ok("first-lap consumer before any recorder warns", () => {
	// a consumes, b records: on lap 1, a runs before b has recorded anything
	const dir = preset(
		wf(
			[
				"initial: a",
				"states:",
				"  a:",
				"    prompt: prompts/main.md",
				"    transition: b",
				"    consumes_commit_range: true",
				"  b:",
				"    prompt: prompts/main.md",
				"    transition: a",
				"    records_commit_range: true",
			].join("\n") + "\n",
		),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /首轮会拿到空区间/);
	} finally {
		cleanup(dir);
	}
});

ok("malformed yaml fails", () => {
	const dir = preset({ "workflow.yaml": "states: {}\n" });
	try {
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.match(r.out, /不能为空|错误/);
	} finally {
		cleanup(dir);
	}
});

ok("transition to an undefined state fails", () => {
	const dir = preset(wf(["initial: a", "states:", "  a:", "    prompt: prompts/main.md", "    transition: ghost"].join("\n") + "\n"));
	try {
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.match(r.out, /指向未定义状态/);
	} finally {
		cleanup(dir);
	}
});

ok("invalid block regex fails", () => {
	const dir = preset(
		wf(["initial: a", "states:", "  a:", "    prompt: prompts/main.md", "    transition: a", "    block:", "      bash_patterns:", "        - '('"].join("\n") + "\n"),
	);
	try {
		const r = run(dir);
		assert.equal(r.status, 1);
		assert.match(r.out, /无效正则/);
	} finally {
		cleanup(dir);
	}
});

ok("the shipped builtin preset passes cleanly", () => {
	const r = run(resolve("./workflows/coding-review"));
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /✓ 通过/);
});

console.log(`\n${passed} validator tests passed`);
