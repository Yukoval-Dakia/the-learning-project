# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-10

## NOW

- **F2.1 / YUK-857 已合并 main。** PR #1174 merge SHA `3d3c89c5`；Notes append-only
  handoff、deterministic dispatch/readback 与 shared recovery floor 已进入主线。未部署。
- **F2.2 / YUK-858 已在隔离 worktree 完成代码与测试作者。** Memory-owned event v1
  fenced provider-start 后置 add marker、ingest completion/intents、exact deterministic
  dispatch/readback、append-only recovery cursor + bounded wrap scan 第二 leg 与 strict
  `observe|write|recover|drain` 模式已实现；没有 table/migration/new cron。
- **验证边界：** owner 禁止本地 test/typecheck/build/audit/migration；只运行 changed-file Biome
  与 `git diff --check`。Runtime 结论留给 future exact-head GitHub CI。
- **生产边界不变：** 本线没有 commit/push/deploy；YUK-832 HOLD 与 YUK-842 observe 未改变。

## NEXT

1. 独立 review 当前 diff，修复后 commit/push。
2. 以 future exact-head GitHub CI 验证 unit/DB/typecheck/build/audits。
3. CI/review clean 后合并并同步 Linear；rollout 顺序 `observe -> write -> recover`。

## PARKED

- Production rollout / observation 需独立授权；回滚顺序 `recover -> drain -> observe`。
- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- F2.3–F4 保持 open，不并入 YUK-858。

## BLOCKED-ON

- Delivery blocked on commit/push、exact-head CI、独立 review 与 Linear 同步。
- Production blocked on独立部署授权和真实观察证据。
