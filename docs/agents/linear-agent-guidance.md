# Linear Agent Guidance（源文件）

> 这是 **Linear Agent guidance** 的 repo 源（repo 为真相源，Linear 为镜像）。
> 把本文件正文粘贴进 **Settings → AI → Agent guidance**（workspace 级），让任何在 Linear 内运行的 Agent（@Linear 对话 / comment / 未来的 coding session）遵循本项目约定。
> 修改约定时改这里 + 重新粘贴，别只改 Settings。配套：`docs/agents/issue-tracker.md`（完整版）、`docs/agents/triage-labels.md`、`docs/agents/linear-maximization.md`。

---

## 这个 workspace 是什么

单人 AI 学习工具项目（Yukoval Studios / YUK）。owner 用本地 Claude Code + worktree + workflow 做多 agent 编排,Linear 是**驾驶舱 + 记录**,不是 compute——AI 实现跑在 owner 自己的机器上,Linear 永不付算力钱(不开 coding session 充值)。

## Issue 约定

- **标题**:写具体动作,不只症状。phase 工作用 `[<phase>/<task#>] <动词短语>`(如 `[P0/4] Physics e2e smoke test`)。
- **Body 6-section 模板**(plan-doc 任务的常态):`## Files`(Create/Modify + 行号) / `## Acceptance`(命令+期望输出) / `## Spec`(doc 路径+锚点) / `## Commit`(commit 提示 + `Closes YUK-NN`) / `## Depends on` / `## Boundaries (out of scope)`。不适用的 section 删掉不留空。
- **粒度**:一个 agent pass 能完成。两个必须一起 commit 的 plan task 合一;独立可 review/merge 的拆开。每 milestone ≥3 issue;不要一 commit 一 issue。
- **Priority**:`0=None 1=Urgent 2=High 3=Medium 4=Low`,默认 2/3/4。
- **Estimate**:可选。要做 cycle velocity 时再设 Fibonacci(1/2/3/5/8),>8 拆分。**不强制**——不为凑字段编估值。
- **Labels**:见下「Layer & Labels」。
- **去重**:建 issue 前先按 `YUK-*` / 标题关键词 / 文件路径 / 符号名搜;覆盖同一工作就更新既有 issue,不新建。

## Layer & Labels

| Linear 层 | 项目语义 |
| --- | --- |
| Initiative | 跨多 phase 的大版本(可选,手动在 Settings 建) |
| Project | 一条主线 / lane / phase。当前活的 4 条:**领域模型重构 (YUK-203)** / **私人教研团 rethink (YUK-405)** / **记忆层 (YUK-322)** / **UI 重绘 (YUK-169)**。新建 issue 优先挂对应 Project。 |
| Milestone | Project 内执行节点(M1/M2,带 target date) |
| Issue | 单个可独立 grab 的工作单元 |
| Cycle | 1–2 周冲刺。当前焦点 issue 才挂 cycle,别把整个 backlog 灌进去。 |

**Triage 标签**:`needs-triage`(项目/里程碑不清) / `needs-info`(等人/产品决策) / `ready-for-agent`(repo-evidenced,可直接执行) / `ready-for-human`(等 owner 亲自做) / `drift`(代码↔文档/状态不一致) / `wontfix`(不做,留历史)。标签不复述状态——状态用 state 字段。
**Area 标签**(按子系统筛):`area:matcher` / `area:kg` / `area:practice` / `area:copilot` / `area:memory` / `area:ui`。

## 状态流转

`Backlog → Todo → In Progress → In Review → Done`(旁:`Canceled` / `Duplicate`)。
- `Todo → In Progress` 在写第一行代码时手动设(集成没有这个信号)。
- PR open/merge 的状态流转由 GitHub 集成自动做(若团队 Workflow 已配)。

## Git ↔ Issue(关键铁律)

- **每个 issue 单独写一行** `Closes YUK-NN` / `Fixes YUK-NN` / `Resolves YUK-NN` / `Part of YUK-NN`。一个 commit 涉多 issue 就重复多行:
  ```
  Closes YUK-27
  Closes YUK-28
  ```
  **绝不**写 `Closes YUK-27 + YUK-28` / `Fixes YUK-27, YUK-28`——Linear 只 link 第一个,漏后面的。`.claude/hooks/linear-guard.mjs` 会拦简写。
- 关键词放进**至少一个 commit message**,不能只放 PR body(集成扫 commit)。
- branch 名用 Linear 的 `yuk-xx-...` 形态(带 issue id,PR 自动 link)。
- 新工作一律 `YUK-XX`,不用裸 `#N`(留给历史 GitHub issue 考古)。

## 不要做

- **不反向同步**(Linear → git):把 issue 拖 In Progress 不应触发建分支/checkout。git 是真相源。
- **不 cron reconcile / 不 commit-hook 双写**:集成已覆盖 magic word,重复会造重复 attachment。
- **文档**:repo 为真相源,Linear Document 是镜像;改 design doc 后用 save_document 同步,不反过来。

## 收口 capture gate

每个实现/审计/规划/迁移任务,最终回复前对账 Linear:为发现的可执行 follow-up 建/更新 issue(先搜重),或明确说明「无需 Linear issue」及原因。不要把已核实的 follow-up 只留在散文/本地 TODO。
