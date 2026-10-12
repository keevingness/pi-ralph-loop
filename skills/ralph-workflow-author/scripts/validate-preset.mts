#!/usr/bin/env node
/**
 * 校验一个 ralph-loop 预设，在 /ralph start 之前发现问题。
 *
 *   node --experimental-strip-types <本 skill 目录>/scripts/validate-preset.mts <name|dir> [--cwd <项目>]
 *
 * <name> 走预设分层查找（builtin < global < project）；<dir> 直接当作预设目录。
 * 退出码：0 = 通过（可能有警告）；1 = 有错误。
 *
 * 权威性：结构校验直接调用扩展导出的 validateWorkflow，与 /ralph start 完全一致。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = "用法: validate-preset.mts <name|dir> [--cwd <项目>]";
const selfPath = fileURLToPath(import.meta.url);

// --- 定位 pi-ralph-loop 包 -----------------------------------------------------
// 本 skill 可能被复制到别处（如 `npx skills add` 装进 .agents/skills/），此时脚本旁边
// 没有扩展代码，也没有 yaml 依赖。按 环境变量 -> 脚本所在目录向上 -> 当前目录向上 找。

function findPackageRoot(): string | undefined {
	const configured = process.env.PI_RALPH_LOOP_DIR;
	if (configured && existsSync(join(configured, "extensions/ralph-loop.ts"))) return resolve(configured);
	for (const start of [dirname(selfPath), process.cwd()]) {
		for (let dir = resolve(start); ; dir = dirname(dir)) {
			if (existsSync(join(dir, "extensions/ralph-loop.ts"))) return dir;
			if (dirname(dir) === dir) break;
		}
	}
	return undefined;
}

const packageRoot = findPackageRoot();
if (!packageRoot) {
	console.error("错误: 找不到 pi-ralph-loop 包（校验需要它的 extensions/ralph-loop.ts 与 yaml 依赖）");
	console.error("修复: 安装/克隆该包，或用 PI_RALPH_LOOP_DIR 指定包目录，例如:");
	console.error(`  PI_RALPH_LOOP_DIR=~/.pi/agent/git/gitee.com/keeving/pi-ralph-loop node --experimental-strip-types ${selfPath} <name|dir>`);
	process.exit(1);
}

let parseYaml: (text: string) => unknown;
let findPresets: typeof import("../../../extensions/ralph-loop.ts").findPresets;
let validateWorkflow: typeof import("../../../extensions/ralph-loop.ts").validateWorkflow;
try {
	parseYaml = (createRequire(join(packageRoot, "package.json"))("yaml") as { parse: (text: string) => unknown }).parse;
	const mod = (await import(pathToFileURL(join(packageRoot, "extensions/ralph-loop.ts")).href)) as typeof import("../../../extensions/ralph-loop.ts");
	if (typeof mod.findPresets !== "function" || typeof mod.validateWorkflow !== "function") {
		throw new Error("扩展里没有 findPresets/validateWorkflow 导出（包太旧？）");
	}
	findPresets = mod.findPresets;
	validateWorkflow = mod.validateWorkflow;
} catch (error) {
	console.error(`错误: 无法从 ${packageRoot} 加载校验依赖: ${error instanceof Error ? error.message : String(error)}`);
	console.error(`修复: 在 ${packageRoot} 运行 npm install，并确保该包是最新版（git pull）`);
	process.exit(1);
}

const argv = process.argv.slice(2);
const cwdIndex = argv.indexOf("--cwd");
let cwd = process.cwd();
if (cwdIndex >= 0) {
	const value = argv[cwdIndex + 1];
	if (!value) {
		console.error(`--cwd 需要一个路径\n${USAGE}`);
		process.exit(1);
	}
	cwd = resolve(value);
	argv.splice(cwdIndex, 2);
}

const target = argv[0];
if (!target) {
	console.error(USAGE);
	process.exit(1);
}

const errors: string[] = [];
const warnings: string[] = [];

// --- 定位预设目录 -------------------------------------------------------------

let dir: string | undefined;
let origin: string | undefined;
if (existsSync(target)) {
	const stat = statSync(target);
	if (stat.isDirectory()) dir = resolve(target);
	else if (target.endsWith("workflow.yaml")) dir = dirname(resolve(target));
}
if (!dir) {
	const hit = findPresets(cwd).find((preset) => preset.name === target);
	if (hit) {
		dir = hit.dir;
		origin = hit.origin;
	}
}
if (!dir) {
	const available = findPresets(cwd).map((preset) => preset.name);
	console.error(`错误: 找不到预设 "${target}"（也不是已存在的目录）`);
	console.error(`可用预设: ${available.join(", ") || "(无)"}`);
	process.exit(1);
}

console.log(`预设: ${dir}${origin ? `  [${origin}]` : ""}`);

// --- 结构校验（与 /ralph start 同一份逻辑） ------------------------------------

const workflowPath = join(dir, "workflow.yaml");
if (!existsSync(workflowPath)) {
	console.error(`错误: 缺少 workflow.yaml: ${workflowPath}`);
	process.exit(1);
}

let raw: unknown;
try {
	raw = parseYaml(readFileSync(workflowPath, "utf8"));
} catch (error) {
	console.error(`错误: workflow.yaml 解析失败: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

const result = validateWorkflow(raw);
if (!result.workflow) {
	console.error(`错误: ${result.error}`);
	process.exit(1);
}
const workflow = result.workflow;
const states = workflow.states;
const names = Object.keys(states);
const config = (name: string) => states[name];

// --- 提示词文件 ---------------------------------------------------------------

const promptTexts: string[] = [];
for (const name of names) {
	const path = join(dir, config(name).prompt);
	if (!existsSync(path)) {
		errors.push(`states.${name}.prompt 不存在: ${path}`);
		continue;
	}
	const text = readFileSync(path, "utf8");
	if (!text.trim()) errors.push(`states.${name}.prompt 为空: ${path}`);
	promptTexts.push(text);
}

// --- 单环：从 initial 出发必须走遍全部状态并回到 initial -----------------------

const path: string[] = [];
const seen = new Set<string>();
let current = workflow.initial;
while (!seen.has(current)) {
	seen.add(current);
	path.push(current);
	current = config(current).transition;
}
const loopStart = path.indexOf(current);
if (loopStart !== 0) {
	errors.push(
		`流转不成环: 从 initial "${workflow.initial}" 先经过 ${path.slice(0, loopStart).join(" -> ")}，` +
			`然后陷入 ${path.slice(loopStart).join(" -> ")} 的子环。每个状态只有一条出边，` +
			`这种"尾巴 + 子环"结构会让前一段只跑一次。`,
	);
}
const unreachable = names.filter((name) => !seen.has(name));
if (unreachable.length) {
	errors.push(`走不到的状态: ${unreachable.join(", ")}（从 initial 沿 transition 无法到达）`);
}

// --- 提交区间的配对与顺序 -----------------------------------------------------

const recorders = names.filter((name) => config(name).records_commit_range);
const consumers = names.filter((name) => config(name).consumes_commit_range);
if (consumers.length && recorders.length === 0) {
	errors.push(`有状态配置了 consumes_commit_range（${consumers.join(", ")}）但没有任何 records_commit_range，注入的区间永远是空的`);
}
if (recorders.length && consumers.length === 0) {
	warnings.push(`有状态配置了 records_commit_range（${recorders.join(", ")}）但没有状态消费它`);
}
let recorderSeen = false;
for (const name of path) {
	if (config(name).consumes_commit_range && !recorderSeen) {
		warnings.push(`首轮会拿到空区间: "${name}" 消费区间，但在环上它之前还没有 records_commit_range 的状态`);
	}
	if (config(name).records_commit_range) recorderSeen = true;
}

// --- 只读状态是否真的拦得住 ---------------------------------------------------

for (const name of names) {
	if (!config(name).expect_no_commit) continue;
	const block = config(name).block;
	const hard = Boolean(block?.tools?.length || block?.bash_patterns?.length);
	if (!hard) {
		warnings.push(`"${name}" 配了 expect_no_commit 但没有 block: 只能事后告警，拦不住修改`);
	}
}

// --- 循环是否能由 done_marker 结束 -------------------------------------------

const doneMarker = workflow.done_marker;
if (promptTexts.length && !promptTexts.some((text) => text.includes(doneMarker))) {
	warnings.push(`没有任何提示词包含 done_marker "${doneMarker}": 循环只能靠 maxRounds / /ralph stop / 无进展熔断结束`);
}

// --- 报告 ---------------------------------------------------------------------

console.log(`环: ${path.join(" -> ")} -> (回到 ${path[0]})`);
console.log(`状态: ${names.length} · 熔断阈值: ${workflow.no_progress_limit} 轮 · done_marker: ${doneMarker}`);
console.log("");

for (const warning of warnings) console.log(`警告: ${warning}`);
for (const error of errors) console.error(`错误: ${error}`);

if (errors.length) {
	console.error(`\n✗ 未通过（${errors.length} 个错误，${warnings.length} 个警告）`);
	process.exit(1);
}
console.log(`✓ 通过${warnings.length ? `（${warnings.length} 个警告）` : ""} — 可以 /ralph start ${origin ? target : `<name>`}`);
