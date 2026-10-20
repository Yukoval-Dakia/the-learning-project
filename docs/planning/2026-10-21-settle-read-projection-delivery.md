# 结算读投影归位 — 交付说明（YUK-1572）

状态：已实施，静态证据齐全；机器重活因 worktree 无 node_modules 记 NOT_RUN（不自行安装，交父统一 frozen install 后复跑）。

- 基座 `origin/main`：`ce74a7733f93044f55c0b00d056ae3c8d137f1fc`（与任务固定 SHA 一致，无更新重叠）。
- 分支：`arch/settle-read-projection`；worktree：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-617d65b4`。
- 本片 head：本 commit（见 `git rev-parse HEAD`）。

## 变更内容

- 新增 `src/server/assessment/settle-read.ts`（469 行）：结算读投影模块，
  拥有事件加载 → live/effective 判定 → 回放闭包 → 候选历史重建 → 只读
  候选态转换的完整读簇。逐字迁入：`FsrsSubject`/`ThetaApply`/
  `SettlementPlan`/`AppliedSettlementEvent`/`SettlementEventRow` 五个类型，
  `coerceMs`/`subjectKey`/`planFromPayload`/`parseFamilyFold`/
  `candidateSchedulingSuppressed` 五个纯辅助，`loadSettlementEvents`/
  `liveAppliedSettlements`/`byOccurrenceAsc`/`replayClosure`/
  `candidateHistory`/`candidateStateForRead` 六个读函数。
- `src/server/assessment/settle.ts`（1915 → 1532 行）：删除移出块与
  仅被移出块消费的 imports；新增 `rederiveSettlementPlan` 端口绑定
  （`loadScope`+`derivePlan` 保持写者私有，不出本文件）；`executePlan`
  两处 `candidateHistory` 调用仅追加该注入参，调用顺序不变；
  `candidateStateForRead` 以绑定端口的真适配函数保留原签名与原出口
  （4 实参 → 绑 3 形参，非 pass-through 形态）。
- 方向：`settle.ts`（写者）→ `settle-read.ts`（读者）单边值依赖；
  读模块不 import 写者。scope 加载/plan 推导经显式 `RederiveSettlementPlan`
  端口注入，无 import 环。
- 未新增 `export-from`、别名导出、registry、shim 或豁免；未改
  `scripts/`、audit、schema、baseline、CI、package/lock；未动测试。

## 保护段证据（逐块提取 + 花括号配对比对，base vs head）

IDENTICAL：`executePlan`（归一化两处注入参后）、`revertSettlementMember`、
`writeSettlementEvent`、`learningSettlement`、`withdrawCapturedOccurrence`、
`writeReplayRequired`、`preservedUserRatingExists`、`findUnattributedNewerWrites`、
`loadScope`、`derivePlan`、`ReplayRequiredError`、type `ReplayRequired`。

移出块 base↔settle-read 逐字一致（仅 `export` 关键字与 candidateHistory/
candidateStateForRead 的注入形参差异）；14 个 diff hunk 全为
import 调整/块删除/注入参追加，零写者语义改动。完整 diff 与提取证据
封存于 architecture-deepening/YUK-1572/<head>/settle-read/ 外部 artifact。

`ASSESSMENT_SETTLEMENT_ACTION` 字面量在 settle-read.ts 按
`src/kernel/read-models/assessment-verdict.ts:99` 既有先例复刻并注释，
不在 settle.ts 新增 export-from site。

## 两个真实变化场景

1. **历史/有效状态投影**：dead 判定仍由 `settlementReversions` 权威计算；
   verdict 被替换但 `ratingSource==='user'` 且写过 FSRS 的旧结算保留为
   `fsrsOnly` 段（theta 置 `retained_user_rating` 弃权）——该规则逐字在
   settle-read 的 `liveAppliedSettlements`，写者 replay（settle.ts:983、
   1453）与测试/fsrs-state 消费的行为不变。
2. **执行/撤销协议**：回放闭包、occurrence+submissionId 排序、
   revert 新→旧/reapply 旧→新、更正/撤销协议未随读拆分改一行；
   `executePlan` 仅在两处 `candidateHistory` 调用追加注入参，写序不变。

## 五标准对账

- 责任：读模块完整拥有"结算事件→有效投影→候选态"一条链；非转发壳。
- 接口：14 个导出符号全部被 settle.ts 消费；`planFromPayload`/
  `parseFamilyFold`/`ThetaApply` 不外泄。写者对读的唯一耦合是消费
  读函数 + 注入一个 rederive 端口。
- 隐藏知识：事件 payload 形状解析（replay_inputs/family_fold/subjects）、
  live/dead 判定、闭包算法、legacy 行重建全部藏于读模块；settle.ts
  只剩"要历史就给 rederive"这一黑箱边界。
- 修改局部性：读侧规则演进只改 settle-read.ts；写者协议演进只改
  settle.ts；交汇处是稳定端口类型。
- 行为证据：逐块 IDENTICAL 证明 + 14 hunk 人工核验；typecheck/lint/
  build/audit 因缺依赖 NOT_RUN，未声明语义等价之外的任何收益。

## 闭包与消费者

- `candidateStateForRead` 消费者：`src/server/fsrs/state.ts:54` 动态
  import、`settle-forgetting.db.test.ts` 四处调用——签名 `(tx, subject,
  now)` 原样保留。
- `settle.ts` 其余出口（`ASSESSMENT_SETTLEMENT_ACTION/VERSION`、
  `SettlementObservers`、`learningSettlement`、`withdrawCapturedOccurrence`）
  未动；runtime.ts re-export 不受影响。
- settle-read 无未解析标识符（全符号溯源完成）；`biome check` 两文件
  exit 0；Node strip-types 语法解析 settle-read.ts OK（settle.ts 因
  预存 parameter-property 不支持 strip-only，已由 biome 全解析覆盖）。

## 行数与边界

- settle.ts 1915 → 1532（仍 >1500，如实报告：未为凑阈值移动保护段）。
- settle-read.ts 469（<1000，无需 baseline 登记）。
- 边界成立理由：读簇是单一职责闭包（事件表→投影→候选态），写者对它
  只保留消费 + 一个注入端口；移出的全部符号在 settle.ts 中除消费外
  无第二实现。

## 机器实跑 / NOT_RUN

实跑：`biome check`（全局 2.5.7，两文件）exit 0；Node `stripTypeScriptTypes`
语法解析（settle-read）OK；`git diff --check` clean；保护段逐块比对
（上表）；行数与 hash 记录。
NOT_RUN：`pnpm typecheck`、`pnpm lint`、`pnpm build`、
`pnpm audit:capability-boundaries`、`pnpm audit:architecture-deepening`、
全部测试/DB/provider/runtime——worktree 无 node_modules 且授权禁止
自行安装，交父统一安排。
