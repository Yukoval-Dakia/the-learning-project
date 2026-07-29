# 当前 handoff — 2026-07-29

## Active line

- 唯一 active lane：**YUK-821 P0 严格收口**。
- 隔离 worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-821-probe-quality`
- branch：`codex/yuk-821-p0-audit-bind`，基于已合并 PR #1110 的 `origin/main`。
- owner 主工作树有既存未提交改动；本轮未修改主工作树。
- Owner 决策：只 mock 输入，输出必须来自真实模型/生产任务链；真实 owner 数据只控制
  扩大使用，不阻塞开发。本地不跑完整 CI，提交后只监听 GitHub Actions `CI Gate`。

## 为什么 PR #1110 合并后 P0 仍不能声称“全收”

复审确认三个可复现缺口：

1. v1 `probe_quality` 只证明某次 review 返回 pass，没有保存 reviewer 实际看到的题包。
   因此把一个通过 audit 贴到另一个结构合法的题包上，accept 仍可能放行。
2. v1 成功 audit 允许 `author_task_run_id` / `reviewer_task_run_id` 为 null，不能满足完整
   lineage 与可追溯要求。
3. 首轮 v2 只绑定题包，没有绑定 reviewer 同时审查的 frozen hypothesis；替换 claim、
   DiagnosticSpec 或 evidence refs 后仍可能复用旧 verdict。PR review 已指出并在同批修复。

旧 8-case 真实输出复评也尚未完成：此前 canonical Opus 在第一簇三次 induction 都收到
429 weekly limit；这是 operational stop，不是质量结果。

## 本轮实现

1. `probe_quality` 增加 v2；v1 仅保留历史可读性。
2. v2 保存与返回对象分离的 `reviewed_hypothesis`、`reviewed_package` 快照；schema、
   proposal 与 accept 逐字段核对 claim、DiagnosticSpec、证据事件、错因/KC、双题和
   `predicted_p`。
3. v2 最终 passed attempt 强制非空 author/reviewer task-run id；生产链若缺 lineage，按
   operational failure 重试，不能产生可接受 audit。
4. accept 对 v1 返回 `probe_quality_audit_unbound`，对错贴题包返回
   `probe_quality_package_mismatch`；历史已接受记录仍先走幂等短路。
5. 新迁移 `0083_yuk821_bind_probe_quality_audit`：agent-authored correction 收口 pending
   的 v1、缺 lineage、hypothesis 或题包错配记录；empty scopes、非空 ingest_at、不写
   owner dismiss。
6. OpenAPI typed client 已重新生成；P1 subject deterministic validators 仍未实现。

## 当前定向验证

- unit：6 files / 192 passed；核心 schema/producer 小集合另跑 3 files / 90 passed。
- DB：3 files / 42 passed；accept 单文件复跑 25 passed。
- migration：0083 case 1 passed / 27 skipped。
- `pnpm typecheck` 通过。
- 完整 gate 未在本地跑，按 owner 决策留给 GitHub Actions。

## 下一步

1. changed-file Biome、API generation drift、diff check 收尾。
2. 一次提交/推送并创建 YUK-821 收口 PR；只监听 exact-head GitHub CI Gate，处理 review。
3. 合并后在 main 重跑固定 8-case mock-input/真实-output；相对旧基线有改善即通过开发 gate。
4. 通过后对齐 Linear 并进入 mesh 中下一条 ready phase issue。
