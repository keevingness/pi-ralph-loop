import { readFileSync } from "node:fs";
import { validateWorkflow } from "../extensions/ralph-loop.ts";
import { parse as parseYaml } from "yaml";
import assert from "node:assert/strict";

const yaml = readFileSync(new URL("../workflows/coding-review/workflow.yaml", import.meta.url), "utf8");
const wf = validateWorkflow(parseYaml(yaml)).workflow!;
const patterns = wf.states.review.block!.bash_patterns!;
const cases: Array<[string, boolean]> = [
	["git commit -m x", true],
	["git commit --allow-empty", true],
	["echo hi && git commit -m x", true],
	["git reset --hard HEAD~1", true],
	["git revert abc", true],
	["git merge foo", true],
	["git rebase main", true],
	["git checkout -- file.ts", true],
	["git add -A", true],
	["git add src/foo.ts", true],
	["git status", false],
	["git log --oneline a..b", false],
	["git diff abc def", false],
	["echo git commit", true], // pre-existing false positive in the original regex, kept
	["ls && echo done", false],
];
for (const [cmd, shouldBlock] of cases) {
	const blocked = patterns.some((p) => new RegExp(p).test(cmd));
	assert.equal(blocked, shouldBlock, cmd);
	console.log(`ok - ${shouldBlock ? "blocked" : "allowed"}: ${cmd}`);
}
console.log("regex tests passed");
