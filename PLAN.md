# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-791 干预准备通电】**
> YUK-827 / PR #1118 已合并。当前唯一 active lane 是 YUK-791：从真实、仍有效的
> target-error probe 结果创建 shadow intervention，并在同一 durable wave 完成方法推荐、
> 整包 QuestionAuthor、独立同模型自审与原子激活。

## NOW

- **唯一 active lane：YUK-791 干预准备闭环。**
  - branch：`codex/yuk-791-intervention-prepare`。
  - worktree：`the-learning-project-worktrees/yuk-791-intervention-prepare`。
  - Agency 持有 versioned intervention aggregate、不可变 snapshot、状态与所有写入；
    Practice 的公共 QuestionAuthor 只接受 `intervention_id`，经 Agency public reader 水合。
  - durable `experimental:probe_result` subscriber 只接受当前仍有效、可追溯到冻结 V2
    question 的 `evidence_for`，且 response judgement 必须明确命中 target-error signature；
    legacy、普通错答、被纠正或 provenance 漂移的结果 fail closed。
  - 8 法 palette 作为确定性 shortlist 真正通电；无安全方法直接 abstain。推荐必须在
    同一 prepare wave 被消费，不存在 dead recommendation 成功态。
  - 每包包含 1 份材料及 immediate/delayed/transfer 各 1 道 response-aware diagnostic；
    gold/target signature 必须可评分且彼此可区分。独立同模型自审后才激活，最多整包
    重生成一次；仍失败则 `preparation_failed`，不保存部分 package。
  - pg-boss 使用聚合体持久化的 UUID job id；重复投递返回 null 视为已存在，不制造
    第二个 aggregate。restore 会清掉 archived job id（包括同库仍残留的旧 terminal 行）；
    缺失的 operational job 最迟两分钟重建。当前 wave 耗尽 durable retry 的终态 job
    转为可审计 `preparation_failed`，不无限付费重排。recovery 与 subscription replay
    共用 source advisory lock，并在持锁后重查 liveness，不能产生两个付费 wave。
  - 任何付费调用前先验证 source probe/result/proposal/question direct chain；激活事务再验
    一次。enqueue 后或生成期间 evidence 被纠正/provenance 漂移都原子失败。
  - recommendation/author/review 的 provider-facing schema（含 author 内层 response
    signature）均为扁平 object、无 `anyOf`；返回后仍由 canonical discriminated reader
    严格校验，三个生产调用都显式传 registry-derived `outputFormat`。package review
    digest 使用共享 canonical JSON SHA-256。
  - intervention source/conjecture 使用真实 event FK；active shape 显式拒绝 NULL
    recommendation/package。缺失 review run provenance 进入整包重试，不抛成无结构 job crash。
  - `AUTO_INTERVENTION_EXPANSION_ENABLED` 默认 OFF；当前只产生 `delivery_mode=shadow`，
    不等同于交付或扩量。
- **针对性开发验证已过**
  - unit：8 files / 153 tests；DB：2 files / 15 targeted tests；migration smoke：1 pass。
  - `pnpm typecheck`、Biome scoped check、capability boundary audit（0）通过。
  - schema audit 无 unallowed stub；flag reader/ledger 对齐。全仓 strict flag audit 仍报告
    基线已有的 `NOTES_MASTERY_SUBSCRIPTION_ENABLED` 未登记，本 lane 未改其行为。
  - 完整 gate 不在本地跑；提交后只监听 exact-head GitHub Actions `CI Gate`。

## NEXT

1. 提交并 push PR #1119 的集中 review-hardening diff。
2. 只监听新 head 的 GitHub Actions `CI Gate`；回复/resolve 已验证 review threads，并复查新增反馈。
3. exact-head CI 与独立 review 全绿后 squash merge，Linear YUK-791 对齐 Done。
4. 按 mesh 依赖进入下一 lane；不提前做 YUK-792 scheduler/settlement 或产品 UI。

## PARKED

- **YUK-822：P1 学科确定性验证器（owner 明确本轮不实现）**
  - 只保留详细通俗解释与计划：
    `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
- **YUK-792：延迟/迁移 scheduler 与 intervention outcome settlement**；不混入 YUK-791。
- **YUK-815 / YUK-816：Copilot/Brief 协作与 Growth intervention projection**；等待
  准备链及验证结算链先成为可读真相源。
- **YUK-826 第二波 DB 测试事务迁移**：Backlog；收益需多次 GitHub CI 数据验证。
- **YUK-824 本地 lint 假红**：sanctioned `.ykv/**` cache 精确忽略是独立线。

## BLOCKED-ON

- **YUK-814 真实 owner 发布闸门**：Gate A/B/C 仍未全过；mock 输入/真实模型输出只证明
  开发回归质量，不能替代真实 owner/cohort shadow、blind 与 canary。
- **auto-intervention 扩大使用**：保持 OFF；YUK-791 可合并 shadow backbone，但未获得
  真实发布证据前不得把 `delivery_mode=eligible` 交付给 Today/B3。
- **canonical Opus 输出质量**：OAuth 周额度仍可能 429；429 只记 operational，
  不冒充质量 pass/fail。
