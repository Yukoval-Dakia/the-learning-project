# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-828 review budget 已交付】**
> YUK-828 / PR #1120 已合并，PR exact-head 与 main merge commit 的 `CI Gate` 均全绿。
> 当前没有 active implementation lane；等待 owner 选择下一条独立工作线。

## NOW

- **YUK-828 已完成并对齐 Done。**
  - merge：`52c08b8e`（PR #1120）。
  - OCR 与 PR-Agent 不再监听 `pull_request.synchronize`；只在 opened / ready_for_review
    首次可审时运行，并显式标注 advisory。
  - OCR / PR-Agent 的初审跨 lifecycle 幂等；OCR 同时识别 tagged review 与 summary-only
    issue comment，只有显式 manual dispatch 可进入验证。
  - manual OCR 要求已有初审且尚无 `kind=verification`；额外轮次必须 repository owner
    显式 `owner_override=true`，review/summary tag 留下类型。verification 只从 HTML marker
    解析，正文不能伪造；closed PR 或非 owner override 被拒绝。
  - agent/Claude PR policy 为最多一轮初审 + 一轮 P0/P1 修复后的验证审；P2/minor/nit
    默认不阻塞，不触发新 push。exact-head `CI Gate` 是自动硬 gate。
  - 本 PR 的已验证 P1 全部修复并 resolve；最终 P2 marker-anchor hardening 明确回复不修并
    resolve，没有再 push，实际执行了新的 stop policy。
- **验证证据**
  - Ruby YAML parse、review lifecycle/manual-budget 专项断言、`git diff --check` 通过。
  - `tests/integration/audit-docs-invariant.test.ts`：6/6 PASS。
  - PR exact-head `66f02435`：CI Gate run `30556817265` 全绿。
  - main `52c08b8e`：CI Gate run `30557755509` 全绿。

## NEXT

1. owner 选择下一条独立 issue/lane 后，再将其标为唯一 active lane。
2. 后续 PR 直接执行 YUK-828 policy；不得因 P2/minor 或 advisory check 状态重启修复循环。
3. 若 owner 需要超过一次验证审，必须显式授权并使用可审计 override。

## PARKED

- **YUK-822：P1 学科确定性验证器（owner 明确本轮不实现）**
  - 只保留详细通俗解释与计划：
    `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
- **YUK-792：延迟/迁移 scheduler 与 intervention outcome settlement**。
- **YUK-815 / YUK-816：Copilot/Brief 协作与 Growth intervention projection**；等待
  准备链及验证结算链先成为可读真相源。
- **YUK-826 第二波 DB 测试事务迁移**：Backlog；收益需多次 GitHub CI 数据验证。
- **YUK-824 本地 lint 假红**：sanctioned `.ykv/**` cache 精确忽略是独立线。

## BLOCKED-ON

- **YUK-814 真实 owner 发布闸门**：Gate A/B/C 仍未全过；mock 输入/真实模型输出只证明
  开发回归质量，不能替代真实 owner/cohort shadow、blind 与 canary。
- **auto-intervention 扩大使用**：保持 OFF；YUK-791 已合并 shadow backbone，但未获得
  真实发布证据前不得把 `delivery_mode=eligible` 交付给 Today/B3。
- **canonical Opus 输出质量**：OAuth 周额度仍可能 429；429 只记 operational，
  不冒充质量 pass/fail。
