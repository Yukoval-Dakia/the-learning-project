# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-821 P0 输出回归驱动第二轮收口】**
> Owner 裁决：质量评测只 mock 输入，输出必须走真实模型/生产链；相对固定旧基线有
> 净改善即可关闭开发 gate。真实 owner 数据只决定是否扩大自动干预。P1 学科确定性
> validator 本轮不实现。

## NOW

- **唯一 active implementation lane：YUK-821 / PR #1114。**
  - audit v2 已绑定 reviewer 实际看过的 frozen hypothesis、完整题包和非空
    author/reviewer task-run lineage；0083 在 v2 producer 启动前退出全部 pre-binding
    pending conjecture，避免在 SQL 中复制易漂移的 Zod 子集。
  - accept 对 audit、最终 claim/DiagnosticSpec/evidence/题包做一致性校验；完整结构比较
    对未来 schema 字段 fail closed，不再依赖会漂移的手写字段表。
  - 固定 8-case 首轮 Xiaomi/Mimo fallback 复测仅 grounded 5/8；按真实失败增强 prompt
    后，第二轮达到 **7/8**（旧基线 6/8），严重事实错误/学科幻觉维持 0，开发 gate
    按 owner 口径通过。
  - P0 author/reviewer prompt 已按真实失败增强：单选逐项独立求解、必须恰好一个正确；
    reference 自承认多解或条件/步骤/结论矛盾一律 `reference_incorrect`。这不是 P1
    学科确定性 validator。
  - 文言簇仍有 1 个“错误规则导致无法选/随机选，expected answer 不可唯一判定”尾项；
    已捕获为 **YUK-827**，不阻塞已达成的净改善 gate，也不冒充绝对 5/5。
- **开发/发布闸门**
  - 本地只跑变更相关 unit/DB/migration/typecheck/Biome；完整 gate 只监听 GitHub CI Gate。
  - PR #1114 后续 exact head `bcb29a0f` CI Gate 全绿；连续 review 证明逐字段 SQL
    validator 会不断漂移，最终收敛为部署序保证的 pre-binding 全量 cutover。

## NEXT

1. 提交最终 pre-binding cutover batch，回复/清零 review threads，监听新的 exact-head CI。
2. CI 全绿后 squash merge PR #1114；更新 YUK-821 为 Done，并把 7/8 结果同步 YUK-814。
3. 按 mesh 依赖选择下一条 ready phase issue，进入下一阶段开发；YUK-827 保持独立 backlog。

## PARKED

- **YUK-822：P1 学科确定性验证器（本次不写代码）**
  - 详细计划：`docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
  - 首批才会做数学复合单位分母变换与异分母分数相加；subject-owned registry，
    不在 Agency 写中央学科 switch；parser 不可判定时 fail closed。
- **YUK-825 已 Done**：PR #1115/#1116 已进 main；DB 测试可 opt-in 单连接事务 rollback，
  并发/跨连接/pg-boss/advisory lock/identity 断言继续 full reset。
- **YUK-826 第二波 DB 测试事务迁移**：Backlog；首波全 shard aggregate 仅约 -2.1%，
  后续必须用多次 GitHub CI 数据，不用单次 wall-clock 冒充收益。
- **YUK-820 live timing**：继续用普通 server/API PR 验收 affected-selector 的真实命中率。
- **干预准备/结算/协作档案**：YUK-791/796、YUK-792、YUK-815、YUK-816；按 mesh
  依赖顺序推进。
- **YUK-824 本地 lint 假红**：sanctioned `.ykv/**` cache 精确忽略是独立线。

## BLOCKED-ON

- **canonical Opus 输出质量**：当前 OAuth 周额度仍返回 429；只记 operational，不能冒充
  质量 pass/fail。开发比较使用与旧基线相同的 supported Xiaomi/Mimo fallback。
- **auto-intervention 扩大使用**：仍需真实 owner/cohort shadow/blind/canary；这是发布/扩量
  条件，不是继续开发的前置条件。
