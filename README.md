# pi-ralph-loop

pi 扩展：ralph loop。在全新 session 中按状态机逐轮执行提示词，直到任务完成。

状态机由 workflow 配置（`.ralph/workflow.yaml` 或预设目录内的 `workflow.yaml`）定义为**有向有环图**（每状态仅一条出边），由插件独占并在每轮结束后无条件流转；agent 无法读写或绕过状态。

## 安装

```bash
pi install git:github.com/<user>/pi-ralph-loop   # git 安装（克隆后自动 npm install）
pi install /absolute/path/to/pi-ralph-loop       # 本地路径安装
pi -e ./pi-ralph-loop                            # 临时加载，仅本次运行生效
```

安装后在项目根目录运行 pi，使用 `/ralph` 命令：

```bash
/ralph init                        # 从内置默认预设生成 .ralph/（workflow.yaml、prompts/、state.json、config.json），不覆盖已有文件
/ralph presets                     # 列出可用预设及其来源（builtin / global / project）
/ralph start [preset] [maxRounds]  # 启动循环（默认 maxRounds 20，捕获启动窗口的模型）
/ralph stop                        # 当前轮结束后停止
/ralph status                      # 查看轮次 / 状态
```

`/ralph start` 不带 preset 时读 `.ralph/workflow.yaml`（旧行为）；首参为纯数字时视为 maxRounds，如 `/ralph start 30`。

## 预制工作流（presets）

预设 = 一个目录，内含 `workflow.yaml` 与本工作流的提示词文件：

```
workflows/coding-review/
  workflow.yaml
  prompts/coding.md
  prompts/review.md
```

按以下顺序分层查找（同名后层覆盖前层）：

| 层 | 位置 |
| --- | --- |
| builtin | 扩展包内的 `workflows/` |
| global | `$PI_CODING_AGENT_DIR/ralph/workflows/`（默认 `~/.pi/agent/ralph/workflows/`） |
| project | `<项目>/.ralph/workflows/` |

```bash
/ralph presets            # 列出 name [来源] - description
/ralph start coding-review
```

预设目录是**只读**的：运行时状态（`state.json`/`driver.json`/`config.json`）始终写在 `.ralph/`，因此预设可跨项目共享、不会被改写。`workflow.yaml` 可选顶层字段 `description`（字符串），供 `/ralph presets` 展示。

自建预设：在 `~/.pi/agent/ralph/workflows/<name>/` 或 `<项目>/.ralph/workflows/<name>/` 下放 `workflow.yaml` 与提示词即可，无需在 `.ralph/` 里再写一份。预设名只允许字母/数字/`._-`（拒绝路径穿越）；启动前的校验（工作流、prompt 文件、模型）全部失败即返回，不产生任何副作用。

### 让 agent 帮你写预设

本包带一个 skill `ralph-workflow-author`，指导 agent 按步骤写出预设，并自带校验脚本：

```bash
node --experimental-strip-types skills/ralph-workflow-author/scripts/validate-preset.mts <name|dir> [--cwd <项目>]
```

安装本包后 pi 会自动发现它（也可直接 `/skill:ralph-workflow-author 帮我写一个 … 的预设`）。校验脚本调用扩展真实的 `validateWorkflow`，并额外检查：走不到的状态、流转不成环（尾巴+子环）、`records`/`consumes` 不配对、只读状态没配 `block`、提示词里没有 `done_marker`。退出码 0 即通过。

只想把这个 skill 单独装进任意 agent（不装扩展）时，用 [`skills` CLI](https://skills.sh)：

```bash
npx skills add https://gitee.com/keeving/pi-ralph-loop.git      # 装到当前项目 (.agents/skills/)
npx skills add https://gitee.com/keeving/pi-ralph-loop.git -g   # 装到用户级 (~/.agents/skills/)
npx skills add https://gitee.com/keeving/pi-ralph-loop.git -l   # 只列出仓库里的 skill，不安装
```

URL **必须带 `.git` 后缀**：不带时 skills CLI 会当成 well-known 端点去探测，而 gitee 不提供该端点。
安装的是 skill 目录的副本，不含本包的扩展代码与 `yaml` 依赖，所以校验脚本需要另外有一个 pi-ralph-loop 包在附近（脚本会从自身目录和当前目录向上查找），或用 `PI_RALPH_LOOP_DIR=<包目录>` 指定；找不到时脚本会明确报错而不是崩栈。

## 运行时文件（`.ralph/`，项目本地，不入库）

- `workflow.yaml` - 仅 plain 模式（`/ralph start` 不带 preset）使用；预设模式下由 `driver.json` 的 `workflowDir` 指向预设目录
- `prompts/<state>.md` - 每状态提示词（相对当前 workflow 目录）
- `state.json` - 当前状态与提交区间（仅插件写入；agent 被禁止读写 `.ralph/`）
- `config.json` - 仓库坐标等（如 cnb 的 `org/repo`）
- `driver.json` - 运行态：轮次、钉定模型、`workflowDir`

## workflow.yaml

单个预设（或 plain 模式的 `.ralph/workflow.yaml`）的格式：

```yaml
initial: coding
no_progress_limit: 3            # 全局熔断：连续 N 轮（任意状态累计）无新 commit 即停止

states:
  coding:
    prompt: prompts/coding.md   # 提示词文件，路径相对当前 workflow 目录
    transition: review          # 唯一出边：本轮结束后无条件流转
    records_commit_range: true  # 轮结束时记录 HEAD 区间（from/to）
    model: newapi/glm-5.3       # 可选：本状态使用的模型（省略则用启动时钉定的模型）

  review:
    prompt: prompts/review.md
    transition: coding
    consumes_commit_range: true # 指令中注入提交区间 from..to，本轮结束后清空
    expect_no_commit: true      # 轮结束后 HEAD 有变化则告警违规
    directive: |-               # 可选：自定义指令模板，支持 {{state}}/{{from}}/{{to}}
      ---
      ## 本轮模式（驱动程序注入）：review
      审查区间 {{from}}..{{to}}
    block:                      # 可选：本状态下拦截工具与 bash 命令正则
      tools: [edit, write]
      bash_patterns:
        - '\bgit\s+commit\b'
```

### 字段说明

顶层：

| 字段 | 说明 |
| --- | --- |
| `initial` | 起始状态 |
| `no_progress_limit` | 全局熔断阈值，默认 3；有 commit 即清零 |
| `done_marker` | agent 回复中出现该标记则结束循环，默认 `[RALPH:DONE]` |
| `description` | 可选，供 `/ralph presets` 展示 |

状态：

| 字段 | 说明 |
| --- | --- |
| `prompt` | 提示词文件路径（相对当前 workflow 目录），必填 |
| `transition` | 唯一出边，必填 |
| `records_commit_range` | 轮结束时记录 HEAD before/after 为 from/to |
| `consumes_commit_range` | 指令注入区间；轮结束后清空 |
| `expect_no_commit` | 轮后 HEAD 变化视为违规并告警 |
| `directive` | 自定义指令模板；`{% if from %}...{% else %}...{% endif %}` 可区分"有/无区间"两种措辞 |
| `model` | 本状态运行模型，格式 `provider/modelId`（modelId 可含斜杠） |
| `block.tools` | 拦截的工具名列表 |
| `block.bash_patterns` | 拦截的 bash 命令正则列表 |

模型优先级：状态模型 > `/ralph start` 时钉定的模型。状态模型生效时不套用钉定模型的 thinking level。

## 结束条件

- agent 回复包含 `done_marker`
- `/ralph stop`
- 达到 `maxRounds`
- 连续 `no_progress_limit` 轮（任意状态累计）无新 commit

## 强制约束（agent 无法绕过）

- 状态流转由插件完成，不依赖 agent 行为
- `block` 配置在 `tool_call` 层硬拦截
- `expect_no_commit` 状态轮后检查 HEAD，变化即告警
- 每轮使用全新 session（`ctx.newSession()`），上下文不串

## 项目结构

```
extensions/                     # /ralph 命令与状态机驱动
skills/ralph-workflow-author/   # 教 agent 写预设的 skill（含校验脚本）
workflows/coding-review/        # 内置预设
                    # 另：全局 ~/.pi/agent/ralph/workflows/、项目 .ralph/workflows/
test/
```

## 开发

```bash
npm install --ignore-scripts
node --experimental-strip-types test/offline-test.mts   # 校验/指令生成/模型解析/预设解析
node --experimental-strip-types test/regex-test.mts     # 默认拦截正则行为
node --experimental-strip-types test/preset-test.mts    # 预设工作流集成测试（真实文件系统 + handler）
node --experimental-strip-types test/validate-preset-test.mts  # skill 校验器正反例
```
