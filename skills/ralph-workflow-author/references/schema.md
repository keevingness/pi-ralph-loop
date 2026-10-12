# workflow.yaml 字段参考

这是写作时的速查。**权威是校验器**：`scripts/validate-preset.mts` 跑的就是扩展里的 `validateWorkflow`，本文与它冲突时以校验器为准。

## 目录布局

```
<name>/
  workflow.yaml
  prompts/<state>.md        # 路径自由，只要 prompt 字段指得对
```

`prompt` 路径相对**当前 workflow 目录**（预设目录或 `.ralph/`），不是相对项目根。

## 顶层字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `initial` | 是 | — | 起始状态，必须是 `states` 里的键 |
| `states` | 是 | — | 状态映射，不能为空 |
| `no_progress_limit` | 否 | `3` | 连续 N 轮（**任意状态累计**）无新 commit 即熔断停止。`>=1` 整数 |
| `done_marker` | 否 | `[RALPH:DONE]` | agent 回复中出现该标记则结束整个循环 |
| `description` | 否 | — | 供 `/ralph presets` 展示的一句话 |

未知顶层键会被忽略（不报错）。

## `states.<name>` 字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `prompt` | 必填 | 提示词文件路径（相对当前 workflow 目录），必须存在且非空 |
| `transition` | 必填 | **唯一出边**：本轮结束后无条件流转到此状态，必须已定义 |
| `records_commit_range` | `false` | 轮结束时把 HEAD before/after 记为 `from`/`to`，供后续状态消费 |
| `consumes_commit_range` | `false` | 指令中注入 `from..to`；本轮结束后清空 |
| `expect_no_commit` | `false` | 轮后 HEAD 有变化则**告警**（不是拦截） |
| `directive` | — | 自定义注入指令模板，见下 |
| `model` | — | `provider/modelId`（modelId 可含 `/`）。省略则用 `/ralph start` 时钉定的模型 |
| `block.tools` | — | 本状态下**硬拦截**的工具名列表，如 `[edit, write]` |
| `block.bash_patterns` | — | 本状态下**硬拦截**的 bash 命令正则列表（不区分大小写地用 JS `RegExp` 匹配整条命令） |

### `model` 的解析

按**第一个** `/` 切分：`openrouter/deepseek/deepseek-chat` → provider `openrouter`，modelId `deepseek/deepseek-chat`。状态模型生效时**不套用**钉定模型的 thinking level。

### `directive` 模板

默认指令由插件生成（`## 本轮模式（驱动程序注入）：<state>` + 区间/禁止提交提示）。写了 `directive` 就完全替换它。

支持的替换：

| 语法 | 含义 |
| --- | --- |
| `{{state}}` | 当前状态名 |
| `{{from}}` / `{{to}}` | 提交区间端点；无区间时替换为空串 |
| `{% if from %}A{% else %}B{% endif %}` | 有区间取 `A`，否则取 `B`（只判断"有没有区间"这一件事） |

"有区间"的判定是 `from && to && from !== to`。

### `block` 正则怎么写

匹配的是**整条 bash command 字符串**，所以要同时考虑命令出现在行首、`&&`/`;`/`|` 之后、以及 `git <sub>` 形式。扩展内置预设用的是一条覆盖多种写法的正则：

```
'(^|[;&|]\s*|\bgit\s+)(commit\b|reset\b|revert\b|merge\b|rebase\b|checkout\s+--)'
```

注意这条也会误伤 `echo git commit` 这类字符串——`block` 是粗粒度硬拦截，提示词里仍要写清允许做什么。

## 运行时语义

- **每轮全新 session**：轮与轮之间不共享上下文。
- **状态流转由插件独占**：agent 不能读写或绕过。
- **`no_progress_limit` 全局计数**：任意轮有 commit 则清零。
- **结束条件**：回复含 `done_marker`、`/ralph stop`、达到 `maxRounds`、或触发无进展熔断。
- **运行态在 `.ralph/`**：`state.json`（当前状态与提交区间）、`driver.json`（轮次、钉定模型、`workflowDir`）、`config.json`（如 `{"repo": "org/name"}`）。预设目录保持只读。

## 预设层与优先级

```
builtin (<本包>/workflows/) < global ($PI_CODING_AGENT_DIR/ralph/workflows/) < project (<项目>/.ralph/workflows/)
```

同名后层覆盖前层。预设名只允许字母、数字及 `.` `_` `-`，且不以符号开头。
