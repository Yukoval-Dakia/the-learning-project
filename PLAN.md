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
- YUK-842 原始 admission PR #1157 已 merge（main `34af0f75`）；本地 prompt/config 物化冷启动修复
  PR #1158 也已 merge（main `c76ccf57`），两次均为 exact-head CI 全绿且独立审查无 P0/P1。
- production app/worker 已同镜像运行 `observe`，migration 0088 已应用，健康且 restart=0。两次真实
  API observation 都保护了用户结果，但揭示 SDK `query()` 内 CLI spawn/initialize 仍会同步阻塞
  event loop 约 16.2s，超过原 15s lease；因此尚未切 `enforce`，Linear YUK-842 保持 In Progress。
- 当前修复位于 worktree
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-842-startup-lease`、branch
  `codex/yuk-842-startup-lease`：本地 prompt/options 先物化；admission 后用 SDK `startup()` 在 45s
  initial lease 内完成不发送 prompt 的 initialize；随后用 claim-token CAS 显式切到 15s steady lease，
  重新栅栏 lease/cancel/deadline，才创建 `ai_task_runs`、启动剩余 model timer，并调用一次
  `WarmQuery.query()`。
- 40s SDK initialize timeout 与 45s initial lease、15s steady/renewal horizon、5s heartbeat、
  startup + execution + abort-grace hard reclaim 和 lease protocol v2 全进入 policy fingerprint。同步 event-loop stall 后的
  provider-start assert、unused warm CLI/active Query cleanup、stream cancel 均 fail-closed 收口。
- Hono 组合根为每个已鉴权 API request 创建同一个 90s absolute provider-session deadline；request 内
  所有 central runner 的串行、并行与嵌套调用自动取 request/caller 较早 deadline。Copilot 用同一 kernel
  预算生成显式 fallback 并传给 classifier、teaching/free-form 主调用及 nested task；生产仍取更早的
  request scope。SDK 完成后再次栅栏 lease/abort/deadline；durable worker 无 HTTP scope，预算不变。
- live DomainTool 内层 `runTask` 通过真实 outer task id 加入 same-lane session family，避免
  `maxConcurrency=1` 的 outer→tool→inner 自锁；一个 root 只允许一条 active descendant chain 共享
  槽，parallel sibling 必须等待或占新 root，parent 先结束则 active child 接管槽。异 lane独立
  acquire，每个 child 都计 start reservation。
- admission wait/release 使用 monotonic caller deadline、短 DB `lock_timeout` / `statement_timeout`、
  有界退避与 lane-local single-flight；runner retry 共用首次 attempt 的绝对 elapsed deadline。
- rollout 只承诺 central Agent SDK session，不冒充逐 HTTP request 或全产品出站治理。DashScope、
  Mem0、direct GLM/OCR、Tencent OCR 与 preflight inventory 明确留作独立 follow-up。
- 本轮只做代码编辑与静态只读检查；**未运行任何本地 test/typecheck/lint/build/audit gate**。

## NEXT

1. 提交并推送 startup/WarmQuery 修复；所有 unit/DB/typecheck/lint/build/audit 仅由 exact-head
   GitHub CI 执行，本地不跑 gate；并行做独立只读审查。
2. exact-head CI 全绿且无 unresolved P0/P1 后 merge；确认 AI jobs/pg-boss 空闲，再只重建 app/worker，
   继续保持同一 `observe` policy。
3. 冷启动后分别取得一个真实 API-originated 与 worker-originated session：startup > 原 15s 时仍有
   heartbeat、无 lease_lost，durable attempt/model timer 在 startup 后开始，最终 released/cost truth
   闭合。证据干净后 YUK-842 → Done；仍不在本轮直接切 `enforce`。
4. PR #1154 的旧 head CI 全绿但与 YUK-840/841/842 冲突，且真实 A01 仍在 comparator timeout 后
   `failed_closed`。先部署 YUK-842 的确定 merge image；随后把 #1154 语义合并到最终 runner、跑新
   exact-head CI 后收进 main，但保持 YUK-832 产品 HOLD，不随 admission rollout 部署。
5. Phase 0 exit 后启动 Phase 1 practice-owned failure-learning vertical；删除旧 knowledge/central
   handler/tool 双轨。

## PARKED

- YUK-845 non-runner outbound follow-up：DashScope embeddings、Mem0 GLM/embedding fan-out、direct
  GLM reconcile、GLM/Tencent OCR 与 support preflight 尚无统一 attempt identity/admission。
- wire-level HTTP RPM 需要 SDK transport/proxy seam；当前 Agent SDK session 内可含 turns、nested
  agents 与 CLI retry，不能靠 runner seam证明逐请求限制。
- YUK-843：stuck-run reconcile 单行异常隔离；YUK-844：product-operation unknown cost 传播。
- YUK-832–836 actual-output P1 保持 open/PARKED；YUK-596 transport 已交付但内容质量 HOLD。
- YUK-813 / YUK-831 OpenCode 暂不处理；YUK-815 / YUK-816 等 active 主线重新排期。

## BLOCKED-ON

- Phase 1 blocked by YUK-842 startup hotfix 的 exact-head CI、独立审查、merge 与 app/worker 冷证据。
- production enforce blocked by全调用进程同版本/同 policy、observe 证据、quiesce/drain 与 restore
  protocol；混合版本无法形成全局 cap。
- FULL 不触 UI；未来 UI 仍须 design-doc 逐字引用、组件类型与文件清单 pre-flight。
- 真实 provider observation 不能由 synthetic/mock/本地 gate 冒充。
