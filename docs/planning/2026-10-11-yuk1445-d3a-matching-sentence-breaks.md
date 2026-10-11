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
