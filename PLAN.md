# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-829：FULL intervention reviewer 收口】**

## NOW

- **唯一 active implementation lane：YUK-829。**
  - branch：`codex/yuk-829-intervention-reviewer`；Draft PR：#1139。
  - FULL 已复用通用 `SolutionGenerateTask` + `QuizVerifyTask`：三题逐题盲解、
    `release_strict` factual grounding、服务端密封因果 occurrence、比较审查与第二次
    pass confirmation；provider 的 verdict/failure labels 不再是裁决权威。
  - current audit protocol 为 V3：保存每个 solver/content/comparator attempt 的 canonical
    input、prompt fingerprint、result/null digest 与 task-run ID；activation 和 actual-output
    eval 均重建 canonical input 后再核对。
  - 本地 scoped 证据已通过：相关 unit 190 项、DB 100 项、typecheck、lint、pre-PR
    audits、build。按仓库规则未在本机运行完整 `pnpm test`。
  - 合并前仍以 PR #1139 上的干净 exact-head 六案例真实 MiMo 结果和 GitHub CI Gate
    为最终状态源，不在本看板复制可能过期的运行状态。
- **Linear 只读快照（2026-08-01）：**19 projects、831 issues；未完成 93 =
  85 Backlog + 7 In Progress + 1 Todo。唯一显式 blocker 为 YUK-829 → YUK-814。

## NEXT

1. 在干净提交 HEAD 上跑六案例真实 MiMo actual-output，检查 6/6、false canary、
   provenance、usage/cost 与 exact revision。
2. push 后只用 exact-head GitHub CI 执行完整 `pnpm test`；修完 P0/P1 后合并并关闭
   YUK-829。
3. 解锁但不直接关闭 YUK-814：跑 fresh、prospectively scoped 的 10 个真实产品
   lifecycle + 10 次 post-review + stop-switch/zero-redline 证据。
4. 推进 human-in-loop 产品门：YUK-571 首次真实 placement；YUK-405/YUK-406 两周
   owner 使用验收；再处置 YUK-452、YUK-776。
5. 对剩余 backlog/Todo 做 product-scope triage：有 live consumer 的执行，无 live
   consumer/重复/过期项明确 Canceled 或 Duplicate，parent 在 children 处置后关闭。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；可从产品执行队列排除，
  但不能从 Linear 严格 issue=0 统计中消失。
- **YUK-815 / YUK-816**：等待 YUK-829/YUK-814 grounding gate 成为可读真相源。
- 其余 future/refinement backlog 不自动开 implementation lane，先经 owner scope triage。

## BLOCKED-ON

- **YUK-814 / auto-intervention 扩量**：先合并 YUK-829，再满足 owner 10-run 真实观察门；
  synthetic/mock/harness 不能替代 canonical product gate。
- **严格 issue=0**：当前还需处置全部 93 张未完成 issue；即使暂不管两张 OpenCode，
  产品聚焦口径仍有 91 张。不能把“不在当前 lane”写成完成。
