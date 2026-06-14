# ADR-0038 — 统一 verify 契约（Verifier Router）+ 出题 plan-then-generate

**Status**: Accepted (2026-06-14)
**Part of**: YUK-203（领域模型重构）· Phase 2 路线图 Wave 0 A0-1 'error' 通道 + Wave 4 B5 verify 契约（`docs/design/2026-06-14-product-rethink-phase2-synthesis.md` §5.1）。
**Decision source**: 决策总账 §1 B5（`docs/design/2026-06-14-product-rethink-decisions-ledger.md` 第 76-81 行，最高权威拍板）+ Phase 2 综合 §3.8（`docs/design/2026-06-14-product-rethink-phase2-synthesis.md` 第 217-225 行，出题 verify 契约现状/目标）+ B1 客观题 anchor（`docs/design/2026-06-14-b1-diagnostic-engines-foundation.md` §5.1 硬轨「客观题闭环可 n=1 自校验」）。
**Related**: ADR-0026（WorkflowJudge 置信闸 + flag-gated auto-enroll——本 ADR 把其「最弱环节单 pass 聚合」收进统一 verify 契约的多信号一档，并把 `WORKFLOW_JUDGE_AUTO_ENROLL_*` 的「全 OFF / 全 ON」二态推进为 **source-tier 灰度**）/ ADR-0030（变式轮换探针 by-kind 选题——本 ADR 不动其轮换算法，只把 Variant 的 **写入侧信任闸**从 accept-first 翻转为 verify-then-promote）/ ADR-0031（Copilot 内联出题——其 D2「verify gate 交用户（user-accept = gate）」仅约束 **copilot inline 路**；本 ADR 的统一 verify 契约约束 **后台批量补库路**（QuizGenTask/SourcingTask/VariantGenTask）与 **OCR 录入自动入库路**，二者不冲突，边界见 §决定·5）/ ADR-0024（泛化捕获 outcome 是 signal）/ ADR-0002（VLM-owns-structure）。

---

## 背景

出题与入库这条链上目前并存**三套互不一致的信任闸**，是同一个「内容能不能进库」判断在三个录入面各自长出的形态（Phase 2 §3.8 第 219 行 grounded 复核 + 仓库代码核验）：

1. **OCR 录入闸（弱链单信号）**：`src/capabilities/ingestion/server/workflow-judge.ts` 是确定性纯函数 `combined = min(extraction_confidence, tagging.overall_confidence)`（ADR-0026），取最弱环节一个标量过阈值即裁 `auto | review`。零 LLM、零内容校验——它聚合的是「结构置信 × 打标置信」，不看「这道题对不对、能不能判分」。
2. **QuizGen 闸（五轴多信号 gate）**：`src/server/boss/handlers/quiz_verify.ts` + `src/core/schema/quiz_gen.ts` 的 `QuizVerificationResult`——五轴 check（copy_safety / material_grounded / kind_conformance 等）各带 `verdict` + note，rollup 成 `overall ∈ {pass, needs_review, fail}` 驱动 Option-B 入库闸（`quiz_gen.ts:271`）。这是三套里最成熟、最该当模板的一套。
3. **Variant 闸（accept-first 反模式）**：`src/server/boss/handlers/variant_verify.ts` 先把 `mistake_variant` 写成 `active`，再异步 verify，`verdict='fail'` 才回头标 `broken`（`variant_verify.ts:9-11`）——**先入库后验证**，与前两套「先验证后入库」方向相反，是 ADR-0018 变式管线遗留的信任倒置。

三套之外还有两个未对齐点：(a) `auto-enroll`（`src/capabilities/ingestion/server/auto-enroll.ts`）默认 `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED=OFF`（ADR-0026 决定 3），enroll 真入库分支生产从未跑过，是个「全 OFF / 全 ON」的二态开关，没有按内容可信度分层的灰度通道；(b) 三套 verify handler 的 catch-bottom 都把「LLM/parse/DB 在产出 verdict 前炸了」记成 `event.outcome='error'`（`quiz_verify.ts:189-192` 注释 + `ne(event.outcome,'error')` 幂等排除），但这个「瞬态故障 ≠ 真实 fail verdict」的区分**只活在 event 层的 outcome 字段里，没有进 verify result schema**——下游消费 `QuizVerificationResult` 时无法把「没验成」和「验了判失败」分开。

总账 §1 B5 把这条链的应然定为「**收敛 + 接通**」（不是造新引擎）：三闸收敛到 QuizGen 五轴多信号模板、统一 **verify-then-promote**（= GPT 外部稿的 Verifier Router）；出题改 **plan-then-generate** + 客观题确定性校验 + item-model 变式；auto-enroll 走 **source-tier 灰度**；QuizVerify 扩 **'error' 通道**。本 ADR 把这四条固化为可落地决策，并显式翻转 Variant 信任方向、推进 auto-enroll 二态为灰度。

---

## 决定

1. **统一 verify 契约 = Verifier Router，三闸收敛到 QuizGen 五轴多信号模板**。以 `src/core/schema/quiz_gen.ts` 的 `QuizVerificationResult`（多轴 check + verdict + note → rollup `overall`）为唯一 verify result 形状，OCR 录入与 Variant 两条链的信任闸都重定义为「产出同形状多信号 verdict → 再 promote」。OCR 闸的「最弱环节单标量」(ADR-0026 WorkflowJudge) 收编为该契约里的**一个 axis（结构/打标置信）**而非独立裁决器——它继续做确定性聚合，但不再单独决定 `auto|review`，最终 promote 由统一契约的多轴 rollup 拍板。Verifier Router 的语义是 **verify-then-promote**：任何内容（OCR 块 / QuizGen 题 / Variant）在 `active`/入库前必须先过同一契约的多信号 verdict，`overall='pass'` 才 promote。

2. **出题改 plan-then-generate + 客观题确定性校验 + item-model 变式**：
   - **plan-then-generate**：出题分两段——先产出题计划（要考哪个知识点、什么题型、客观题的标准答案锚点），再据计划生成题面，而非一次性自由生成后再补验。计划段把「可机检的约束」前置，让后续校验有确定性靶子。
   - **客观题确定性校验（接 B1 客观题 anchor）**：客观题（`fill_blank`/`translation`/`choice` 等答案对得上语料的题型）的 verdict **不烧 LLM**——答案能确定性比对语料即放行（`overall='pass'`）。这条直接接 B1 地基 §5.1 的「硬轨 = 客观题闭环可 n=1 自校验」（`docs/design/2026-06-14-b1-diagnostic-engines-foundation.md`）：客观题的确定判分既是 verify 闸的零成本通道，也是 B1 fixed-anchor 自校准的干净 ground-truth 锚——同一个 owner 客观题作答，verify 侧用它当「机检放行依据」，标定侧用它当「miscalibration 残差信号」，两侧共用一个确定性事实源。
   - **item-model 变式（杜绝所见≠入库）**：变式生成走「人 accept 一个模板 → 代码确定性实例化」——LLM 产模板（题干骨架 + 参数槽 + 答案生成规则），人审 accept 模板后由确定性代码实例化具体题目，而非 LLM 每次自由生成一道「看起来对、入库却变形」的题。实例化是确定性的，所见即所得即入库。

3. **Variant 信任方向翻转为 verify-then-promote**：`variant_verify.ts` 现状 accept-first（先写 `active` 再异步标 `broken`，`variant_verify.ts:9-11`）翻转为——VariantGen 产出先落 `draft`/pending，过统一 verify 契约 `overall='pass'` 后才 promote 到 `active` 入 FSRS。与 ADR-0030 的关系明确：**本 ADR 只动 Variant 的写入侧信任闸，不动 ADR-0030 的 by-kind 轮换选题算法**（轮换消费的是已 `active` 的家族成员，翻转后这些成员都是 verify 通过的，轮换逻辑零改动）。

4. **auto-enroll source-tier 灰度**：把 ADR-0026 的 `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`「全 OFF / 全 ON」二态推进为按 **source-tier** 分层的灰度——**先放行 `authentic`（真品来源）+ 客观题 + 确定性校验通过**这一最保守切片自动入库，其余仍走人工 review。灰度是统一出手强度表（Phase 2 §4.2 A/B/C 契约）在出题入库面的落点：source-tier 是静态可逆性兜底的判据之一，**不靠 confidence 标量**（confidence 校准在单用户 n=1 下未经验证，ADR-0026 现状只覆盖 1/18 kind）。灰度阈值与下一档放行条件 = 「先埋点观测 N 周再定参」（Phase 2 §5.3），不在本 ADR 钉死。

5. **QuizVerify 扩 'error' 通道（独立无依赖，先做）**：在 verify result schema（`QuizVerificationResult`）显式加 `'error'` 通道，把「**transport / parse 失败（LLM 没回、JSON 没解出、DB 写炸 —— verdict 根本没产出）**」与「**真实 fail verdict（验了，判这道题不合格）**」在 result 层分开，不再只靠 event 层 `outcome='error'` 隐式承载。语义对齐 `quiz_verify.ts:189-192` 现有的「TRANSIENT-error 不阻塞 pg-boss redelivery」逻辑——`'error'` 表示「该重试」，`fail` 表示「该弃用/回 review」，二者下游处置不同。这条**零结构依赖、不依赖建不建图 / scope 决策**，是 Phase 2 路线图 Wave 0 A0-1 立即可起跑项。

6. **后台批量补库路与 copilot inline 路的 verify 边界**（与 ADR-0031 D2 不冲突）：本 ADR 的统一 verify 契约约束**后台/无人值守路**——OCR 录入自动入库（`auto-enroll.ts`）、夜间批量补库 QuizGenTask/SourcingTask（`src/server/boss/handlers/quiz_gen.ts`/`sourcing.ts`）、VariantGen（`variant_gen.ts`）。**Copilot 内联出题路不受本契约约束**：ADR-0031 D2 已拍板 inline 路 verify gate 直接交用户（user-accept = gate），信任 SKILL.md + `author_question` schema，不设独立 verify 步。区分判据 = 「有没有人在环里实时审」：inline 路 owner 当场看到题并 accept（人就是 gate），后台路没有实时人审（必须机检 gate）。

---

## 后果

**正面**
- 三套信任闸（OCR 单信号 / QuizGen 五轴 / Variant accept-first）收敛到一个 verify result 形状 + 一个 verify-then-promote 方向，「内容能不能进库」的判断从此一处定义、可统一单测、可统一观测。
- 客观题走确定性校验零烧 LLM，且与 B1 fixed-anchor 共用同一个 owner 客观题事实源——verify 侧省成本、标定侧得干净锚，一份作答两处复用（总账「收敛 + 接通」的精确落点）。
- item-model 变式（人 accept 模板 + 代码实例化）根除「所见 ≠ 入库」的变形风险，实例化确定性可回放。
- 'error' 通道独立无依赖先做，立即解决「瞬态故障被当 fail、或 fail 被当瞬态故障重试」的两类误判，且不阻塞 pg-boss redelivery 语义。
- auto-enroll 从「生产从未跑过的二态开关」推进为可观测的 source-tier 灰度——authentic + 客观题 + 确定校验这一最保守切片先吃到自动入库收益，符合 A/B/C 出手强度表的静态可逆性兜底。
- Variant 翻转后信任方向与全链一致（先验证后入库），消除 ADR-0018 遗留的信任倒置。

**代价 / 风险**
- OCR 闸从「确定性单标量裁决」收编为「统一契约的一个 axis」需重写 `workflow-judge.ts` 的下游接线——WorkflowJudge 仍算它的 `combined` 标量，但 promote 决策权移交多轴 rollup，是一次接线重构（非纯加列）。
- 灰度阈值、下一档放行条件、N 周观测窗口全是单用户无 cohort 的时间瓶颈（Phase 2 §5.3 + D-3）：source-tier 灰度的「authentic 之后还能放行哪一档」在埋点攒够前**不可用是特性非 bug**，owner 须接受先只放最保守一档。
- 客观题确定性校验的「答案对得上语料」依赖语料锚的覆盖与正确性——古文开放题这一大类**结构性走不了确定性校验**（B1 §7.2 古文开放题外推零文献天花板），只能继续走 LLM 多轴 verdict（软轨低置信），verify 闭环对开放题的强度天然弱于客观题，这是有效性天花板不是工程缺口。
- item-model 模板化变式对「不易参数化的开放题」适配差——模板 + 槽位实例化天然适合客观/解题型，古文翻译/赏析类难抽出确定性参数槽，这类仍退回 LLM 生成 + 多轴 verify，杜绝所见≠入库的承诺对它们打折。

## 备选（已否决）

- **保留三套独立信任闸只补文档对齐**（不收敛）——否决：三套方向矛盾（verify-then-promote vs accept-first）+ 信号维度不一致（单标量 vs 五轴），文档对齐治不了「同一判断三处分叉」的根因，且 OCR 单信号闸结构上看不见「题对不对」。
- **verify 全交 LLM 多轴（含客观题）**——否决：客观题答案能确定性比对语料，再问一次 LLM 是纯浪费且引入 LLM 幻觉风险；确定性校验既省成本又比 LLM 更可信，且复用 B1 anchor。
- **auto-enroll 直接全 ON**（取消灰度）——否决：违反 A/B/C 静态可逆性兜底 + 单用户无第二审计人（Phase 2 §4.2「A 档门槛必须比工业 HOTL 更严」），自动入库是替用户写持久学习数据，必须从最保守 source-tier 切片起步。
- **把 copilot inline 路也纳入统一机检 verify 契约**——否决：inline 路 owner 当场人审即 gate（ADR-0031 D2 已拍板），再加机检闸是把「人在环」的优势浪费掉，且与 full-capability copilot 原则相悖。
- **Variant 保持 accept-first 仅加事后 verify**——否决：accept-first 让未验证内容先进 `active` 池被轮换选中作答，污染 FSRS/p(L) 信号；翻转为 verify-then-promote 才与全链信任方向一致。
- **'error' 通道并进 `fail` 不单列**——否决：瞬态故障该重试、真实 fail 该弃用/回 review，合并会让一次性故障把 draft 永久 strand（或让真实 fail 被无限重试），`quiz_verify.ts:189-192` 现有逻辑已证明二者必须分开。
