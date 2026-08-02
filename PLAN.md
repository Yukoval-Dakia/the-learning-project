# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-02
> **【YUK-842 active：Architecture Deepening FULL / F0-3】**

## NOW

- Owner 已明确「直接启动 FULL」，并追加硬约束「gate 不要在本地跑」。F0 串行依赖
  YUK-840 → YUK-841 → YUK-842；验证只接受 exact-head GitHub CI。
- YUK-840 与 YUK-841 已 Done：PR #1155 / #1156 merged；YUK-841 main commit
  `292350958fea4cbc1adb64b08659064b06916eaa`，最终 exact-head CI 全绿。
- YUK-842 在独立 worktree
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-842-provider-admission`、branch
  `codex/yuk-842-provider-admission` 实施；Linear 为 In Progress。
- 当前实现以 Postgres 一张 operational 表为 central Claude Agent SDK query-session 做跨进程
  admission：per-lane active session-family/parallel branches、session-start reservations/min、
  FIFO wait/queue bound、DB clock、短 lease、
  heartbeat、claim token、hard reclaim、policy fingerprint，以及七天后 lane-local opportunistic
  pruning eligibility（不是后台 TTL）。
- admission 在 `ai_task_runs` start/model timer 前；wait/timeout 不制造 unknown-cost model attempt。
  三处真实 `sdkQuery()` seam 共用 lifecycle wrapper，permit 在 attempt settlement 前释放；只有真正
  执行新 provider attempt 的 Loom retry / pg-boss redelivery 才重新 admission，replay/fence 不会。
- live DomainTool 内层 `runTask` 通过真实 outer task id 加入 same-lane session family，避免
  `maxConcurrency=1` 的 outer→tool→inner 自锁；一个 root 只允许一条 active descendant chain 共享
  槽，parallel sibling 必须等待或占新 root，parent 先结束则 active child 接管槽。异 lane独立
  acquire，每个 child 都计 start reservation。
- admission wait/release 使用 monotonic caller deadline、短 DB `lock_timeout` / `statement_timeout`、
  有界退避与 lane-local single-flight；runner retry 共用首次 attempt 的绝对 elapsed deadline。
- rollout 只承诺 central Agent SDK session，不冒充逐 HTTP request 或全产品出站治理。DashScope、
  Mem0、direct GLM/OCR、Tencent OCR 与 preflight inventory 明确留作独立 follow-up。
- 本轮只做代码编辑、独立只读审阅、formatter 与静态 diff 检查；**未运行任何本地
  test/typecheck/lint/build/audit gate**。

## NEXT

1. 收口当前真实 diff 的独立 runtime/DB/retry/rollout review，只修 P0/P1。
2. 提交、推送并开 YUK-842 PR；migration/unit/DB/typecheck/lint/build/audit 只由 exact-head GitHub
   CI 执行。
3. CI 全绿且无 unresolved P0/P1 后 merge，Linear YUK-842 → Done。
4. 按 runbook 先全 app/worker `off → observe`，取得一个真实 provider admission + YUK-841 cost-basis
   observation；enforce 必须由 application-level normal drain 关闭旧 session。若 abort/kill/stop
   有歧义，则从 stop time 等 deployed max timeout + 30s；之后才可全进程同 policy 切换，不能滚动
   混用 observe/off。
5. Phase 0 exit 后启动 Phase 1 practice-owned failure-learning vertical；删除旧 knowledge/central
   handler/tool 双轨。

## PARKED

- YUK-845 non-runner outbound follow-up：DashScope embeddings、Mem0 GLM/embedding fan-out、direct
  GLM reconcile、GLM/Tencent OCR 与 support preflight 尚无统一 attempt identity/admission。
- wire-level HTTP RPM 需要 SDK transport/proxy seam；当前 `sdkQuery()` session 内可含 turns、nested
  agents 与 CLI retry，不能靠 runner seam证明逐请求限制。
- YUK-843：stuck-run reconcile 单行异常隔离；YUK-844：product-operation unknown cost 传播。
- YUK-832–836 actual-output P1 保持 open/PARKED；YUK-596 transport 已交付但内容质量 HOLD。
- YUK-813 / YUK-831 OpenCode 暂不处理；YUK-815 / YUK-816 等 active 主线重新排期。

## BLOCKED-ON

- YUK-842 merge blocked by exact-head CI 与 independent review；Phase 1 blocked by F0 exit gate。
- production enforce blocked by全调用进程同版本/同 policy、observe 证据、quiesce/drain 与 restore
  protocol；混合版本无法形成全局 cap。
- FULL 不触 UI；未来 UI 仍须 design-doc 逐字引用、组件类型与文件清单 pre-flight。
- 真实 provider observation 不能由 synthetic/mock/本地 gate 冒充。
