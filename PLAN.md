# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-796 教学法审议设计收口】**
> YUK-821 / PR #1114 已合并；固定 mock-input / real-output 回归从 6/8 改善到
> 7/8，开发继续。当前唯一 active lane 转为 YUK-796：选定 Agency 同波次内部审议，
> 不建独立 Planning Panel，不新增 agent 席位。

## NOW

- **唯一 active lane：YUK-796（设计票，无生产实现）。**
  - 文档：`docs/design/2026-07-30-yuk-796-pedagogy-deliberation.md`。
  - 推荐：`prepare_intervention(intervention_id)` 内部串行完成 deterministic shortlist →
    recommendation → YUK-791 QuestionAuthor → 同模型第二次独立自审 → 原子激活。
  - 复用现有 8 法 palette/policy 作为合法候选边界；最终推荐不能恢复被排除方法。
  - 真实消费者是同 wave 的 intervention-scoped QuestionAuthor；recommendation 不能单独
    成为新的 dead rail。
  - Planning 控制区放进 Teaching Brief projection，不建独立系统。
  - anti-swarm：不新增 agent seat，不恢复 planner/critic/judge fan-out。
- **P0/发布现实**
  - YUK-821 Done：PR #1114 merge `f3159ae5`，exact-head GitHub CI Gate 全绿。
  - 固定 8-case 为 7/8；YUK-827 保留唯一 P0 tail，所以不声称绝对 5/5。
  - YUK-814 严格 Gate A/B/C 仍未全过；开发继续，但 auto-intervention expansion 保持 OFF。

## NEXT

1. 提交 YUK-796 design + ADR/cockpit batch，开 PR。
2. 只监听 GitHub CI Gate；独立 review/thread 清零后 squash merge并把 YUK-796 置 Done。
3. 下一 implementation lane 为 YUK-791：先做 Agency intervention contracts/persistence，
   再做 recommendation 与 intervention-scoped QuestionAuthor；UI 另做 pre-flight。

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
