# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-10

## NOW

- **F2.1 / YUK-857 已合并 main。** PR #1174 merge SHA `3d3c89c5`；Notes append-only
  handoff、deterministic dispatch/readback 与 shared recovery floor 已进入主线。未部署。
- **F2.2 / YUK-858 PR #1175 current head 已含实现与 CI repairs，并已 committed/pushed。**
  Memory-owned event v1
  fenced provider-start 后置 add marker、ingest completion/intents、exact deterministic
  dispatch/readback、append-only recovery cursor + bounded wrap scan 第二 leg 与 strict
  `observe|write|recover|drain` 模式已实现；没有 table/migration/new cron。
- **最新 prior exact-head CI 反馈已修：** PostgreSQL strict-shape key count、trigger mock
  `(db,input)` 签名、provider audit caller evidence 与 Map size assertions；owner 禁止本地
  test/typecheck/build/audit/migration，runtime 结论只由 fresh current-head GitHub CI 给出。
- **生产边界不变：** 未部署；YUK-832 HOLD 与 YUK-842 observe 未改变。

## NEXT

1. 等待 fresh current-head CI 验证 unit/DB/typecheck/build/audits；不预称 green。
2. 确认无 unresolved P0/P1 review findings 后 merge；P2/minor/nit/refactor 不阻塞。
3. 执行完整 Linear capture gate：duplicate search、actionable follow-up 创建/更新或明确无项、
   YUK-858 issue status 与实际 merge/rollout 状态校准；rollout 顺序 `observe -> write -> recover`。

## PARKED

- Production rollout / observation 需独立授权；回滚顺序 `recover -> drain -> observe`。
- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- F2.3–F4 保持 open，不并入 YUK-858。

## BLOCKED-ON

- Delivery blocked on fresh current-head CI、无 unresolved P0/P1 review findings、merge 与
  完整 Linear capture gate。
- Production blocked on独立部署授权和真实观察证据。
