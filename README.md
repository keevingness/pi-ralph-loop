# pi-ralph-loop

pi 扩展：ralph loop。在全新 session 中按状态机逐轮执行提示词，直到任务完成。

状态机由 `.ralph/workflow.yaml` 配置为**有向有环图**（每状态仅一条出边），由插件独占并在每轮结束后无条件流转；agent 无法读写或绕过状态。

## 安装

```bash
pi install git:github.com/<user>/pi-ralph-loop   # git 安装（克隆后自动 npm install）
pi install /absolute/path/to/pi-ralph-loop       # 本地路径安装
pi -e ./pi-ralph-loop                            # 临时加载，仅本次运行生效
```

安装后在项目根目录运行 pi，使用 `/ralph` 命令：

```bash
/ralph init                # 生成 .ralph/（workflow.yaml、prompts/、state.json、config.json），不覆盖已有文件
/ralph start [maxRounds]   # 启动循环（默认 maxRounds 20，捕获启动窗口的模型）
/ralph stop                # 当前轮结束后停止
/ralph status              # 查看轮次 / 状态
```

## 运行时文件（`.ralph/`，项目本地，不入库）

- `workflow.yaml` - 状态机配置（见下）
- `prompts/<state>.md` - 每状态提示词
- `state.json` - 当前状态与提交区间（仅插件写入；agent 被禁止读写 `.ralph/`）
- `config.json` - 仓库坐标等（如 cnb 的 `org/repo`）

## workflow.yaml

```yaml
initial: coding
no_progress_limit: 3            # 全局熔断：连续 N 轮（任意状态累计）无新 commit 即停止

states:
  coding:
    prompt: prompts/coding.md   # 提示词文件，路径相对 .ralph/
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

状态：

| 字段 | 说明 |
| --- | --- |
| `prompt` | 提示词文件路径（相对 `.ralph/`），必填 |
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

## 开发

```bash
npm install --ignore-scripts
node --experimental-strip-types test/offline-test.mts   # 校验/指令生成/模型解析
node --experimental-strip-types test/regex-test.mts     # 默认拦截正则行为
```
