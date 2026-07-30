# 当前 handoff — 2026-07-30

## Current state

- 当前没有 active implementation lane。
- YUK-828：Done。
- implementation PR：#1120，merge `52c08b8e`。
- implementation branch：`codex/yuk-828-review-budget`，remote 已随 merge 删除。
- closeout branch：`codex/yuk-828-closeout`。

## 已交付

1. OCR / PR-Agent 移除 `synchronize` 自动复审；只在 PR opened / ready_for_review 时运行，
   job 名称显式 advisory。
2. 自动初审跨 lifecycle 幂等。OCR 识别 tagged pull-request review 与 summary-only issue
   comment；PR-Agent 识别既有 reviewer guide。
3. manual OCR 只允许在初审后运行一次 verification；后续必须 repository owner 显式
   `owner_override=true`。类型写入 review/summary HTML marker。
4. verification 状态只从 marker 解析，正文无法伪造；closed PR、非 owner override 被拒绝。
5. AGENTS、CLAUDE 与两份 PR skill 统一 review budget：一轮初审 + 最多一轮 P0/P1
   验证；P2/minor/nit 默认回复理由并 resolve，不触发 push。
6. exact-head `CI Gate` 是自动硬 gate；advisory review pending/failure/cancel/timeout 不阻塞。

## 验证与 review

- YAML parse、trigger/lifecycle/manual-budget/marker 专项断言、`git diff --check` PASS。
- docs invariant：1 file / 6 tests PASS。
- PR exact-head `66f02435` CI Gate run 30556817265 PASS。
- main `52c08b8e` CI Gate run 30557755509 PASS。
- 已验证 P1 均修复并 resolve；最终 P2 marker-anchor hardening 回复不修并 resolve，未再 push。
- Linear YUK-828 自动完成并已写 closeout evidence。

## 下一步

- owner 选择下一条 issue/lane 后再更新 cockpit；不要自行提前启动 YUK-792 或其他 parked lane。
