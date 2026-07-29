# 当前 handoff — 2026-07-30

## Active line

- 唯一 active lane：**YUK-821 P0 严格收口**，PR #1114。
- worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-821-probe-quality`
- branch：`codex/yuk-821-p0-audit-bind`。
- owner 主工作树有既存未提交改动；本轮未修改主工作树。
- Owner 决策：只 mock 输入，输出必须来自真实模型/生产任务链；真实 owner 数据只控制
  扩大使用，不阻塞开发。本地不跑完整 CI，只监听 GitHub Actions `CI Gate`。
- main 并行合入 YUK-825 PR #1115/#1116；本分支正在普通 merge `origin/main`，不 rebase、
  不 force push。新的 DB 事务测试隔离合同保留。

## 为什么 P0 之前不能声称“全收”

复审确认三个可复现审计缺口：

1. v1 `probe_quality` 没保存 reviewer 实际看过的题包，可把通过 audit 贴到另一题包。
2. v1 passed audit 允许 author/reviewer task-run id 为 null，lineage 不完整。
3. 首轮 v2 只绑定题包，未绑定 reviewer 同时审查的 frozen hypothesis；替换 claim、
   DiagnosticSpec 或 evidence refs 后仍可能复用旧 verdict。

## 已实现

1. `probe_quality` v2 保存独立 `reviewed_hypothesis`、`reviewed_package`；v1 只读历史。
2. schema、proposal、accept 核对 claim、DiagnosticSpec、ordered evidence ids、错因/KC、
   双题和 `predicted_p`；完整 JSON 结构比较包含未知/未来字段，schema 演进 fail closed。
3. passed 最终尝试强制非空 author/reviewer task-run id；缺 lineage 按 operational failure
   重试，不能形成可接受 audit。
4. accept 外层统一 409 `CONJECTURE_PROBE_QUALITY_REQUIRED`；
   `probe_quality_audit_unbound`、`probe_quality_package_mismatch` 等只在 message 里细分。
5. 0083 migration 用 agent-authored correction 退出 pending 的 v1、缺 lineage、hypothesis
   或题包错配；empty scopes、非空 ingest_at、不伪造 owner dismiss。
6. typed API 已生成；P1 subject deterministic validators 未实现。

## 固定 8-case 首轮新版本结果

- canonical Opus 三次 induction 仍为 429 weekly limit：operational stop，无质量结论。
- 改用与旧基线一致的 supported Xiaomi/Mimo fallback；输入仅 mock，输出走 production
  `induce → author → independent review`，完成 8 个固定簇。
- 严格评分仅 grounded 5/8：
  - 单位分母时间错法已精准命中，原 claim/probe mismatch 消失；
  - 异分母加法因 no semantic consensus 正确 fail-closed abstain；
  - 链式法则单选 B/C 等价且都正确；文言单选 A/C 都正确，reviewer 却判 pass。
- 因此没有宣告 gate 通过。commit `888ec2ee` 已增强 P0 author/reviewer：单选逐项解答、
  恰好一个正确；reference 自承认多解或内部矛盾一律 `reference_incorrect`。仍不冒充 P1。

## 固定 8-case 第二轮结果

- exact head `1a9df7c6`、同一 8 输入、同一 Xiaomi/Mimo fallback 与 production
  `induce → author → independent review` 链完成。
- 严格 grounded **7/8**，高于旧基线 6/8；claim/probe mismatch 仍为 1；严重事实错误 0，
  学科幻觉 0。按 owner“有净改善即过开发 gate”的口径，YUK-821 开发 gate PASS。
- 新 reviewer 正确拒绝并重生成了：
  - 移项题中目标错误答案不在选项、reference 自相矛盾的包；
  - 比的顺序题超出 scope 去要求化简的包；
  - 文言首包 context/representation 不独立。
- 唯一未 grounded 的文言最终 primary：目标错误会让四个选项看起来同类，输出却写
  “A/B/D 任一或随机选”，不是 Judge 可稳定识别的具体响应。已捕获 **YUK-827**；
  gate 通过不等于 P0 绝对 5/5。

## 当前定向验证

- unit：6 files / 204 passed。
- DB：conjecture accept 26 passed。
- migration：0083 case 1 passed / 27 skipped。
- `pnpm typecheck`、changed-file Biome、`git diff --check` 通过。
- OCR 三个 review threads（strict null、完整结构比较）已修复并回复/resolve。
- exact head `1a9df7c6` GitHub CI Gate 与 OCR 已全绿。
- 后续 review 抓到 0083 漏校验 outer `probe_md`/reference 与 nested spec 一致，会留下
  永久 409 pending 卡片；已补四种 mismatch migration 回归。另记录 evidence order
  invariant，并复用同一 audit attempts copy。最终新 head 仍需 GitHub CI。

## 下一步

1. 提交/推送最终 review batch，回复并 resolve 4 个新 review threads。
2. 监听新 exact-head GitHub CI Gate；全绿后 squash merge PR #1114。
3. YUK-821 Done、YUK-814 记录 7/8 mock-input 开发 gate；YUK-827 保持 backlog。
4. 按 mesh 选择下一条 ready issue，进入下一阶段开发。
