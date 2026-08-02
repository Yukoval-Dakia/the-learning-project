# 当前 handoff — 2026-08-02 Architecture Deepening FULL / YUK-842

## Owner direction and tracker

- Owner：「直接启动 FULL」；硬约束：「gate 不要在本地跑」。
- Linear project：`Architecture Deepening FULL — 语义、成本与运行所有权`（In Progress）。
- F0：YUK-840 Done、YUK-841 Done（PR #1156 / main `292350958`）、YUK-842 In Progress。

## Active checkout

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-842-provider-admission`
- branch：`codex/yuk-842-provider-admission`
- base：`origin/main@292350958fea4cbc1adb64b08659064b06916eaa`
- 原 checkout 有 owner 的 CI/PLAN/research 未提交修改，未触碰。

## Implemented boundary

- `provider_session_admission` 是 operational lease + start-reservation ledger；terminal row 在七天后
  只获得 lane-local opportunistic pruning eligibility，不承诺后台 TTL。application archive excluded
  且 import wipe-only；full `pg_dump` restore 后必须显式 truncate；resetDb/migration-smoke 均同步。
- `provider-session-admission.ts`：per-provider lane policy JSON；`off | observe | enforce`；短
  `pg_try_advisory_xact_lock` transaction；DB-clock FIFO/queue/rate/concurrency CAS；claim heartbeat、
  lease expiry、hard reclaim、policy mismatch fail-closed、bounded lane-local pruning batch。
- admitted unit 是完整 central Claude Agent SDK `sdkQuery()` session，不是 wire request。一个 session
  可含 turns、nested SDK agents、tool loop 与 `CLAUDE_CODE_MAX_RETRIES` 内部尝试。
- admission wait 在 durable `ai_task_runs` start 与 model timer 之前；timeout/cancel 只有 admission
  row，不制造 YUK-841 unknown cost attempt。permit 在 terminal settlement/afterRun 前 release。
- runner 的 runTask、streamTask、streamTaskCollecting 三处真实 query seam 全接入；只有真正执行新
  provider attempt 的 Loom retry / pg-boss redelivery 才使用新 admission id；replay/fence 不 re-admit，
  且没有新增 retry layer。retry admission 受首次 attempt 的绝对 elapsed deadline 约束。
- same-lane nested DomainTool task 通过 `parentTaskRunId` 加入 active session family：一个 root 只允许
  一条 active descendant chain 共享槽，parallel sibling 等待或占新 root；parent 先结束时 active
  child 接管槽。每个 child 仍独立计 start reservation/lease/metrics；ResearchMeetingDirector
  预分配 outer task id，避免 synthetic id 断链。
- `observe` 唯一允许 bounded fail-open；`enforce` 对 DB/lease/policy ambiguity fail-closed。短 token 只
  fence DB owner，不 fence provider，故 lost active family root/branch 在 release/hard_reclaim 前继续
  占容量。
- wait/release 使用 monotonic deadline、transaction-local `lock_timeout` / `statement_timeout`、有界
  backoff 与 per-process lane single-flight；timeout/cancel 走独立短 CAS，失败时由后续 lane tick 收口。

## Evidence and tests authored

- DB：两个 independent clients 共用 cap、FIFO、queue-full、duplicate owner、cross-lane row identity、
  lease-expired quarantine/hard reclaim、single descendant chain、parallel sibling、parent-first promotion、
  terminal+family-child start reservation、policy mismatch、row-lock DB timeout 与 DB-linearized wait timeout。
- Unit：strict config、off rollback、observe/enforce failure behavior；lifecycle wait 前不 start/timer；
  admission timeout不建 attempt；三 runner seam、retry absolute deadline/re-admit/release-before-settle。
- Migration：table/index/CHECK/backup/restore/reset lockstep。
- Runbook：全进程 `off → observe → quiesce → enforce`、metrics SQL、failure/restore/rollback。

## Validation boundary and next action

- 没有运行任何本地 test/typecheck/lint/build/audit gate。
- 只运行 formatter、`git diff --check` 与只读静态检查；它们不是验证证据。
- 下一步：独立审阅 current diff → commit/push/PR → exact-head GitHub CI。仅 P0/P1 阻塞。
- Phase 0 exit 仍需 merge 后一个真实 provider observation；不能用 mock/synthetic 冒充。

## Explicit residual scope

- DashScope embeddings、Mem0 fan-out、direct GLM reconcile、GLM/Tencent OCR、manual preflight 不走
  `AiRunLifecycle`，不在 YUK-842 session gate 内；已建 YUK-845 承接，完成前不得宣称产品级 provider
  HTTP capacity 已治理。
- application archive import 需要保留 admission-off 的 admin Hono、阻断 ingress、停 worker 并 drain；
  full `pg_dump` restore 则停 app/worker，migrate 后 truncate admission 表。若任何 owner 未确认正常
  drain，必须在 abort/stop/wipe 前把 active row 的最大 `hard_reclaim_at` 记到 DB 外，并从 process
  stop time 强制等待 deployed max execution timeout + 30s（DB snapshot 只能延长不能缩短）。两条
  路径还须等待最后一次 provider traffic + 60s；单次 DB zero snapshot 不能关闭 wait→acquire race。
