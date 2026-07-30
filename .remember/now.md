# 当前 handoff — 2026-07-30

## Current state

- owner 已授权持续推进全部 roadmap，并允许 agent 自写 gate 输入、agent 评判真实产品输出。
- 唯一 active lane：YUK-792。
- branch：`codex/yuk-792-intervention-settlement`。
- YUK-814 Gate A/B 已各用 8-cluster 真实产品链输出通过；Gate C 等 YUK-792 合并。
- YUK-828：Done，PR #1120，merge `52c08b8e`。

## YUK-792 已实现

1. eligible intervention 激活时把 immediate / delayed / transfer probe 物化为现有
   question + question-level FSRS card；写入/退役由 Practice public port 单一持有，
   shadow 只写 ledger，不暴露给 learner。
2. 固定 due policy：activation / +7d / +21d；canonical review subscription 记录
   pass/fail，删除 one-shot card，三项齐备后结算 outcome 并写 settled event；未到期
   submit 返回 409，store 对旁路 event 再做 due fence。
3. archive/deploy recovery 用 `(updated_at,id,version)` keyset 扫完全部 eligible active
   rows；migration 回填既有 active ledger。
4. 删除无 producer/reader/red-test 的 runtime `transfer_gap` 及 prompt 暗示；ADR 只保留
   未来具备真实闭环后的恢复条件。
5. Practice 声明 canonical `review` event ownership；Agency 只经 subscription 消费。

## 验证

- PASS：typecheck、lint、API/capability/draft/schema 等静态审计。
- PASS：全量 unit 516 files / 5,959 tests；相关 DB 2 files / 64 tests；
  migration 1 file / 30 tests。
- PASS：修复 review finding 后 settlement DB 22 tests、submit early-due 红测、101-row
  recovery 边界、真实 `answerProbe → evidence_for → /api/review/due` 链。
- 独立 standards/spec 初审的 4 个 P1/所有权 finding 已全部修复；一次 verification
  review 均判 CLOSED，无新增 P0/P1。
- 本机 OrbStack 一度停止导致第一次全量 DB 无 runtime；恢复后完整 DB 跑约 19 分钟无
  failure 输出，但为避免低效本地串行等待已主动中止，不计为 PASS。
- 完整 DB/build 交 GitHub CI 并行验证。

## 下一步

1. 独立 standards/spec 双轴 review；修 P0/P1 后开 PR。
2. 等 exact-head CI Gate；合并并对齐 Linear/PLAN/.remember。
3. 跑 YUK-814 Gate C：10 个 agent 自写输入的真实 eligible lifecycle。
4. 依次推进 YUK-822 → YUK-815/YUK-816 → 剩余 profile/domain/release 验收。
