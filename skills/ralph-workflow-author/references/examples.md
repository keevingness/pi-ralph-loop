# 范例形状

不重复官方完整范例——它有全套提示词，并在每个字段旁标了理由：

> **完整范例：`../../workflows/coding-review/`**（`workflow.yaml` + `prompts/coding.md` + `prompts/review.md`）。
> 那是 cnb issue 驱动的「实现 → 审查」环，适合作为写提示词的参照。

下面补三种官方没带的形状。照抄结构、替换成你的工作项。

## A. 单状态循环（最小可用）

没有独立审查轮。适合"直到队列为空"这种自检型任务（跑测试、清 lint、迁移文件）。

```yaml
initial: work
description: 逐条清 TODO 直到没有
states:
  work:
    prompt: prompts/work.md
    transition: work      # 自环
```

提示词骨架：

```markdown
你是 ralph loop 的单轮执行者，处于 work 状态。你没有上一轮的记忆，一切以仓库当前状态为准。
禁止读写 .ralph/ 目录。

## 本轮流程
1. 读 <工作项来源>，取最早的一条：<具体命令>。
2. 若没有待办：只回复 [RALPH:DONE] 加一段总结，不做其他事。
3. <做这件事>。只做这一条范围内的事。
4. 跑测试直到通过。
5. commit：只 add 你改动的文件，消息 <格式>。

## 结束条件
- 待办为空 → 回复 [RALPH:DONE]。
- 除此之外绝不输出 [RALPH:DONE]。
```

## B. 三段流水线（plan → implement → verify）

演示区间与硬拦截如何分配：只有 implement 产出提交，verify 只读且被 `block` 拦住。

```yaml
initial: plan
description: 计划 → 实现 → 验证
states:
  plan:
    prompt: prompts/plan.md
    transition: implement

  implement:
    prompt: prompts/implement.md
    transition: verify
    records_commit_range: true     # 交出本轮提交

  verify:
    prompt: prompts/verify.md
    transition: plan               # 回到计划，重估剩余工作
    consumes_commit_range: true    # 收下 implement 的提交区间
    expect_no_commit: true         # 事后告警
    directive: |-
      ---
      ## 本轮模式（驱动程序注入）：verify
      {% if from %}审查本轮实现产生的提交：区间 {{from}}..{{to}}，不得产生任何 commit。{% else %}本轮实现没有产生提交。确认后回复"无新提交"，不得产生任何 commit。{% endif %}
    block:
      tools:
        - edit
        - write
      bash_patterns:
        - '(^|[;&|]\s*|\bgit\s+)(commit\b|reset\b|revert\b|merge\b|rebase\b|checkout\s+--)'
        - 'git add'
```

`plan` 每轮重新进入，因此它的提示词要能回答"剩余工作是什么"——通常靠读 issue tracker、TODO 文件或上一个 verify 轮留下的结论。

## C. 只需事后检查的只读轮

如果那一轮本来就不会改代码（例如"跑一遍基准并报告"），可以不要 `block`，只留 `expect_no_commit` 作为异常告警：

```yaml
  report:
    prompt: prompts/report.md
    transition: work
    consumes_commit_range: true
    expect_no_commit: true
```

反过来，如果这一轮**必须**不能改文件（例如审查），把 `block` 也配上——`expect_no_commit` 只会在事后告诉你"它违规了"，`block` 才会当场拦住。

## 提示词里必须回答的四个问题

无论哪种形状，每个状态的提示词都要回答：

1. **你是谁、在哪一轮**——"你是单轮执行者，处于 X 状态，没有上一轮记忆"。
2. **工作项从哪来**——确切命令或确切文件，不要写"看看有什么要做的"。
3. **本轮允许/禁止什么**——改代码？提交？关闭 issue？只读？
4. **何时结束**——什么现象出现才输出 `done_marker`，并显式写出"除此之外绝不输出"。
