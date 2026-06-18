# Linear 最大化方案 + 落地记录（2026-06-18）

本文件固化「在本项目 vibe coding 中最大化利用 Linear」的方案,并记录已落地动作 + 剩余需 owner 亲手做的步骤。配套:`linear-agent-guidance.md`(Agent guidance 源)、`issue-tracker.md`(完整约定)、`triage-labels.md`。

## 计费边界(为什么不怕花钱)

- **只有 coding sessions(委派 issue→Linear 跑 Claude Code/Codex 出 PR)从 AI credits 扣钱**(预付、admin 充值、$0.5–5+/次,Free plan 没有此功能)。**opt-in,不充钱永不扣**。
- 其它一切(Projects / Cycles / Labels / Linear Agent chat / project updates / GitHub 状态自动流转)**含在 plan 里,不碰 AI credits**。
- 委派的免费等价物:**`W` 然后 `O`(Open in coding tool)** 把 issue 全上下文 + 自定义 prompt 丢进**本地 Claude Code**(跑在 owner 自己的 Max 订阅/机器上,0 Linear 充值)。Linear=驾驶舱,本地=引擎。

## 已落地(2026-06-18,经 MCP / repo)

1. **4 个 Project + 子树挂载**(共 51 issue):领域模型重构(YUK-203,37)/ 私人教研团 rethink(YUK-405,3)/ 记忆层(YUK-322,9)/ UI 重绘(YUK-169,2)。各发了一条 project status update。
   - 注:领域模型重构是 umbrella 级(37 issue),理想形态是 Initiative + 多子 Project;Initiative 需手动在 Settings 开(MCP 建不了)。
2. **Area 标签**新建:`area:matcher/kg/practice/copilot/memory/ui`。triage 标签(`needs-info/ready-for-agent/ready-for-human/drift/wontfix`)经核已存在。
3. **Cycle 1**(6/21–7/05)载入当前焦点:YUK-405/406(关系脑)、YUK-348(B1)、YUK-344(KG 一致性)。其余按需 owner 自加。
4. **Agent guidance 源**:`linear-agent-guidance.md`(待 owner 粘贴进 Settings→AI)。
5. **doc 漂移修**:`issue-tracker.md` estimate 改为可选(原文档要求 Fibonacci 但实践全空)。

## 剩余需 owner 亲手做(MCP 改不了 Settings)

### ① PR → 状态自动流转(零成本,最高 ROI)

目标:删掉「手动 In Progress / 手动 Done」。配置路径:

1. **Settings → Code & reviews**:确认 GitHub 集成已连;开 **"On git branch copy, move issues to a started status"**(配合 Preferences 的 auto-assign self)。
2. **Team Settings → Issue statuses & automations(Workflow)** 配 PR 自动流转:
   - On PR opened / review activity → **In Review**
   - On PR merged → **Done**
   - (注:Linear 要求设了 "On MR review request or activity" 状态,merge 流转才生效。)
3. **验证配方**(把 issue-tracker.md 里那 3 条 ❓ 一次性证实):留一条 issue 停在 In Progress、merge 它带 `Closes YUK-NN` 的 PR、看 ~1 分钟后是否自动 Done。结果回写 issue-tracker.md「Confirmed behaviours」。

### ② 粘贴 Agent guidance

把 `linear-agent-guidance.md` 正文贴进 **Settings → AI → Agent guidance**(workspace 级)。

### ③(可选)Initiative

若想要 workspace 级 north-star 视图,在 **Settings → Initiatives** 开,然后建一个 Initiative(如「AI 学习工具 — 重构与 rethink」)把 4 个 Project 收进去。

### ④(可选,需 Basic+ plan)评估 coding session / Triage 自动化

只在愿意为 AI credits 付费时;否则用 ① 的 `W→O` 桥到本地。

## 日常用法速记

- 从 issue 起手干活:`W O`(或 `Cmd+Option+.`)→ 本地 Claude Code。
- 把 issue 喂本地 session:`Cmd+Opt+C` 复制成 markdown。
- 在 Linear 里审 PR:GitHub PR URL 把 `github.com` 换 `linear.review`。
- 让 Linear Agent 写周报/项目更新:`⌘J` 开 chat,"summarize this project's progress, risks, next steps"(免 credits)。
