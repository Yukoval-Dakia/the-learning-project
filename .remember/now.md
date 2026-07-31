# 当前 handoff — 2026-08-01

## Current state

- active lane：YUK-829；branch `codex/yuk-829-intervention-reviewer`；Draft PR #1139。
- owner 要求：复用并泛化现有题目 validator；mock fixture 必须复杂、接近真实题目；
  模型输出质量用真实 provider actual-output；完整 `pnpm test` 只在 GitHub exact-head CI。
- OpenCode 的 YUK-813/YUK-831 暂不推进，只盯产品。

## YUK-829 当前实现

1. 复用 `SolutionGenerateTask` 与 `QuizVerifyTask`，为三道 intervention diagnostic
   分别保存严格盲解和 `release_strict` content-grounding audit。
2. 服务端从 reference/gold authoritative surfaces 提取带 UTF-16 offsets/digest 的
   reverse-causation occurrences；provider 只能逐 index 分类与题面 outcome Y 的关系。
3. 服务端从 granular checks 派生闭集 verdict/failure codes；content grounding 非 pass、
   非同一 Y→X、漏项/重排/伪造 claim 均 fail closed。
4. pass 必须在同一 canonical comparator input 上得到两次有效确认；V3 audit 保存每轮
   valid result 或 contract-invalid null digest，activation/eval 逐轮复核 provenance。
5. FULL ceiling：11 validator calls/package、25 calls/preparation delivery、66 calls/六案例。

## 已完成验证

- unit：4 个相关文件，190/190。
- DB：intervention preparation + quiz_verify + source_verify，100/100。
- PASS：`pnpm typecheck`、`pnpm lint`、pre-PR schema/partition/API/capability/profile/draft
  audits、`pnpm build`、`git diff --check`。
- 独立 review 已覆盖 causal binding、shared validator regression、V3 state/provenance；
  修复其 P1 后均需在最终 diff 上确认关闭。
- 未在本机运行完整 `pnpm test`。

## Merge gate / next action

1. 最终独立 P0/P1 复核关闭后提交干净 HEAD。
2. 跑版本化六案例真实 MiMo actual-output；输出必须不存在、private、记录 exact SHA。
3. push；由 GitHub exact-head CI 跑完整测试，更新 PR #1139 与 Linear YUK-829 后合并。
4. YUK-829 合并只解除 YUK-814 blocker；YUK-814 仍需 fresh 10-run 真实 owner canary。
5. live 运行状态只以 PR #1139 / Linear YUK-829 为准，避免本 handoff 复制后漂移。
