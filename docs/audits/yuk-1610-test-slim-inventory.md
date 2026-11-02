# YUK-1610 第一阶段：测试瘦身 删/合并/保留清单

状态：**已执行（第二阶段，按 PM 2026-10-29 批注）。** PM 四问裁决：①A1 整删（无操作员契约依赖 console 文案）；②B3 整删、不补集成例、reps≤9 上限交 audit 脚本；③A3/B2 各允许保留 1 条 unit 代表例（仅限 DB 层未覆盖的纯 seam 且是该不变量的唯一证明）；④B4 terminal-job 两 serialization 长 case 列入第二阶段表驱动合并。第二阶段执行记录见文末「执行结果」。edit-submit / paid-effect 归 YUK-1580，本票不动。

依据：根 `AGENTS.md` 测试口径（2026-10-10/11/12 合并，YUK-1611 编码入 main）与 `/workspace/el/test-standard.md`。核心条款：同一行为只在最近的真实边界测一次；unit 与 DB 两层不各写一遍，已有 DB 证明就删 unit 版本；禁 mock 交互断言、常量/字面量/schema 形状自证、内部 helper 单测、同一路径参数排列；测试名写行为，不写票号/review 轮次/UNRUN 状态。

## 0. 车道事实（清单的前提）

`vitest.shared.ts` 的 `fastTestInclude` / `dbTestInclude` 是显式 allowlist——下列所有文件**都在真实执行**。因此下列文件里的 "Prepared but NOT RUN in this lane" / "(DB, prepared UNRUN)" 头注释与 describe 名都是**过时状态标注**（与代码矛盾，按缺陷处理），本身就该在第二阶段一并清理：

- `src/capabilities/practice/server/calibration-sample-durable-operation.db.test.ts:1`
- `src/capabilities/notes/server/note-verify-durable-operation.db.test.ts:1`
- `src/server/durable/paid-effect-store.db.test.ts:1`
- `tests/integration/item-prior-durable-member.db.test.ts:792,1033-1034`
- `tests/restore-parity/canonical.db.test.ts:106,234`

## A. judge-calibration sampling 套件（票点名「四件套重复」）

真实边界锚：`calibration-sample-durable-operation.db.test.ts`（DB 车道，真实 PG + 真实 core/handler/store）。四个重复件围绕它各自用 mock 复读了同一组合同。

| # | 文件 | 车道/行数 | 处置 | 理由（附证据） |
|---|------|----------|------|----------------|
| A1 | `src/capabilities/practice/jobs/judge_calibration_sample.test.ts` | unit / 117 | **删（整文件）** | handler 只是 operation 的薄消费者。disabled→不花钱、失败 rethrow、preflight 裸抛这三条合同已由 DB 文件 `retained calibration operation integration`（L177-265，真实 handler 端到端）证明；本文件全部断言落在 `console.log/error` 文案与 `runSampleFn` mock 调用上——浅层 mock 调用断言。唯一残留理由是「操作员可 grep 的日志面」，见开放问题 1。 |
| A2 | `src/server/durable/calibration-sample-family.test.ts` | unit / 165 | **部分删（约 −70 行）** | `gate-only calibration candidate` describe（L51-102）与 DB 文件 `gate-only DBOS candidate integration`（L267-305，真实 DB）逐条同合同（disabled 不花钱 / held 不花钱 / gate 失败裸传）→ 删。L107-118（held 报 prerequisite 异常）同理重复 → 删。**保留** L120-152 两例 cached-step replay：DBOS SDK 的缓存步骤回放语义在真实 PG 边界测不到，属并发不变量的唯一证明。保留 L154-164 epoch fence 一例（同类，唯一证明）。 |
| A3 | `src/capabilities/practice/server/calibration-sample-durable-operation.test.ts` | unit / 784 | **合并/部分删（约 −550 行）** | ① `frozen workset identity`（L346-441）是对 `computeCalibration*Digest/Id/EntityKey` 纯函数的排列自证（换输入→摘要变），内部 helper 单测；identity 拒绝行为已在 DB 层证明（db 文件 L746 `rejects a changed freeze`、L810 `holds a changed receipt face`）→ 删。② `readCalibrationSampleGate` + `runCalibrationSampleOperation`（L83-276）是 mock 版操作合同，DB 层 L177-305 已证 → 删。③ `shared-store consumer gate`（L443-479，disabled 例）重复 → 删。④ `released core seams`（L481-784）与 DB 文件 `prepared staged core integration`（L329-584）+ `concrete calibration shared-store consumer`（L585-861）大面积同合同（freeze 后源编辑不影响 / apply 失败恢复 / MF8 冲突 / 吞没 rejection 保真）→ 以 DB 版为准删 unit 版；仅保留 DB 测不到的纯 seam 分支（如 `judgeCalibrationPreparedFace` 对 unsupported/partial_unknown 的分类，若 DB 层确未覆盖）。 |
| A4 | `src/capabilities/practice/server/judge-calibration-sample.db.test.ts` | DB / 211 | **合并后删本文件（净约 −180 行）** | 仅剩 2 例：(c) 候选选择跨 run 幂等、(c2) event 层 partial unique index 拒绝重复写。两条不变量成立且未被 DB 锚文件重复，但 fixture 与 `calibration-sample-durable-operation.db.test.ts` 的 `seedJudgedAttempt` 近乎整段复制（两份各约 80-150 行），且 `SeedOpts`（route/priorOutcome/imageRefsKey/textKey/metadata 等 8 个参数）是已删 case 留下的死参数排列——现存两例只用 `semantic/correct`。处置：把 (c)/(c2) 迁入 DB 锚文件复用同一 fixture，删本文件与死参数。 |
| A5 | `src/capabilities/practice/server/calibration-sample-durable-operation.db.test.ts` | DB / 1061 | **保留**（边界锚） | 真实 PG 上证明 retained 集成、gate-only candidate、staged core、shared-store CAS/lease/回放。第二阶段仅顺带清过时头注释（§0）。 |

四件套口径对应 A1-A4；合计估减 **约 900 行**。

## B. item-prior 套件（票点名「三件套重复」）

真实边界锚：`tests/integration/item-prior-durable-member.db.test.ts`（DB，真实 PG/store/anti-join）与 `tests/integration/item_prior_backfill.db.test.ts`。

| # | 文件 | 车道/行数 | 处置 | 理由（附证据） |
|---|------|----------|------|----------------|
| B1 | `src/server/durable/item-prior-family.db.test.ts` | DB 车道 / 343 | **部分删（约 −280 行）** | 名为 db 车道，实际是 fake `database()` 读链 + `vi.mock(applyItemPrior/makePracticeTaskRunFn)` 的 unit 复本。describe 1（L188-238）与集成文件真实 DB 两例 1:1 同名同合同：`freezes the real anti-join result…stays blocked on replay`（集成 L136）与 `rejects mismatched dates and node IDs without settling a node`（集成 L172）→ 删。describe 2 中 schema 拒绝（legacy/错 tickId，L265-287）与集成 L980 `rejects unversioned, foreign identity…payloads` 重叠且属 schema 形状断言 → 删；replay generation 例（L291-308）若保留需并入集成文件；`calls the real shared store…`（L312-342）是对 `postgres({host:'unit.invalid'})` client mock `begin` 的调用断言——mock 交互断言 → 删。 |
| B2 | `src/capabilities/practice/server/item-prior-durable-operation.unit.test.ts` | unit / 731 | **合并/部分删（约 −550 行）** | ① `float4 application comparison`（L534-612）：用 `Math.fround` + 内存行模拟 float4，集成文件 `item prior application float4 verification`（L193-401）在**真实 float4 列**上证明同一 apply/re-verify/supersede 合同 → 删（「已有 DB 证明就删 unit 版本」的标准例）。② `application verification seam`（L456-533）：fake 读链上的 matched/superseded/报错传播，集成 L212/L731/L853 已在真实边界证明 → 删。③ `item prior reservation consumer`（L223-401）：fake store 合同 vs 集成 `concrete shared-store consumer`（L405-727）真实 store race/胜者 fence → 大部分删。④ `retained item_prior_backfill consumer`（L402-455）：mock `applyItemPrior`，迁 median/all-failed 两例进 `tests/integration/item_prior_backfill.db.test.ts`（真实 DB，现 86 行）后删。⑤ `per-rep work identity`（L173-221）digest helper 排列自证 → 删。⑥ `terminal application compatibility`（L613-731）：与集成 L853 `holds fully applied incompatible result…` 去重，保留一条代表例或全删。 |
| B3 | `src/capabilities/practice/server/item-prior-import-order.unit.test.ts` | unit / 202 | **删（整文件）** | 导入顺序测 + 参数排列（`it.each` 4 入口 × 3 断言）：证明「无论先 import 哪个入口，schema 上限都是 9」——schema 字面量自证 + fake tx 读链（mock-of-mock）。reps 上限合同若需守，应在唯一真实入口的 case 里测一次，或由 audit 脚本承担（见开放问题 2）。 |
| B4 | `tests/integration/item-prior-durable-member.db.test.ts` | DB / 1340 | **保留**（边界锚） | 真实 DB 上唯一证明 blocked-candidate/float4/shared-store/非因果处置/终端预约的文件。第二阶段仅改两个含 "prepared UNRUN" 的 describe 名（§0）。L1034-1330 两个 terminal-job reservation 大 case 是否可表驱动合并，留给第二阶段评估，本清单不预承诺。 |
| B5 | `tests/integration/item_prior_backfill.db.test.ts` | DB / 86 | **保留（承接 B2④，约 +60 行）** | 真实 DB 幂等证明；是 B2 backfill 两例的正确落点。 |

三件套口径对应 B1-B3（B4/B5 为锚）；合计估减 **约 970 行**。

## C. note-verify 套件（票点名「note-verify 重叠」）

| # | 文件 | 车道/行数 | 处置 | 理由（附证据） |
|---|------|----------|------|----------------|
| C1 | `src/server/durable/note-verify-family.test.ts` | unit / 108 | **部分删（约 −65 行）** | L48-55 `accepts exactly the already-queued payload and family name`：`expect(NOTE_VERIFY_FAMILY).toBe('note_verify')` + zod schema 形状逐字段断言——常量/schema 形状自证 → 删。L59-75 `runs the operation in a pinned non-retryable step`：断言 SDK step 配置字面量（name=`note-verify-v1`、`retriesAllowed:false`）——常量自证 + SDK 交互断言 → 删。L94-107 `passes the operation result through`：`stubDb({kind:'not_found'})` 浅层透传 → 删。**保留** L38-44 `refuses to execute without a durable workflow identity`（DBOS 身份钉死，唯一证明）。L79-90 fenced 例与 C3 同合同（不同宿主边界），二留一（建议留 C3 的 pg-boss handler 侧，更接近现网真实入口），C1 侧删。 |
| C2 | `src/capabilities/notes/server/note-verify-durable-operation.db.test.ts` | DB / 180 | **保留** | 真实 `note_verification_claim` 表上的崩溃恢复/不重复购买/预算共享（并发不变量，每例一行一条）。仅清 L1 过时头注释（§0）。 |
| C3 | `src/capabilities/notes/jobs/note_verify.control.test.ts` | unit / 60 | **保留（或与 C1 合并为一件）** | pg-boss handler 的 backend-control 准入：fenced 不吞、admitted 恰好执行一次。operation 被 mock，但该控制流只此一处证明；`runNoteVerify` 调用断言是付费边界的哨兵用法，非浅层交互断言。 |
| C4 | `src/capabilities/notes/jobs/note_verify.db.test.ts` | DB / 102 | **保留** | 真实并发 claim fence（同 artifact 恰好一次付费调用）。 |

## D. edit-submit（票点名，但**移交 YUK-1580**）

| 文件 | 车道/行数 | 处置 |
|------|----------|------|
| `src/server/questions/edit-submit.db.test.ts` | DB / 2686 | **移交 YUK-1580，本票不动。** PM 已明确 edit-submit/paid-effect 归 YUK-1580。仅记录观察供该票取用：28 case 中至少 10 组同路径参数排列可表驱动合并——old-format single 与 multi choice 各测一遍同一编辑/换 key 路径（L1526-1714）；「prompt edit 改 scoring 形状 → withheld」三连（flip blank_scores_zero / capped_sum→sum / drop exact bounds，L1787-1951）；case_sensitive/trim 覆盖继承归一化两连（L2277-2504）。估可减 800-1200 行。 |

## E. scoring.test.ts 命名（票点名「票号/review 轮次命名」）

| 文件 | 行数 | 处置 |
|------|------|------|
| `src/core/schema/assessment/scoring.test.ts` | 861 | **保留全部 case，重命名**。case 本体是判分/结算确定性不变量（五类不变量第②类），全部成立；但 11 个名字带 review 轮次/票号前缀：`P1-1:` ×5（L203/222/236/251/269）、`P1-A repro:` ×2（L283/305）、`YUK-1096 P1-3:`（L422）、`P1-2:`（L715）。改成行为名（例：`P1-1: extra results are rejected…` → `extra results are rejected, never silently ignored`），纯 rename 不动断言。 |

补漏（同类，不在票点名内，记 follow-up 不在本票执行）：`settlement.test.ts` L274/291（`YUK-1093 P1-4`）、`src/core/migration/apply.test.ts` 约 9 处（`P1-2/P1-2b/P1-2c/P1-3/P1-3b/P1-5b/YUK-1100`）、`src/core/capability/judges/exact.test.ts` L121（`YUK-609`）。

## F. custom-sandbox（票点名保留）

| 文件 | 车道/行数 | 处置 |
|------|----------|------|
| `src/capabilities/practice/ui/blocks/custom-sandbox.test.ts` | unit / 348 | **保留**。owner 2026-10-18 批准的安全边界方案（tlp-status/discussions/custom-block-sandbox-test-plan.md）；已表驱动、逐例 `@invariant security` 注解，测的是 digest 校验/CSP/注入向量的对外安全行为，无删减空间。 |

## G. mastery calibration 三小件（补扫，票未点名）

| 文件 | 行数 | 处置 | 理由 |
|------|------|------|------|
| `src/server/mastery/item-calibration.db.test.ts` | 37 | **保留** | `applyItemPrior` write-once 锚不可逆合同，真实 DB，单 case。 |
| `src/server/mastery/recalibration.db.test.ts` | 166 | **保留 case；清头注释** | 现仅剩 1 例（duplicate attempt_event_id → 单 label），真实边界成立；L1-9 头注释仍描述已不存在的 (A)(B)(C) 套件——注释与代码矛盾，第二阶段删。 |
| `src/capabilities/practice/api/submit-native-calibration.db.test.ts` | 161 | **保留** | 真实路由边界，单 case 覆盖手动替换 + 重放各自身份。 |

## H. 补漏扫描的其他发现（不在本票范围，建议记 Linear follow-up）

- `src/server/durable/paid-effect-protocol.test.ts:318-320`：三个 family 常量逐个 `toBe('note_verify')`——常量自证。
- §0 列出的全部过时 "prepared/UNRUN" 注释与 describe 名。
- §E 补漏列出的其他文件票号命名。
- `judge-calibration-sample.db.test.ts` 与 DB 锚文件之间的 `seedJudgedAttempt` fixture 整段复制（随 A4 合并消除，不单开票）。

## 汇总

| 处置 | 文件数 | 估净减行数 |
|------|--------|-----------|
| 整文件删 | A1、B3 | 约 320 |
| 部分删/合并 | A2、A3、A4、B1、B2、C1 | 约 1,700 |
| 移交 1580 | edit-submit.db.test.ts | （该票内估 800-1200） |
| 保留 | A5、B4、B5(+60)、C2、C3、C4、E(仅 rename)、F、G | — |

本票（第二阶段删除 PR）预期净减 **约 2,000 行** 测试代码，不触碰产品代码；所有保留件均为真实边界或唯一证明。

## 开放问题（已由 PM 2026-10-29 裁决）

1. **A1 日志面**：无操作员契约依赖 console 文案 → 整文件删。
2. **B3 reps 上限**：不补集成例；reps≤9 上限合同交 audit 脚本承担（owner 测试口径下不再由导入顺序测试守）。
3. **A3④ / B2③ 的 seam 分支**：各允许保留 1 条 unit 代表例，仅限 DB 层未覆盖的纯 seam 且是该不变量的唯一证明。
4. **B4 terminal-job 两长 case**：列入第二阶段，做表驱动合并（合并不算新增测试）。

## 执行结果（第二阶段 PR）

- **整文件删**：A1 `judge_calibration_sample.test.ts`（117 行）、B3 `item-prior-import-order.unit.test.ts`（202 行）、A4 `judge-calibration-sample.db.test.ts`（(c)/(c2) 迁入 A5 锚文件复用 `seedJudgedAttempt`）、B1 `item-prior-family.db.test.ts`（全部 case 与 `tests/integration/item-prior-durable-member.db.test.ts` 真实 DB 证明重复；replay-generation 例由集成 L655/L980/L1086 三处真实边界覆盖，未单独迁移）。
- **部分删/合并**：A2（保留 cached-step replay ×2 + epoch fence，DBOS SDK 回放语义唯一证明）；A3（保留 `judgeCalibrationPreparedFace` unsupported/partial_unknown 分类 1 例）；B2（保留 `validateItemPriorAppliedApplication` 拒绝矩阵 1 例；median/all-failed 两例迁入 `tests/integration/item_prior_backfill.db.test.ts` 真实 DB 重写）；C1（保留 durable workflow identity 1 例，fenced 例留 C3 pg-boss handler 侧）；B4（两个 serialization 长 case 合并为一条 `it.each` 表驱动 case，断言全量保留）；E（scoring.test.ts 9 处票号/review 前缀改名，断言未动）。
- **注释清理**：§0 全部过时 "prepared/UNRUN" 头注释与 describe 名（paid-effect-store.db.test.ts 归 YUK-1580 未动）；G recalibration.db.test.ts 头注释对齐现存单 case。
- **保留的唯一证明（数据丢失/付费副作用路径）**：A5、B4、B5 锚文件全部 case；C2/C4 note-verify 并发 claim；F custom-sandbox；G 三小件。
- 因改名/迁移形成的新注册 case 均按 `pnpm audit:test-policy` 口径补 `@invariant`/`@fails-if` 行为注解。
