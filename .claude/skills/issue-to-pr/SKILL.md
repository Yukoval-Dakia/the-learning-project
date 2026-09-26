---
name: issue-to-pr
description: 无人值守外环：一条 issue/bug 报告进来 → 分类 → 复现 → 修 → 验证 → draft PR，全程不 merge 不 deploy。Use when user says "issue-to-pr", "/issue-to-pr", hands a YUK-NN or pasted bug report and wants it闭环到 draft PR, or asks for unattended bug fixing.
---

# Issue → PR（fail-closed 外环）

pstack `benny/reproduce-and-fix-issues` 的本仓库移植。**默认输出是 draft PR，永远不 merge、不 deploy**。任何环节缺坐标/不确定就停，不猜。

## 0. Gate（fail-closed，任一不过即停并报告）

- issue 可定位：用户给 `YUK-NN` → `tools.linear` 拉取；或贴原文 → 建本地记录。拿不到坐标就停。
- **归属检查**：issue 已有人认领 / 有活跃 assignee 声称在修 / 已有可信 PR 链接 → 不进修复 lane，转为**验证已有 PR**（步骤 4 只跑验证，不另写补丁）。
- **重复检查**：Linear 搜同症状票，高置信重复 → 在原票更新/评论，不开新票不修。
- 触发方式：必须用户显式调用本 skill，不自启。

## 1. 分类

读 issue 正文+评论，定 surface（UI / API / worker / migration / 纯逻辑）和 likely owning layer（`src/capabilities/<name>` / `core/` / `subjects/<name>`）。不定型 → 报 "other" 停。

## 2. 复现（强制两次）

- 按 `verify-app` 在**真实面**上把症状打出**两次**，每次记录：动作序列 + 结果状态 + 副作用（DB/job 状态）。截图/trace 存 artifact。
- 状态探查只能**只读**，不许注入症状。测试/读码不算复现。
- 两次都打不出 → `NOT VERIFIED` 报告：已试路径、证据、还差什么。不写补丁。
- 发现一个可信 reviewer（另开 read-only explorer）确认 media/输出确实呈现判别性破态。

## 3. 修复（严格 bounded）

- 只许一次 root-cause 修复尝试（`diagnosing-bugs` 的假设消去法 + ship-mode bug-fix playbook 步骤 2–5）。范围超出单文件族/需 schema 迁移/需产品裁决 → 停，报告建议拆票。
- 修完在**同一 UI/API 路径**再跑两遍，前后状态交叉核对（baseline 的值 vs patched 的值）。
- 跑 scoped gate：`pnpm typecheck`、`pnpm lint`、匹配范围的 unit/DB/migration test、`pnpm build`。
- Blast-radius smoke：改动面的相邻路径至少一条 sanity 驱动。

## 4. Draft PR

- 按 `pr` skill 开 **draft** PR，title 带 `YUK-NN`。
- body 必含：复现步骤、before/after 证据（截图/输出 verbatim）、根因一句话、跑了哪些检查、哪些没跑及原因。
- 不 merge、不点 ready-for-review、不 deploy。等 CI Gate + owner/评审裁决。

## 5. 报告

一行结论 + 证据表 + 卡点（如有）。全过程写 `worklog`。
