# 当前 handoff — 2026-08-02 Architecture Deepening FULL / YUK-842

## Owner direction and tracker

- Owner：「直接启动 FULL」；硬约束：「gate 不要在本地跑」。
- Linear project：`Architecture Deepening FULL — 语义、成本与运行所有权`（In Progress）。
- F0：YUK-840 Done、YUK-841 Done；YUK-842 因 production observe 暴露 SDK cold-start
  lease-loss，仍为 In Progress。

## Delivered and production state

- 原始 admission PR #1157 已 merge：main `34af0f75b8b7bfc1ac6b49826f9c6ba94c1012c8`；
  exact-head CI 全绿，独立审查无 P0/P1。
- 本地 prompt/config 物化修复 PR #1158 已 merge：main
  `c76ccf57edb88b7af48643fd61858534d9ddfbfb`；exact-head CI 全绿，独立审查无 P0/P1。
- production app/worker 当前同镜像
  `sha256:a7839883cc0a948b96e5c0ae7b21877be1b5ba0389e1a46637c7d40f0215b807`，
  都是 `observe`，policy 为 xiaomi concurrency=4 / starts=30 / queue=32 / wait=30s；health 正常、
  restart=0。Postgres/tunnel 未重启，migration 0088 已应用。
- rollback：pre-hotfix tag `the-learning-project-app:yuk842-prehotfix-20260803-0529` 指向旧 observe
  image；更早 preobserve tag 也保留。
- 尚未切 `enforce`，不得把当前状态写成 admission 已发布完成。

## Production evidence and second root cause

- 两次真实 API-originated Copilot 请求都 HTTP 200 且用户结果被 observe fail-open 保护。
- 第一次证明 acquire 后的一次性 skill/config 物化会阻塞 heartbeat；PR #1158 已把这些工作移到
  admission 前。
- PR #1158 部署后的第一次冷请求仍在 acquire 后约 16.2s 才恢复 event loop，原 15s lease 到期并
  记录 `lease_lost`。prompt/options 已完成，剩余 stall 位于 SDK `query()` 同步 CLI spawn/initialize。
- SDK 0.3.220 的正式 seam 是 `startup({options, initializeTimeoutMs}) → WarmQuery`；`startup()` 只
  spawn/initialize，不发送 prompt，`WarmQuery.query(prompt)` 才写 prompt。CLI binary 约 272MB。
- 原 lifecycle 还在 `sdkQuery()` 前启动 model timer；16s event-loop stall 也会饿死 10s task timer，
  因而仅延长 lease 不能闭合 runner correctness。

## Active checkout and implementation

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-842-startup-lease`
- branch：`codex/yuk-842-startup-lease`
- base：`origin/main@c76ccf57edb88b7af48643fd61858534d9ddfbfb`
- 当前未提交实现的生命周期：
  `local materialize → acquire → sdk startup(no prompt) → startup-to-steady CAS → final lease/cancel/deadline fence →`
  `ai_task_runs start + model timer → WarmQuery.query(prompt) → cleanup → release → settlement`。
- fixed timing：40s SDK initialize timeout；45s initial lease；15s steady/renewal horizon；5s heartbeat；
  provider start 保留 1s confirmed-lease margin；startup-complete claim CAS 明确缩到 steady lease，
  此后 heartbeat renewal 单调不缩短；lease protocol v2 进入 fingerprint；
  `hard_reclaim_at = acquire + 45s startup + execution timeout + 30s`。这些语义全部进入 policy
  fingerprint。
- permit 增加同步 provider-start assert，覆盖 event-loop stall 后 timer callback 尚未来得及执行的
  microtask race。unused WarmQuery 与 active Query 都在 release 前清理；stream client cancel 不再触碰
  已取消 controller。
- Hono 组合根从鉴权后为每个 API request 建立同一个 90s absolute deadline；全部 central runner
  串行、并行与嵌套调用自动取 request/caller 较早值。Copilot route 用同一 kernel budget 建显式 fallback
  并传给 classifier、teaching/free-form 主调用与 ToolContext nested central task；SDK 返回后再次检查
  lease/abort/deadline，迟到 success 不能越界。durable worker 无 HTTP scope。
- observe/enforce acquisition writer、short execution hard bound、non-shrinking renewal、steady 15s
  renewal、startup/durable deadline、startup failure/cleanup、三 runner seam 与全仓 SDK mocks 已更新。
- runbook、architecture、restore CLI、phase plan、PLAN 同步 startup budget 与恢复边界。

## Validation boundary and next action

- 没有运行任何本地 test/typecheck/lint/build/audit gate；只做代码编辑和静态只读检查。
- 下一步：独立只读 review 当前 diff → commit/push → 创建 PR → 只看 exact-head GitHub CI。
- 任何远端失败都在新 head 修复并重跑；只有 exact-head 全绿、无 unresolved P0/P1 才 merge。
- merge 后先确认 `ai_task_runs` running=0、pg-boss active/retry=0，再只重建 app/worker并保持
  `observe`。冷启动后必须分别取得真实 API 与 worker session 的 heartbeat/no-loss/released/cost
  evidence；证据闭合后才把 YUK-842 设 Done 并启动 Phase 1。
- PR #1154 接受合并，但其旧 head 与 YUK-840/841/842 有 9 个冲突且真实 A01 comparator 仍 timeout；
  先完成 YUK-842 exact-image observe 部署，再把 #1154 合并到最终 runner、跑新 head CI 后 merge，
  YUK-832 继续产品 HOLD 且不随本次 rollout 部署。

## Explicit residual scope

- YUK-845 承接 DashScope embeddings、Mem0 fan-out、direct GLM/OCR、Tencent OCR 与 manual preflight；
  当前不能宣称产品级 HTTP capacity 已统一治理。
- production `enforce` 仍需更长 observe 证据、全调用进程同 binary/fingerprint、application-level
  quiesce/drain 与 restore protocol；本轮冷证据干净也不自动授权切 enforce。
- 若任何 owner abort/kill/stop 不可证明正常 drain，恢复/切换等待下界是 process stop time + 45s
  startup budget + deployed max execution timeout + 30s abort grace；DB `hard_reclaim_at` 只能延长。
