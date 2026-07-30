# 当前 handoff — 2026-07-30

## Active line

- 唯一 active lane：**YUK-828 自动 review advisory 化与轮次预算**。
- branch：`codex/yuk-828-review-budget`。
- worktree：`.codex/worktrees/9d89/the-learning-project`。
- 基线：`origin/main@a36e122d`，已包含 YUK-791 / PR #1119。
- Linear YUK-828：In Progress。

## 本轮实现

1. `.github/workflows/ocr-codex-review.yml` 移除 `synchronize` 自动触发，仅保留 PR 首次
   可审事件与 merge learnings 收集。
2. OCR 增加 `workflow_dispatch.pr_number` 手动验证入口；统一通过 GitHub API 获取当前
   base/head，并拒绝 draft、fork、Dependabot。
3. `.github/workflows/pr-agent-glm.yml` 同样移除 `synchronize`，两个 review job 名称明确
   标注 advisory。
4. 首轮独立 review 发现 reopened/ready lifecycle 可重复初审；现已移除 reopened，并为
   OCR review 与 PR-Agent guide 增加已完成初审的跨事件幂等检查。只有显式 OCR manual
   dispatch 可绕过初审锁。
5. 唯一验证轮发现 OCR summary-only 路径只写 issue comment；OCR 幂等检查现同时识别
   tagged pull-request review 与 tagged issue summary。按预算不再启动第三轮 review。
6. 最终 push 后的迟到 Major 指出 manual dispatch 仍可无限触发；入口现要求初审已完成、
   `kind=verification` 尚不存在。后续复审必须显式 `owner_override=true`，并在 review/
   summary tag 中留下 owner_override 类型。
7. 后续 P1 指出 OCR 正文可包含 `kind=verification` 字样；现只从 HTML marker 解析类型，
   并要求 PR 仍 open、override actor 等于 repository owner。此后不再启动 review 修复轮。
8. `AGENTS.md`、`CLAUDE.md` 与两份 PR skill 统一 review budget：一轮初审 + 最多一轮
   P0/P1 修复验证；P2/minor/nit 默认不阻塞、不触发新 push。
9. exact-head `CI Gate` 明确为自动硬 gate；无未裁决 P0/P1 时不等待 advisory review
   pending/failure/cancel/timeout。

## 验证证据

- Ruby YAML parser：OCR / PR-Agent workflow 均 PASS。
- trigger/advisory/manual-input 专项静态断言 PASS。
- lifecycle 初审幂等专项断言 PASS。
- `git diff --check` PASS。
- docs invariant：1 file / 6 tests PASS。
- Biome 对本次 Markdown/YAML 处理 0 files，因此不计作有效验证。

## 下一步

1. commit/push 并创建 YUK-828 ready PR。
2. 只消费一轮自动初审；P2/minor 回复 rationale 后 resolve，不 push。
3. 如修复 P0/P1，最多手动 OCR 验证一次；同时等 exact-head `CI Gate`。
4. gate 通过后 squash merge并把 YUK-828 更新为 Done。
