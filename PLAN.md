# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-827 响应签名 P0 收口】**
> YUK-796 / PR #1117 已合并。当前唯一 active lane 是 YUK-827：Probe 不再被
> “只能二元选择”约束，而是要求任一响应形式都能区分正确理解、目标误区与其他错误。

## NOW

- **唯一 active lane：YUK-827 响应签名可诊断性。**
  - branch：`codex/yuk-827-response-signature`。
  - worktree：`the-learning-project-worktrees/yuk-827-response-signature`。
  - Probe V2 支持单选、多选、短答、答案加理由与构造题；拒绝正确响应和目标误区
    响应签名相同、仅靠随机猜测才能区分、或实际题面不支持声明响应形式的题包。
  - QuestionAuthor/Reviewer 使用最多两轮整包生成、独立求解和 fail-closed 结构校验；
    历史 V1 可读，新 proposal 只能写 V2。
  - 单题 Judge 在同一次真实 Judge 调用中同时判断答题结果与目标误区匹配；普通答错
    不再推进 conjecture。V2 快照缺失、漂移或不可判定时拒绝写事件。
  - cutover migration 只退休迁移前仍 pending 的 agent conjecture；owner dismissal
    语义不被改写。
- **开发 gate 已过**
  - 固定 8 个 mock 输入继续走真实生产编排、prompt 与 parser；模型输出不 mock。
  - 入选结果为 7/8 grounded（87.5%），严重事实错误 0，claim/probe 错配 0；
    余下 chain case 因无语义共识安全 abstain。
  - 当前代码重新解析 7 个入选 proposal 全部通过 V2 schema/structure。
  - targeted unit 273、DB 103、migration 1、typecheck 与 prompt snapshot audit 全绿。
  - 完整 gate 不在本地跑；提交后只监听 exact-head GitHub Actions `CI Gate`。

## NEXT

1. 提交 YUK-827，开 ready PR，监听 exact-head `CI Gate` 并清零 review threads。
2. CI 与 review 全绿后 squash merge，Linear YUK-827 对齐 Done。
3. 恢复 YUK-791 implementation lane；先 rebase main，并把其尚未合并的 migration
   从 `0084` 重新编号，避免与 YUK-827 冲突。
4. YUK-791 按既定依赖顺序实现 Agency intervention contracts/persistence →
   recommendation → intervention-scoped QuestionAuthor；UI 另做 pre-flight。

## PARKED

- **YUK-822：P1 学科确定性验证器（owner 明确本轮不实现）**
  - 只保留详细通俗解释与计划：
    `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
  - 首批候选为数学复合单位分母变换与异分母分数相加；subject-owned registry，
    不在 Agency 写中央学科 switch；parser 不可判定时 fail closed。
- **YUK-826 第二波 DB 测试事务迁移**：Backlog；收益需多次 GitHub CI 数据验证。
- **YUK-820 live timing**：继续用普通 server/API PR 验收 affected-selector 命中率。
- **干预准备/结算/协作档案**：YUK-791、YUK-792、YUK-815、YUK-816；按 mesh
  依赖顺序推进。
- **YUK-824 本地 lint 假红**：sanctioned `.ykv/**` cache 精确忽略是独立线。

## BLOCKED-ON

- **YUK-814 真实 owner 发布闸门**：Gate A/B/C 仍未全过；mock 输入/真实模型输出只证明
  开发回归质量，不能替代真实 owner/cohort shadow、blind 与 canary。
- **auto-intervention 扩大使用**：保持 OFF；开发可继续，但未获得真实发布证据前不得扩量。
- **canonical Opus 输出质量**：OAuth 周额度仍可能 429；开发比较沿用受支持的
  Xiaomi/Mimo fallback，429 只记 operational，不冒充质量 pass/fail。
