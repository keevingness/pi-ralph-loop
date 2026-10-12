---
name: ralph-workflow-author
description: 编写或修改 ralph-loop 预制工作流（preset）——`.ralph/workflows/<name>/` 目录，内含 `workflow.yaml` 与每个状态一份提示词文件。当用户想创建 ralph loop、设计 ralph 工作流、增删状态或调整流转、编写各轮提示词、问怎么做一个能被 `/ralph start <name>` 运行的预设、或需要在内置/全局/项目三种预设层之间选择时使用。也用于校验已有预设（缺提示词、流转不成环、records/consumes 不配对）。
---

# 编写 ralph-loop 预设

一个预设 = 一个目录：`workflow.yaml` + 每个状态一份提示词文件。`/ralph start <name>` 运行它。
按下面的步骤走。字段细节读 `references/schema.md`，可直接改的范例读 `references/examples.md`。

先记住两条事实，它们决定所有设计：

- **每轮都是全新 session。** 执行 agent 在轮次之间不记得任何事。一轮需要的一切——工作项、上一轮的提交区间——只能从它的提示词文件、驱动程序注入的指令，或它自己去读 repo / issue tracker 得到。提示词必须**自足**。
- **每个状态只有一条出边。** 流转无条件：一轮结束必定走到 `transition`。要表达分支就**加一个状态**，不要指望 agent 自己选路。

## 步骤

### 1. 访谈

把循环的意图问清楚，别替用户猜。要能回答：

- 一轮消耗什么工作项？（issue / TODO / 失败的测试 / 计划文档的一段）
- 循环怎么判断"做完了"？（什么现象出现时该输出 done_marker，以及怎么确保只在此时输出）
- 哪些状态产出提交、哪些必须只读？（决定 `records_commit_range` / `consumes_commit_range` / `expect_no_commit` / `block`）
- 需要独立的审查或验证状态吗？
- 某个状态要用别的模型吗？

**完成判据：** 你能复述出状态列表、每个状态的职责、以及"完成"的判定现象，并且用户确认了。

### 2. 设计循环

排出状态序列与单环。每个 `transition` 必须指向已定义的 state；从 `initial` 出发要能走遍所有状态并回到 `initial`。

**完成判据：** 画得出一条覆盖全部状态的环，且没有走不到的状态。（第 4 步的校验器会强制这一点。）

### 3. 写文件

选一层落地（同名后层覆盖前层）：

| 层 | 位置 | 何时用 |
| --- | --- | --- |
| project | `<项目>/.ralph/workflows/<name>/` | 默认。只服务本项目，可随仓库提交 |
| global | `$PI_CODING_AGENT_DIR/ralph/workflows/<name>/` | 跨项目复用 |
| builtin | `<本包>/workflows/<name>/` | 只在改这个包本身时 |

写 `workflow.yaml`，再为每个状态写一份提示词。逐个状态自查提示词是否自足：

- 有没有说清"你没有上一轮的记忆"？
- 工作项从哪来、用什么命令取？
- 本轮允许做什么、禁止做什么（改代码？提交？关闭 issue？）
- 什么现象出现时才输出 done_marker（以及除此之外绝不输出）？

**完成判据：** 目录下有 `workflow.yaml`，且每个状态引用的提示词文件都存在、非空。

### 4. 校验

```bash
node --experimental-strip-types <本 skill 目录>/scripts/validate-preset.mts <name|dir> [--cwd <项目>]
```

按报错改，直到退出码为 `0`。警告也要读：它们指出"能跑但语义不对"的组合。

校验器要加载 pi-ralph-loop 包里的 `extensions/ralph-loop.ts` 和 `yaml`：会从脚本所在目录、当前目录逐级向上找，找不到就用 `PI_RALPH_LOOP_DIR=<包目录>` 指定（被单独装到别处的副本也能这样跑）。

**完成判据：** 校验器退出码 0。

### 5. 交付

**完成判据：** 用户拿到启动命令 `/ralph start <name> [maxRounds]`，以及一段"每一轮分别做什么"的说明。

## 易错点（写之前先看）

- **records/consumes 必须成对。** 产出方 `records_commit_range: true`，消费方 `consumes_commit_range: true`；缺一方，区间就是空的。
- **`from === to` 等同于"无区间"。** 消费方的提示词要覆盖"本轮没有新提交"的分支；用 `directive` 的 `{% if from %}...{% else %}...{% endif %}` 分开措辞。
- **`expect_no_commit` 只是事后告警。** agent 若提交，提交已经发生。真正的硬拦截是 `block`（工具名 + bash 正则）。只读状态要把两者都配上。
- **`no_progress_limit` 是全局计数**，跨状态累计；任何一轮有 commit 就清零。
- **提示词在 `/ralph start` 时一次性读入。** 改了提示词文件要重新 start 才生效。
- **预设目录只读。** 运行态写在 `.ralph/`（`state.json` / `driver.json` / `config.json`），所以预设可以跨项目共享、不会被改写。
- **别把预设和 plain 模式搞混。** `/ralph start`（不带参数）读 `.ralph/workflow.yaml`；`/ralph start <name>` 读预设目录。

## 参考

- `references/schema.md` — 全部字段与语义（含 `directive` 模板与 `block` 正则）
- `references/examples.md` — 可直接改的范例形状，以及官方完整范例的位置
- `scripts/validate-preset.mts` — 校验器；它跑的就是扩展里的 `validateWorkflow`，字段有分歧以它为准（需要 pi-ralph-loop 包在场，见第 4 步）
