# 结算读投影归位 — 交付说明（YUK-1572）

状态：已实施；静态等价证据齐全，机器门禁结果见末节（以实跑为准）。

- 基座 `origin/main`：`ce74a7733f93044f55c0b00d056ae3c8d137f1fc`（与任务固定 SHA 一致，无更新重叠）。
- 分支：`arch/settle-read-projection`；worktree：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-617d65b4`。
- 本 lane 最终 head：`git rev-parse HEAD` 实际值；静态证据 seal 已存于
  `…/YUK-1572/4c50287cf2b9b1bd4cd39721b024eb1c5da293c1/settle-read/`（不覆盖），
  源码固定4c50287，父接手后真实门日志见 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/4c50287cf2b9b1bd4cd39721b024eb1c5da293c1/parent-gates-after-rate-limit/`；之后只有本交付doc改动。

## 变更内容

- 新增 `src/server/assessment/settle-read.ts`（469 行）：结算读投影模块，
  拥有事件行解码 → live/effective 判定 → 回放闭包 → 候选历史重建 →
  只读候选态转换的读簇。逐字迁入（仅 `export` 关键字差异）：
  `FsrsSubject`/`ThetaApply`/`SettlementPlan`/`AppliedSettlementEvent`/
  `SettlementEventRow` 五个类型；`coerceMs`/`subjectKey`/`planFromPayload`/
  `parseFamilyFold`/`candidateSchedulingSuppressed` 五个纯辅助；
  `loadSettlementEvents`/`liveAppliedSettlements`/`byOccurrenceAsc`/
  `replayClosure` 四个读函数。
- `candidateHistory` 与 `candidateStateForRead` 实现迁入 settle-read.ts，
  非逐字：为获得 scope 加载与 plan 推导（写者私有，不出 settle.ts），
  二者新增 `rederive: RederiveSettlementPlan` 形参；`candidateHistory`
  体内原 `await loadScope(tx, input)` + `derivePlan(input, scope)` +
  `scope.frozenLearningScope` 三行改为单次 `await rederive(tx, input)`
  解构。除此之外两函数体逐字不变（set-diff 逐行见 seal）。
- `settle.ts`（1915→1532 行）：删除移出块与仅被移出块消费的 imports；
  新增 `rederiveSettlementPlan` 绑定体（551-552 行，直接调用原样的
  loadScope/derivePlan，返回 `{plan, frozenLearningScope}`）；
  `executePlan` 两处 `candidateHistory` 调用仅在第 5 位插入注入参
  （原 `[]`/`options.memoryHistory?…` 等其余实参逐字不变，调用时点不变）；
  `candidateStateForRead` 公开出口改为绑定适配函数（同签名，转发
  (tx,subject,now) + 绑定端口）。
- 方向：settle.ts（写者）→ settle-read.ts（读者）单边值依赖；读模块无
  settle.ts import edge。
- 未新增 `export-from`/registry/shim/豁免；未改 `scripts/`、audit、
  schema、baseline、CI、package/lock；未动任何测试文件。

## 保护段证明（brace 配对提取 base↔head 逐块比对，证据见 seal）

逐字 IDENTICAL（无任何差异）：`revertSettlementMember`、
`writeSettlementEvent`、`learningSettlement`、`withdrawCapturedOccurrence`、
`writeReplayRequired`、`preservedUserRatingExists`、`findUnattributedNewerWrites`、
`loadScope`、`derivePlan`、`ReplayRequiredError`、type `ReplayRequired`、
`normalizeIds`、`contentKcs`、`unitPartIdsOf`、`unitExecutorKinds`、
`schedulingSubjects`、`hasSchedulingEffect`、`planSubjects`。
`executePlan`：除两处 `candidateHistory` 实参位插入 `rederiveSettlementPlan`
外逐字相同（归一化该参后 IDENTICAL）。
`candidateHistory`/`candidateStateForRead`：见上"变更内容"——读模块内的
缝区改动即注入形参与三行重推导收口，等价性逐条证明封存于
`call-seam-equivalence.txt`（同 tx/input/调用时点、frozenLearningScope
读取时点、plan 对象身份、current.forgetting* mutation 顺序、错误实例
透传；stack 多一个 async frame + 一次 microtask hop，如实记录）。

## 两个真实变化场景

1. **历史/有效状态投影**：`settlementReversions` 仍权威判定 dead；
   verdict 被替换但 `ratingSource==='user'` 且写过 FSRS 的旧结算保留
   `fsrsOnly` 段（theta 置 `retained_user_rating` 弃权）。该规则逐字在
   settle-read 的 `liveAppliedSettlements`；写者 replay 路径
   （settle.ts:983、1453）与外部消费者的可观察行为不变。
2. **执行/撤销协议**：回放闭包、occurrence+submissionId 排序、
   revert 新→旧/reapply 旧→新、更正/撤销协议代码逐字未动；
   `executePlan` 仅两处调用点追加注入参，写序不变。

## 五标准对账（事实陈述，不声称收益）

- 责任：读模块拥有事件解码→投影→闭包→历史重建→只读转换这一条读链；
  写者保留执行/撤销/事件写入/scope/plan 推导。
- 接口：settle-read 导出 14 个符号，全部被 settle.ts 消费（其中
  `candidateStateForRead` 经适配出口对外）；`planFromPayload`/
  `parseFamilyFold`/`ThetaApply` 未导出。
- 隐藏知识：外部 caller 的可观察面未变——它们原先就只能经公开出口
  触达，私有函数本不可达；本次变化是**写者文件内部**：读算法不再与
  写者实现同文件，写者经 import 消费读模块。不声称 caller "少知"是
  新增收益。
- 修改局部性：读规则演进改 settle-read、写者协议演进改 settle.ts；
  场景编辑原先同样只涉及单一文件，不冒称新的单点收益。
- 行为证据：逐块提取比对 + 14 hunk 逐行核验 + 缝等价逐项证明；
  其余以门禁实跑结果为准（末节）。

## 适配器与字面量复刻 — 待分类事项（不自签）

- `candidateStateForRead` 适配器：转发全部 3 个公开形参 + 绑定 1 个
  端口常量。是否被 pass-through scanner 判为新 site，以
  `audit:architecture-deepening` 实跑输出与父裁决为准；writer 不自签
  非 pass-through，也不为绕门改实现。
- `ASSESSMENT_SETTLEMENT_ACTION`：settle-read.ts:42 复刻字面量并注释
  （参照 `kernel/read-models/assessment-verdict.ts` 既有先例——先例仅
  证明该做法存在，不构成授权）。漂移代价如实列出：action 字符串若
  未来改名需同步两处；建议由父裁决登记或改由共享常量归位。

## 行数与边界

- settle.ts 1915 → 1532（**仍 >1500**，如实报告；未为凑阈值移动任何保护段）。
- settle-read.ts 469（<1000，不触发 baseline 登记）。
- 边界构成：读簇为"event 表 → 有效投影 → 候选态"完整职责闭包；
  写者对它的耦合 = 消费读函数 + 注入一个 rederive 端口。

## 机器实跑 / NOT_RUN

实跑（本机，heavy.sh 槽位内，原始日志与 argv/UTC/真实 rc 封存于
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/4c50287cf2b9b1bd4cd39721b024eb1c5da293c1/parent-gates-after-rate-limit/`）：

- `pnpm typecheck`：父实际执行 rc=0，argv/UTC/log SHA见 results.jsonl
- `pnpm lint`：父实际执行 rc=0，argv/UTC/log SHA见 results.jsonl
- `pnpm build`：父实际执行 rc=0，argv/UTC/log SHA见 results.jsonl
- `pnpm audit:capability-boundaries`：父实际执行 rc=0，argv/UTC/log SHA见 results.jsonl
- `pnpm audit:architecture-deepening`：父实际执行 rc=0，argv/UTC/log SHA见 results.jsonl
- 静态：`biome check`（global 2.5.7 冒烟，早于 frozen install）exit 0；
  Node strip-types 语法解析 settle-read OK；`git diff --check` clean。

NOT_RUN：全部 tests/vitest/DB/migration/provider/runtime/demo（lane
授权明确禁止）。


## 父接手后的实测与边界

原writer因模型额度中断，未完成的文档占位已由父替换为真实回执，源码与4c50287逐字相同。父21:53:40–21:54:25 UTC经heavy.sh串行完成五门：typecheck/lint/build/两architecture audits全部0；403/0/37、SCC1、超长15保持，pass-through新增0。机器未发射新站点不等于证明新接口深化；公开适配口只绑定既有scope/plan推导，不宣称caller步骤变少。原static接缝说明中的boolean|undefined应更正为实际SettlementScope.frozenLearningScope:boolean；旧封存保留，本文作更正。

原有action字面量的复制是本次解耦的维护代价，不作为新抽象收益；两处调用实参改动与多一层async边界单独呈独立审查，不称executePlan整体逐字相同。独立R1和exact CI仍待，尚未验收或计main；测试/DB/runtime/provider未运行。
