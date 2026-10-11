# YUK-1445 / ADR-0074 D3a — 配对与断句作答契约与确定性判分（纯函数 + schema 切片）

状态：D3a 第一刀已实施（source-only）；分支 `feat/yuk-1445-matching-sentence-breaks`，
基线 `e6b8880b5`（fresh origin/main，#1695 R10 tap blocks 之后）。本文件是该切片的
契约记录与本地门禁证据；独立 review、真实 issuance 验收、exact-head CI 与 merge 归
父线程（未运行，见 §6）。

## 1. 公开作答契约（不变更历史形状）

- **配对**：公开提交沿既有 `MatchingResponse`：`{kind:'matching', pairs:[{item_id,
  option_id}]}`。`item_id` = 左列稳定 id，`option_id` = 右列稳定 id —— 即 ADR-0074
  D3a 的 `{left_id, right_id}` 语义，**不改名**：现有消费面（`response-types.ts` 草稿
  转换、`exact_matching_pairs` 比较器、capture、历史 submission）全部已是该形状，
  改名即静默改写历史作答语义，禁止。判分只认稳定 id，不认文字/位置/提交顺序。
- **断句**：新增 `SentenceBreaksSlot {kind:'sentence_breaks', text}` 与
  `SentenceBreaksResponse {kind:'sentence_breaks', positions:number[]}`。`text` 是
  随 revision 冻结的明文（公开面携带 —— 学习者按它渲染）；`positions` 是 code point
  字缝索引。
- **位置语义**（`src/core/schema/assessment/position-gap.ts`，纯函数）：索引按
  Unicode **code point** 计（代理对 = 1 字符，字缝永不落进代理对）；gap `i ∈ [0,L]`
  表示第 i 个 code point 之前，有效断句位置是内部缝 `1..L-1`（文首/文末结构性拒绝）；
  客户端必须使用冻结原文逐字渲染与计数，不做 HTML/空白/折行归一化。

## 2. 私有判据（键不入公开 DTO）

- `MatchingPairsKeyCriterion` 增加 optional `rule:{kind:'per_correct_pair',
  points_per_pair}`；`PositionSetKeyCriterion`（新增）＝ `accepted_positions` +
  optional `rule:{kind:'per_correct_break', points_per_break, max_breaks}`。
  规则只能 typed 录入卷面**印出来**的规则（例：「每对一处 1 分、超 3 处 0 分」），
  不解析中文规则原文、不发明通用计分政策。
- 公开投影 `PracticeIssuanceDto` 结构上不含 criterion（strictObject）；反馈揭示
  `RevealedAnswerKey` 新增 `position_set_key` 成员（只揭示 accepted_positions；
  题级规则属 marking 政策，不随键面揭示，与配对/选项键同律）。
- 基数逐题声明（`MatchingSlot`）：`pairing:'one_to_one'|'many_to_one'`（缺省＝
  历史宽松行为，存量校验语义逐字不变）与 `has_distractors:boolean`（不泄露键）。
  one_to_one 下：作答重复右选项 ⇒ `duplicate_pair_option`；键内一右配多左 ⇒
  `key_pairing_violation`。

## 3. 判分语义（`position_set_rule` 比较器 + `exact_matching_pairs` 扩展）

对每个计分单元（默认一题一单元；卷面印每对分值时录入侧按 ADR 拆为每对一单元，
不发明权重）：

| 情形 | 结果 |
|---|---|
| 精确集合相等（顺序无关） | 满分（unit.points） |
| 有印规则（typed） | 恰好按规则：配对 `正确对数×points_per_pair`；断句先判「断点数 > max_breaks ⇒ 0 分」（`rule_max_breaks_exceeded`），再 `正确断点数×points_per_break` |
| 非精确且无印规则 | `pending(needs_review, flagged)`，detail 记录 `正确数/总数`，分数未知 —— 绝不伪零分、不造分、不摊等权 |
| 结构违背（重复左项/外键/one_to_one 重复右项/越界或重复断点） | `invalid_response_set` 整体拒绝评估（fail-closed，不逐单元猜） |
| 未作答（缺条目）/主动空白 | `missing_response` / `needs_review`（`blank_scores_zero=false` 时不计伪零）—— 语义与六类未决纪律一致 |

校验新增：`validateScoringBasis` 拦 `key_position_not_declared`（键位置不是任一引用
槽的内部字缝）、`key_position_duplicated`、`key_rule_conflicts_exact_set`
（`max_breaks < 接受集合大小` —— 精确集合不得被自家规则归零）、`key_pairing_violation`。
`serving-admission` 对确定性比较器单元照常放行（结构校验已证明单槽可判）；
model/human 执行器照旧 withhold，不冒充准入。

**已知后续（另行 lane，本切片不扩判分记录）**：无规则 partial 目前以
`needs_review` pending + detail 文本承载对数；typed 承载（`ScoredUnitResult` 加
partial 计数字段 + 聚合 `no_mapping` 分支）需动 `judgment.ts` 共享面，归父线程统筹
（多选无错子集同政策同题）。

## 4. 变更面（13 文件 + 1 新文件）

owned：`response.ts` `scoring.ts` `execution.ts` `evaluation.ts` `scoring.test.ts`
`position-gap.ts`（新）；authorized 最小域：`dto.ts`（RevealedAnswerKey 成员）；
compile-forced 消费面（各一 case）：`coverage.ts`（能力矩阵行 + kind 词表）、
`study-context.ts`、`native-assessment-reporting.ts`（2 处）、
`native-mistake-evidence.ts`（2 处）、`jev-model-executor.ts`（投影）、
`ResponseSlotField.tsx`（`sentence_breaks → null`，编辑器归 R10 UI 线）；
生成物：`api-schema.generated.ts`（`pnpm gen:api-client` 再生，sha256 幂等）。
未触碰：evaluation.test.ts / publish / publication / jobs / Start / DB / 迁移 / UI 积木。

## 5. 本地门禁证据（实际运行）

- `pnpm typecheck`（tsc 全仓 + server/start 双 tsconfig）：exit 0。
- `pnpm lint`：exit 0，172 warnings（全部为存量基线，与交接记录一致），0 errors。
- `pnpm build`：exit 0（含 build:migrate CJS bundle）。
- `pnpm vitest run --config vitest.unit.config.ts src/core/schema/assessment/`：
  3 files / **102 passed**（含 Choice P1 线的 evaluation.test.ts 原样通过 —— 旧判分
  测试未动未破；settlement.test.ts 同过）。
- 其中 D3a 新增（scoring.test.ts）：**24 passed** —— 覆盖稳定 id 乱序全对、印规则
  恰好执行、无规则 partial 未知分（needs_review + pending_units 聚合）、重复/外键/
  one_to_one 重复、missing vs 空白、代理对 code point 计数、参考集合、超 N 处 0 分、
  错位、越界/重复位置、DTO 零键泄漏 + strictObject 注入拒绝。
- `pnpm gen:api-client` 两次运行 sha256 相同（`33798fde…4bd6`，幂等）。
- `pnpm audit:api-client` 在未提交工作树按定义失败（生成物相对 HEAD 有 diff）；
  提交后（schema + 生成物同 commit）复跑通过 —— 见 §6 后续。
- 未跑（按边界）：完整 `pnpm test`（仅 exact-head CI Gate 执行）、`pnpm gen:postman`
  （未改任何 API route，route 面不变）、DB/docker/runtime/provider。

## 6. 未运行的验收（父线程所有）

1. 独立不同模型 review（真实 diff）。
2. 真实 issuance/consumer 验收（R10 UI 点选块尚未落此线；capture/UI 接线归 UI 线）。
3. push 后 exact-head GitHub `CI Gate`。
4. merge 与等待窗裁决（本切片不 push、不开 PR、不 merge）。
5. 提交后复跑 `pnpm audit:api-client` 应绿（生成物与 schema 同 commit）。

---

## 7. 独立复核 P1 修复（a371dd845 之后的第二刀；本节之前的记录不可变）

输入：独立 Sol xhigh 初审 `/tmp/yuk1445-matching-sentence-breaks-initial-review-sol.md`
的 2 个 P1，父线程读实际源后均裁决接受。本轮唯一写入者，树干净于
a371dd845fdce70e8509a37c0e7fd59e994fd271；migration 只释放
`src/core/schema/assessment/judgment.ts`。未动 choice-0fa8 / figure-5403 任何源。

### P1-1 — 无印规则部分对改为 typed structured partial（不再是 pending/needs_review）

- **新结果形状**：`ScoredUnitResult.partial_unknown_points:
  {correct_count:int≥0, total_count:int≥1}`（optional）+ `points_awarded:null` +
  `status:'scored'`、`scored_because:'response'`。两个执行器分支（matching
  无规则非精确、sentence_breaks 无规则非精确）产出该形状，携带确定性正确计数。
- **聚合行为**：`aggregateUnitResults` 对 additive 单元 `points_awarded===null` 且
  携带 partial ⇒ `unresolved(no_mapping)`（detail 含 `2/3`）—— 与 holistic 未映射
  档位同语义：判得了、分数未知、不造总分不伪零。evaluation `status='completed'`
  （无 pending 单元），不再产生 `pending_units`。
- **fail-closed 守卫（同聚合层）**：partial 与数值 `points_awarded` 并存、
  `correct_count>total_count`、holistic 单元携带 partial ⇒ `invalid_result`。
  加法单元 null 无 partial 的旧 invalid 分支不变（历史语义保留）。
- **未改 settlement（范围已报父线程，未获释放）**：`settlement.ts`
  `classifyScoredUnit`（约 :254）additive 分支 `points_awarded ?? 0` 会把
  scored-partial 单元归为 `{kind:'zero'}` KC 证据 —— 需要 4 行级修改
  （`partial_unknown_points && correct_count>0 ⇒ 'partial'`；`=0 ⇒ 'zero'`）。
  父线程释放前本文件不动；组级 verdict 不受影响（no_mapping 聚合 ⇒ unsupported）。

### P1-2 — 印规则可达满分 ≠ 发布 unit.points 在 canonical 校验拒绝

- `validateScoringBasis`（发布 barrier 与 evaluateSubmissionCore 服务路径共用）新增
  `key_rule_points_mismatch`：`per_correct_pair` 的 `points_per_pair×accepted_pairs数`
  与 `per_correct_break` 的 `points_per_break×accepted_positions数` 都必须
  **等于** `unit.points`（浮点相对 ε=1e-9，十进制卷面分值如 1.5×3=4.5 不误拒）。
  例：3 对×4=12≠6 拒；3 断×2=6≠3 拒。不封顶、不折算、不猜权重；校验先于判分，
  精确作答也不能静默绕过矛盾规则。
- 既有 `key_rule_conflicts_exact_set`（max_breaks<接受数）保留。

### 测试证据（原始错误期望与失败记录保留）

- 初版门禁日志与 21:39 三处失败（位置越界/2-3 计数测试数据错误）保留于上方 §5
  与会话记录；本节不覆盖。
- **RED 证明**：将 judgment/scoring/evaluation 三文件临时还原 a371dd845 后跑修订
  测试 ⇒ **4 failed | 23 passed**（`/tmp/yuk1445-p1-red-proof.log`，
  sha256 前 16 位 `66860c31a4cfc5cd`）——失败的正是两个修订 partial 用例、
  P1-2 拒绝用例与聚合守卫用例（十进制不误拒用例按设计在新旧两版都过）。
  还原修复后全绿。
- `scoring.test.ts` 现 **27 passed**；assessment 单测目录 **105/105**（含 Choice P1
  evaluation.test.ts 与 settlement.test.ts 原样通过）。

### 本轮门禁（实际运行、无管道掩码 exit）

typecheck（双 tsconfig）exit 0；`pnpm lint` exit 0（172 warnings=存量基线，
`/tmp/yuk1445-lint-final.log` sha256 前 16 `98eb391b35389a36`）；`pnpm build`
exit 0；`pnpm gen:api-client` 重跑生成物无 diff（OpenAPI 投影不含该 optional
字段）⇒ `audit:api-client` 提交后必绿。文件签名（sha256 前 16）：
judgment `e01c259fa060d54a`、scoring `8a0882b5087e3e99`、evaluation
`03c115b7a80ff937`、scoring.test `49bbc7c87aecbc15`。

### Owner 交接要点

- 新结果形状/聚合行为：见 P1-1；下游（settlement 的 KC 分类）待父释放 4 行修改。
- 基数 owner 补充绑定：**新录入**的 matching 条目必须声明 pairing（及适用时
  has_distractors）—— 这是录入侧（store/entry gate）义务；纯 schema 无法区分
  新旧 revision，故字段保持 optional+历史宽松缺省，不做破坏存量的强制。
- 免责：base/head 均未实现 per-item calibration registration；本切片的标定探针
  用例**不是** admission，D3 亦未全部完成（R10 UI 点选块、录入侧 spec 产出、
  作答卷往返等仍归各自 lane）。

---

## 8. P1-1 收口：typed partial 贯通到组级 verdict 与 KC 证据（8af031a80 之后第三刀）

输入：owner 22:15 测试规则 + coordinator 对 `settlement.ts` 的专项释放
（1470 线拥有 server/assessment/{settle,activate,settle*.db.test}，本刀未触碰）。
§1–§7 记录不可变。本刀改动：`judgment.ts`（聚合显式 partial）、
`settlement.ts`（verdict/classify）、`dto.ts`（反馈投影 compile-forced 最小 case）、
两个测试文件（按 22:15 规则合并）。

### 语义 delta

- **AggregateOutcome 新成员** `partial_unknown_points {known_points, partial_units[
  {scoring_unit_id, correct_count, total_count}]}`：聚合单源产出 —— 存在
  partial-unknown 单元且无 invalid/no_mapping/pending 时返回；`capped_sum`/
  `threshold_levels` 因 cap/阈值绑死全量满分而 fail-closed 为
  unresolved(no_mapping)。superRefine 新增守卫：声称 partial 而无任何
  partial 单元结果 ⇒ 矛盾拒绝。
- **deriveCoarseVerdict**：partial_unknown_points ⇒ `verdict='partial'`、
  reason=`partial_unknown_points`、points/maxPoints/normalized 全 null ——
  已知部分对触达学习者，不再是 unsupported；分数未知不造总分/比例。
  legacy（holistic 未映射/pending/普通 unresolved）原分支不动、不重释
  （混合卷 holistic 未映射 ⇒ 聚合 unresolved ⇒ 组级仍 unsupported，有钉住用例）。
- **classifyScoredUnit（owner override）**：`partial_unknown_points` ⇒
  `uninformative` —— 未知分【零 KC 证据】：不按正确计数映射 partial/zero
  （0/3 也不是已判零），修复 `points_awarded ?? 0 ⇒ zero` 主动污染 θ̂ 的缺陷。
- **dto 反馈投影**：新聚合成员如实在 AssessmentFeedbackDto 呈现
  （known_points + typed 计数；不伪 unresolved）。

### 消费链实测（read-only 外部文件，未编辑）

- `server/assessment/settle.ts`（1470 所有）：:394 deriveCoarseVerdict →
  :409-414 ratingForVerdict → :703 `plan.rating !== null` 才写 FSRS；
  θ̂ 经 :402/:407 localize/resolveTheta。**无需修改**：unsupported ⇒ rating
  null ⇒ 不写（现行为）；修复后 partial ⇒ 'hard'（D14 既有映射）——
  未知分 partial 将调度 FSRS hard，属设计内结果，已向 owner 报告待确认。
- **剩余消费缺口（父线程释放后处理，本刀未动）**：
  `src/capabilities/practice/server/judge/evaluation-authority.ts` 的
  `projectEvaluationToJudgeResult(record, basis)` 需在 `aggregate.kind ===
  'unresolved'` 块之后、`verdict.points == null` 检查之前插入 partial 分支
  （score=null、coarse_outcome='partial'、evidence 带 known/partial_units），
  否则学习者侧 JudgeResultV2 对 partial 聚合仍回落 unsupported 文案。
- 纯决策层测试不证明 DB 层 no-write；settle.db 级探针属 1470 的
  settle*.db.test（可按需准备，未运行）。

### 测试清单（owner 22:15 规则；before → after；入口与理由）

合并后 D3a 新增用例：scoring.test.ts 13→**12** it、settlement.test.ts 6→**4**
it（砍掉与既有用例重复的 legacy 钉住与 rating 映射 pin；helper 直测改为经
真实链入口）。入口全部为公共确定性核心：`evaluateSubmissionCore`（判分链）、
`aggregateUnitResults`（judgment 单源聚合）、`deriveCoarseVerdict`（1047 投影
与结算单源）、`localizeKcObservations`/`resolveThetaDecision`（settle.ts
:394-414 同链消费）、`projectPracticeIssuance`（DTO 边界）。逐用例不变量：

| 用例（12+4） | 不变量类别 | 理由 |
|---|---|---|
| 乱序稳定 id 全对 | 判分确定性 | 同作答不同顺序同分 |
| 印规则恰好执行（配对） | 判分确定性 | 印刷规则不发明权重 |
| 无规则结构化 partial（配对+断句） | 判分确定性 | 复核 P1：typed partial、永不伪零/造分 |
| 结构违背 fail-closed（双槽 7 形态） | 判分确定性/安全 | 违背拒绝评估，不猜 |
| P1-2 矛盾规则拒绝 | 判分确定性 | 矛盾 basis 不服务；精确作答不绕过 |
| P1-2 十进制不误拒 | 独立失败模式 | 防假拒绝回归 |
| 聚合 partial 形状/known_points/capped fail-closed/矛盾守卫 | 判分确定性 | 单源聚合语义 |
| missing vs 主动空白（双槽） | 判分确定性 | 六类未决纪律不混淆 |
| 代理对 code point 索引 | 判分确定性 | 索引语义确定性 |
| 超 N 处 0 分 | 判分确定性 | 印刷规则优先序 |
| 错位按规则计分 | 判分确定性 | 每对一处语义 |
| 公开 DTO 零键泄漏+注入拒绝 | 安全边界 | 键不入公开面 |
| verdict=partial 触达（settlement） | 判分确定性 | P1-1 收口主断言 |
| 混合 holistic 不重释 | 判分确定性 | legacy 语义保留 |
| KC 零票+θ abstain（0/3 也非 zero） | 判分确定性 | 未知分不产生掌握证据（??0 缺陷） |
| partial 不吞同卷他人票 | 判分确定性 | 证据归因不污染 |

测试行数 > 产品行数（本刀 test ~251 行 vs product ~119 行）：上表 16 用例
各自钉一个不可削减的不变量（判分确定性 14 + 安全边界 1 + 独立失败模式 1），
无 helper-only/参数排列/mock 交互/分支覆盖用例；fixtures 为真实 revision/
submission 构造，mock 为零。

### 本刀门禁（实际运行）

typecheck（双 tsconfig）exit 0；lint exit 0（172 warnings=存量）；build
exit 0；assessment 单测 **108/108**（scoring 26 / settlement 27 / evaluation
55 —— evaluation 为 Choice P1 文件原样通过）。**RED 证明（合并后用例在
8af031a80 缺陷源）**：5 failed（settlement 3 + scoring 2，
`/tmp/yuk1445-d3a-red-8af-final.log`）。签名（sha256 前 16）：judgment
`ab4684987ce65f1a`、settlement `02ce00192783e8e2`、dto `6a0c961d148a45c8`、
scoring.test `f0cf2c1c33409ae0`、settlement.test `5a76a52326e808a8`、
red log `ac46df96073104bc`。
