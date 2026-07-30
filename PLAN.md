# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-792 结算链进入审查】**
> owner 已授权按 roadmap 依赖序持续推进全部计划，并允许以 agent 自写输入、agent
> 评判**真实产品链输出**完成数据 gate。YUK-792 是当前唯一 active implementation lane。

## NOW

- **YUK-792：延迟/迁移 scheduler 与 intervention outcome settlement 正在审查。**
  - branch：`codex/yuk-792-intervention-settlement`。
  - eligible intervention 激活时把已审核的 immediate / delayed / transfer probes
    物化到现有 question + question-level FSRS due surface；shadow 只写审计 ledger，
    不生成 learner-visible card。
  - 固定窗口为激活时、+7 天、+21 天；canonical review subscription 首次结算每个
    probe，完成后删除 one-shot card，并在三项齐备时产出
    `effective | ineffective | inconclusive` 与 settled event。
  - recovery 对 eligible active rows 幂等补齐 question/card；migration 回填既有 active
    ledger。不存在真实 producer/reader 的 `transfer_gap` 已从 runtime/prompt 删除，
    ADR 保留未来恢复条件。
  - 本地针对性证据：typecheck、lint、静态审计、全量 unit 5,959 项、migration 30 项、
    settlement DB 22 项、candidate DB 43 项及 submit early-due 红测通过。独立
    standards/spec review 的 4 个 P1/所有权 finding 均经一次 verification 关闭。
    完整 DB/build 交 GitHub CI 并行验证。
- **YUK-814 Gate A/B 已通过。**
  - agent 自写 8-cluster blind inputs；Opus/Mimo/Author/Reviewer 均走真实产品链。
  - A/B 各 7/8 grounded（87.5%），redline 0，digest 完整；Gate C 等 YUK-792 合并后跑
    10 个 eligible lifecycle。
- **YUK-828 已完成并对齐 Done**：PR #1120，merge `52c08b8e`。

## NEXT

1. 完成 YUK-792 独立双轴审查、PR/CI、合并与 Linear closeout。
2. 用 10 个 agent 自写输入跑真实 eligible intervention 生命周期，完成 YUK-814 Gate C；
   失败即调查并修复，不以 synthetic harness 输出冒充产品输出。
3. 推进 YUK-822 学科确定性验证器与 YUK-814 结果联调。
4. 再推进 YUK-815 / YUK-816 协作与 Growth projection，最后收口剩余 profile/domain/
   release 验收。

## PARKED

- **YUK-822：P1 学科确定性验证器**；YUK-792/Gate C 后立即启动，spec：
  `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
- **YUK-815 / YUK-816：Copilot/Brief 协作与 Growth intervention projection**；等待
  准备链及验证结算链先成为可读真相源。
- **YUK-826 第二波 DB 测试事务迁移**：Backlog；收益需多次 GitHub CI 数据验证。
- **YUK-824 本地 lint 假红**：sanctioned `.ykv/**` cache 精确忽略是独立线。

## BLOCKED-ON

- **auto-intervention 扩大使用**：保持 OFF，直到 YUK-792 合并且 YUK-814 Gate C 的
  10 个真实 eligible lifecycle 通过。自写输入可作为 gate 输入，但输出必须来自真实
  产品 author/reviewer/due/review/settlement 链。
- **canonical Opus 输出质量**：OAuth 周额度仍可能 429；429 只记 operational，
  不冒充质量 pass/fail。
