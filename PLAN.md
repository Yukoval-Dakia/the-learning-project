# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-828 review budget 止损】**
> YUK-791 / PR #1119 已合并。当前唯一 active lane 是 YUK-828：自动 review 降为
> advisory，只在 PR 首次可审时运行；P2/minor 不再驱动 review→push→review 循环。

## NOW

- **唯一 active lane：YUK-828 自动 review advisory 化。**
  - branch：`codex/yuk-828-review-budget`。
  - worktree：`.codex/worktrees/9d89/the-learning-project`。
  - OCR 与 PR-Agent 不再监听 `pull_request.synchronize`；只在 opened /
    ready_for_review 初审。OCR 保留带 `pr_number` 的 `workflow_dispatch` 手动验证入口。
  - 首轮 review 发现 lifecycle 事件仍可重复初审；现已移除 reopened，并在 OCR review
    与 PR-Agent guide 写入后做跨事件幂等检查。只有显式 OCR manual dispatch 绕过初审锁。
  - 唯一验证轮发现 OCR summary-only 路径不创建 pull-request review；幂等检查现同时
    识别 tagged review 与 tagged issue summary，关闭该漏口。按预算不再启动第三轮 review。
  - 最终 push 后的迟到 Major 指出 manual dispatch 可无限触发；入口现要求已有初审且尚无
    `kind=verification`，后续复审只有显式 `owner_override=true` 才允许，并在产物 tag 留痕。
  - 后续 P1 指出正文 substring 可能伪造 verification；现只解析 OCR HTML marker，并要求
    PR 仍 open、`owner_override` actor 等于 repository owner。此后不再启动 review 修复轮。
  - 两个 review job 名称显式标注 advisory；OCR 手动入口统一从 GitHub API 解析并验证
    当前 PR/base/head，拒绝 draft、fork 与 Dependabot。
  - agent/Claude PR policy 统一为最多一轮初审 + 一轮 P0/P1 修复后的验证审；push 后新 bot
    review 不重置预算，除非 owner 明确要求，不开第三轮。
  - 只修 security / data loss / correctness / release blocker 等已验证 P0/P1；P2/minor/nit
    默认回复 rationale 后 resolve，只有实质且可执行的去重 follow-up 才进 Linear。
  - exact-head `CI Gate` 是自动硬 gate；没有未裁决 P0/P1 时，不等待或重跑 advisory review
    的 pending / failed / cancelled / timeout。
- **本地静态验证已过**
  - Ruby YAML parser：2 个 workflow PASS。
  - workflow trigger/advisory/manual-input 专项断言 PASS；`git diff --check` PASS。
  - lifecycle / summary-only / single-verification budget 修正后的 workflow 专项断言 PASS。
  - `tests/integration/audit-docs-invariant.test.ts`：6/6 PASS。
  - Biome 不处理本次 Markdown/YAML 文件；其 0-file 输出不计作有效验证。

## NEXT

1. commit/push YUK-828，创建 ready PR。
2. 只消费一轮自动初审；修复已验证 P0/P1，P2/minor 回复理由后 resolve，不 push。
3. 如确有 P0/P1 修复，最多手动触发一次 OCR 验证；同时监听 exact-head `CI Gate`。
4. CI 绿色且无未裁决 P0/P1 后 squash merge，Linear YUK-828 对齐 Done。

## PARKED

- **YUK-822：P1 学科确定性验证器（owner 明确本轮不实现）**
  - 只保留详细通俗解释与计划：
    `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
- **YUK-792：延迟/迁移 scheduler 与 intervention outcome settlement**；不混入 YUK-828。
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
