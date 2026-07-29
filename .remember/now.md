# 当前 handoff — 2026-07-29

## Active line

- 当前唯一 active lane 是 **YUK-821 P0：Conjecture probe pair 质量守卫**。
- 隔离 worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-821-probe-quality`
；branch `codex/yuk-821-probe-quality`。
- PR **#1110**：`https://github.com/Yukoval-Dakia/the-learning-project/pull/1110`；
  exact head 将以本 handoff 更新后的 commit 为准。
- owner 主工作树已有既存未提交改动；本轮没有修改主工作树。
- Owner 决策：质量评测只 mock 输入，输出必须来自真实生产链/真实模型；真实 owner
  数据只控制扩大使用，不阻塞开发。

## P0 已实现

1. `MindModelInductionTask` 只输出 claim + 冻结 `DiagnosticSpec`，不再同时写题。
2. N=3 自洽比较完整 claim + trigger/scope/target-error signature，不再只比较一句 claim。
3. 新增独立 `ConjectureProbeAuthorTask` 与 `ConjectureProbeReviewTask`；两者走 canonical
   Opus，同模型但分开的调用。
4. 通用确定性结构门检查双题不是文本变体、context/representation 均不同、gold 与目标
   错误答案不同。
5. 第一次质量失败丢弃整包并重生成；第二次质量失败
   `abstain(no_discriminating_probe)`。provider/结构化输出故障保持 operational 并交给
   worker 重试，不能冒充质量反对票。
6. nightly 与 agent-led director 复用同一质量门。proposal 保存 DiagnosticSpec、双题
   spec、author/reviewer task run、失败码与 audit。
7. accept 对缺失/伪造/不一致 v3 包返回 409
   `CONJECTURE_PROBE_QUALITY_REQUIRED`；历史已接受记录仍可幂等读取。
8. grounding blind artifact 展示 DiagnosticSpec 与预期目标错误答案；private lineage
   保存质量尝试。
9. 旧 v1/v2 pending 猜想由数据迁移写入 agent-authored `correct(retract)` 退出 pending；
   不写 owner `rate(dismiss)`，避免污染接受/拒绝偏好信号。
10. Director 质量门要求每个 evidence ref 都能从会议快照完整物化成文本失败
    attempt/review；缺题目快照、图片/图形或其它事件类型均失败关闭。

## 验证与未决验收

- 定向 unit：6 files / 212 passed。
- 定向 DB：4 files / 70 passed。
- `pnpm typecheck`、changed-file Biome、`git diff --check` 已通过。
- review 修复增量：unit 2 files / 61 passed；DB 2 files / 29 passed；收到远端首轮
  migration smoke 失败后，仅定向复现并修复 fixture 的 jsonb 写法，YUK-821 migration
  case 1 passed（其余 26 skipped）。完整 migration gate 仍只在 GitHub 执行。
- 按 owner 决策不在本机跑完整 CI gate；提交后只监听 GitHub Actions `CI Gate`。
- 2026-07-29 20:47 以 8 个 mock failure inputs 启动 canonical real-output 复评；第一簇
  的 3 个独立 Opus induction 调用全部收到 HTTP 429 weekly limit，因此按 operational
  stop condition 停止。没有用 Mimo fallback 或空输出来伪造 pass。
- YUK-821 在 canonical 8 簇真实输出满足 grounding ≥80%、mismatch=0、
  severe factual error=0 前保持 In Progress。

## P1 明确未实施

- 学科确定性 validators 只写了详细通俗设计：
  `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
- Linear 已创建 **YUK-822**（Backlog / Medium）：先实现数学的复合单位分母变换和
  异分母分数验证器；包括 versioned provenance、mutation tests、
  shadow→blocking 与 kill switch。
- 本分支没有 `SubjectProbeValidator`、数学 parser、schema v2 或 P1 blocking flag。

## 下一步

1. 提交并推送两条 review finding 的修复，回复并 resolve 对应 threads。
2. 只监听 PR #1110 最新 exact head 的 GitHub Actions `CI Gate`。
3. CI 与 review 全绿后合并 P0，但保持 YUK-821 In Progress。
4. canonical Opus 配额恢复后重跑固定 8 簇；只有输出门通过才关闭 YUK-821。
