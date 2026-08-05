# 当前 handoff — 2026-08-05 post #1154 merge

## Owner direction and tracker

- 硬约束：完整 gate 只认 exact-head GitHub CI；本机不做 full `pnpm test`。
- Linear：`Architecture Deepening FULL — 语义、成本与运行所有权`。
- F0 实现：YUK-840/841/842 Done；**PR #1154 MERGED**（main `effbc1c317` squash）。
- **YUK-832 产品 gate 仍 HOLD / In Progress**——不部署 combined image、不 flip enforce。

## Just closed

- PR #1154 LIGHT evidence certification 代码已上 main。
- Feature branch 上 ordinary merge 吸收了 YUK-842 lifecycle（deadline / admission /
  atomic attempt-finished）与 PR 的 observed-usage accumulator；orphan 无 usage 保持
  cost-unknown。
- P1 follow-ups：`1,761` 千分位不切分；toolTrace 60 封顶；evidence legs 透传
  `providerSessionDeadlineAt`；filtered FSRS `subject_scope`。
- main 规则 `required_linear_history` → PR 本体只能 squash 落地（见 YUK-832 Linear 评论）。
- exact-head CI Gate 全绿；review threads 已全部 resolve。

## Production state (unchanged this turn)

- app/worker 仍为 #1159 observe 镜像证据链；本轮 **未** 部署 #1154。
- Postgres/tunnel 未因本轮变更而动。

## YUK-832 gate (still HOLD)

- LIGHT 降 reference 成本 + 失败记账已在代码与 r9 artifact 中；comparator timeout 仍
  fail-closed → 产品不放行。
- FULL checkpoint = YUK-839（parked）。
- 下一 session：**不要**再开 #1154 实施；要么等 owner 对 YUK-832/839 的产品裁决，
  要么在授权后启动 Phase 1（practice-owned failure-learning），UI 先 design pre-flight。

## Active worktree note

- 原 worktree branch `codex/yuk-832-evidence-readers` 已 merge；后续看板提交走
  `chore/post-1154-board` 或新 branch。
- 不打印/不轮换任何已暴露凭据（YUK-846 另跟）。
