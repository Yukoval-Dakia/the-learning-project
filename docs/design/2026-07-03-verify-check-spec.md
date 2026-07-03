# verify-check-sets-tier-solve-threshold — 设计 spec（打磨 worklist #8，reconciled v2）

> **Program**: YUK-538（全项目逻辑打磨），单元 `verify-check-sets-tier-solve-threshold`（master register
> `docs/design/2026-07-02-project-logic-master-register.md` 约 line 961 ESCALATE trace + 约 line 1150
> reslotting 表 "ACCEPT. Strongest P1 of the four"）。
> **Provenance**: research dossier `scratchpad/research/2026-07-02-worklist-verify-check-research.md`（三腿
> code/lit/OSS）。本终稿经两轴对抗评审（Lens A 判定语义轴 / Lens B 接线运行时轴）逐条裁决 + 对 live main
> `b7d6dd27` 重接地（`git rev-parse HEAD` 实测一致）。裁决 ledger 见文末附录。
> **接地**: main `b7d6dd27`。本单元规模在 v2 缩小为 **两文件**（`verify-framework.ts` + `quiz_verify.ts`）——
> v1 的 `source_verify.ts` DRY 重构被裁掉（见 Q5：无真实第二消费者，避免在工作正常的 tier2 handler 上做行为
> 保持重构徒增风险）。
> **红线**：n=1 不拟合 item 参数；AI 判定阈值/否决权语义 = 呈选项+强论证或 owner 拍（本 spec 对否决权语义
> 显式拆成"可自裁的机制"与"必须 owner 拍的默认值"两层，见 Q1 + 文末开放问题）；数据门只 gate 翻转不 gate
> build；evidence-first 可追溯可回滚；`audit:draft-status` 谓词纪律（零新 INSERT，UPDATE-only）；成本护栏两层
> 惯例；模型 id 纪律（§现状 3 逐一核 `src/ai/registry.ts`）。

---

## 0. 对抗评审后的核心转向（v1 → v2）

v1 的诊断（"接线遗漏，该接"）**幸存**，三腿收敛 + Questgen.ai 同构反面先例稳固，不重开。两轴对抗打穿的是
v1 给自己发的**否决权许可证**——它建在一句对 exact-path 为假的话上。三处 CONFIRMED（对 `b7d6dd27` 实测）
的机制事实推翻了 v1 的 Q1 论证，并连带修正 Q2/Q5/Q6/Q7 + 测试范围：

1. **否决信号不是一条路，是可靠性天差地别的两条路**（Lens A MAJOR-1，CONFIRMED）：
   - **semantic 路**（open 题）：`runSemanticJudge` + `confidence>=0.8` 保守门（verify-framework.ts:393-394）
     —— 真保守，配享否决。
   - **exact 路**（choice/true_false/fill_blank）：`normalizeAnswer`（:199-205）= 仅 NFKC + lowercase +
     strip 空白，然后 `refCandidates.includes(candidate)` 二值字符串相等（:347）。**无 confidence 门、无
     boolean 同义（真/对/正确/√/T）、无数值等价（0.5↔1/2、集合排序、去单位）、无 LaTeX↔十进制。** v1 Q1
     论证 #1 说"fail 已经是高置信度、经过保守阈值过滤的判定"——**这句话对 exact 路是假的**，0.8 门只在
     semantic 路。
2. **tier3/4 的 generator=solver=judge 全同模型**（§现状 3，CONFIRMED registry.ts）：QuizGenTask(:721) /
   SolutionGenerateTask(:705) / QuizVerifyTask(:741) / SemanticJudgeTask(:317) 全 `mimo-v2.5-pro`。exact 路
   把**同一个模型对同一个正确答案的两次格式抖动**（generator 写 `reference_md`、solver 写 `final_answer`）
   当作"题错"。这正是 RQA 文献专门警告的 generator=solver 区间——不是 v1 声称的"与 tier2 架构对称"。tier2 的
   reference 锚在真实网源 extract 上（source_verify.ts:191-204 强制 overlap），tier3/4 的 reference 是同模型
   自造，**是新风险类别，不是对称扩展**（Lens A MAJOR-2，CONFIRMED）。
3. **quiz_gen 不写结构化 `reference_solution.final_answer`**（CONFIRMED，quiz_gen.ts:675-676 只写
   `reference_md` + `rubric_json`，后者承载 keywords/required_points，无 reference_solution）。所以 exact 路的
   `referenceAnswerCandidates`（verify-framework.ts:177-197）对 quiz_gen 行**必然回退到整段 `reference_md`**
   （:195-196）——而 F2 注释（:171-176）**自己承认**"Comparing an exact solver answer against an entire
   worked solution would falsely fail"。v1 把这个已知假否决源直接升级成了否决权。

**净转向**：接线照做，但**否决权按比对轴（`compared_by`）拆开发**——semantic confident-fail 配享否决（保守门
已在）；exact normalize-mismatch **默认不当作"证明题错"的硬否决**，而是 hold-for-review（stays draft +
`needs_review`，人工可见，全留痕），且**用独立 flag 控制**，能单独关掉 exact 假否决而不动 semantic 否决。是否
给 exact 路发完整否决权，是需要 boolean/数值等价归一先落地 + owner 拍板的**独立决策**，不在这次接线里默认打开。

---

## 现状与问题（接地 `b7d6dd27`）

### 1. 声明层完整，tier3/4 消费层缺失（核心缺口，未被对抗推翻）

`CHECK_SETS_BY_TIER`（`src/server/quiz/verify-framework.ts:61-79`）为四 tier 声明检查集，`solve_check` 出现在
tier2/3/4。`checksForTier`（:81-83）纯读该 map，声明层无 bug。

`runSolveCheck`（:262-403）是**唯一真正独立的求解验证**：调 `SolutionGenerateTask`（与 QuizGenTask/
QuizVerifyTask 不同 task/prompt 维度，:14-25 docblock）→ 解析 `reference_solution.final_answer`/
`answer_equivalents` → 按题型分叉：exact 题（EXACT_KINDS `{choice, true_false, fill_blank}` :155，或
`choices_md` 非空，:157-169）走 `normalizeAnswer` 字符串比对（:337-356）；open 题走 `runSemanticJudge`
（question-contract.ts:237）+ 保守阈值 `SOLVE_CHECK_SEMANTIC_THRESHOLD=0.8`（:149），只有
`coarse_outcome==='incorrect' && confidence>=0.8` 才判 fail（:393-401）；solver 抛错/空答案/无参考答案 →
`unsupported`（:309-334，不拦截）。

**只有 `source_verify.ts`（tier2 唯一 handler）真调用它**（:369-374，promote 谓词 :382
`knowledgeAlive && !checks.some(c => c.verdict==='fail')`）。**tier3/4 唯一 handler `quiz_verify.ts` 只
`import { checksForTier }`（:57），全文件 `runSolveCheck`/`SolutionGenerateTask` 零命中。** `tierChecks`（:269）
只喂 `kindConformanceChecked`（:310）+ `materialGroundingOk`/`kindConformanceOk`（:363-365、:372-373）。promote
谓词（:382-387）无 `solveCheckOk` 项。

**架构区分（solve_check 核心价值来源）**：`checksPass`（:347-348）/`materialGroundingOk`/`kindConformanceOk`
全来自**同一次** `runTaskFn('QuizVerifyTask',...)`（:317）的单一 JSON（closed-book 自复核）。solve_check 若接线，
是 tier3/4 全部检查中**唯一**触发独立第二调用（SolutionGenerateTask）的检查——文献要求的"外部锚点"。但见下方
§现状 3：这个"外部锚点"用的是**同一个模型**，独立性只在 task/prompt 维度，不在模型维度。

### 2. tier 派生 + 生产量级

`deriveSourceTier`（`src/core/schema/provenance.ts:129-168`）：tier3 要求 `source==='quiz_gen'` 且
`generation_method==='material_grounded'` + `material_source_document_id`（:154-162）；**tier4 是 "everything
else" 兜底**（含 `search_grounded`/`closed_book`，:165-167）。`quiz_verify.ts:206` 只处理 `source==='quiz_gen'`
行 → 该 handler 每行只可能 tier3 或 tier4，两者 `CHECK_SETS_BY_TIER` 都含 solve_check（无"某 tier 不含
solve_check"的空分支）。

`quiz_gen.ts:685` INSERT `draft_status:'draft'`（Option B，verify 前不进池）。夜间 `question_supply_nightly.ts`
`DEFAULT_MAX_PER_RUN=25`（供给目标硬顶）× `desiredCount`(典型 1-2) ≈ 每晚数十道 quiz_gen 题，全落 tier3/4，
今天**零 solve_check 缓解**进 promote→FSRS 池；手动 `POST /api/questions/quiz-gen`（`count` 无上限）追加。

### 3. 模型同源（OF-4(ii)，本单元不动，但对 Q1 判定至关重要）

`src/ai/registry.ts` 实测：SolutionGenerateTask(:705) / SemanticJudgeTask(:317) / QuizGenTask(:721) /
QuizVerifyTask(:741) **全为 `mimo-v2.5-pro`**。这是 verify-framework.ts:24-25 docblock 记录的 OF-4(ii)，register
主体已判 KEEP（deferred tuning knob）。本单元不重开该 tradeoff，但**Q1 的否决权论证必须正视它**：tier3/4 的
"独立求解"是同模型不同 prompt，格式抖动型假否决（0.5 vs 1/2、真 vs 正确）是**常态而非异常**——这是 exact 路
默认不发硬否决权的核心理由。

### 4. 留痕基础设施已就绪，零 schema 需求（未被对抗推翻）

`VerifyAxisVerdict`（`verify-contract.ts:74-86`）已含 `'unsupported'`（:79），`SolveCheckVerdict`
（`'pass'|'fail'|'unsupported'`，verify-framework.ts:119）是其真子集；`VerifyAxis`（:88-93）=
`{axis_name: string.min(1), verdict}`。solve_check 结果的完整审计（含 `reason`/`compared_by`/`solver_final_answer`）
落在既有 `event.payload` jsonb 的专属块（镜像 material_grounding :543-553 / kind_conformance :554-563 写法），
**零 DDL**。axis 只携 `verdict`（不依赖 note 投影是否存活——避免 v1 M5 的 reason→note 重命名脆点）。

### 5. `audit:draft-status` 无关（未被对抗推翻）

`quiz_verify.ts` 全程 UPDATE（promote :456-463 / 非 promote :507-513），无 INSERT。唯一 INSERT 站点
`quiz_gen.ts:685` 已显式 set `draft_status`。本单元只在 UPDATE 分支加否决项，不改"INSERT 是否显式带
draft_status"，`audit:draft-status` 谓词纪律不受影响。

---

## 目标与非目标

**目标**：
1. 让 tier3/4 声明的 `solve_check` 真正被 `quiz_verify.ts` 消费——关闭 register P1 缺口（"least-trusted
   AI-generated tiers enter the pool today with zero mitigation"）。
2. **否决权按比对轴分发**（semantic 配享 / exact 默认 hold-for-review 且独立可关），显式裁决 Q1-Q7 并留痕。
3. 复用 tier2 已验证的 `runSolveCheck` 原语与 `SolveCheckQuestion`/`SolveCheckResult` 契约，零 schema 改动。
4. **短路 solve-check 调用**：只在其它免费检查全 pass 时才花独立 solver 的钱（省成本 + 锐化 rollback 信号）。
5. 新增测试覆盖 pass/fail/unsupported 三路径 + "solve_check 单独否决"边界 + flag-off 回退，**并显式迁移既有
   suite 的 call-count/mock 断言**（Lens B M1，接线后每道 tier4 测试多打一次 task）。

**非目标**：
- **不改** `runSolveCheck` 判定逻辑本身（阈值 0.8、exact/open 分叉、`normalizeAnswer` 规则）——OF-4(i) 已 KEEP。
- **不解决** OF-4(ii) 同模型盲点——已 KEEP，只显式记录并作为 Q1 exact-path 保守化的理由。
- **不新增/修改任何 zod schema**。
- **不引入多样本/self-consistency**（Q2 单样本，见下）。
- **不为数理域做差异化阈值**（Q6 DEFER）。
- **不重构 `source_verify.ts`**（v1 的 DRY 提取被裁，Q5）。
- **不实现全局 `$` circuit breaker**（register 已 ESCALATE 的独立 gap）+ **不治理手动端点 count 硬顶**（Q7，
  独立 Linear follow-up）。

---

## 决策表

### Q1 — promote 谓词语义：否决式 vs 软信号 vs 分层【本单元最重要决策，v1 被对抗推翻后重裁】

| 选项 | 依据 | 代价/判决 |
|---|---|---|
| (a) 全轴否决式（v1 方案） | 与 tier2 一致 | **REJECT。** Lens A MAJOR-1/2 CONFIRMED：exact 路是无 confidence 门的裸字符串相等，同模型格式抖动是假否决富集区；v1 的"fail 高置信度"论证对 exact 路为假；tier2 对称性方向反了（tier2 reference 网源锚定，tier3/4 同模型自源） |
| (b) 纯软信号（fail 一律不否决，只记分） | Lit MATHWELL/RQA | **REJECT。** 会让整个单元退化成"付 100-200% 成本、拦不住任何题"的遥测——P1 敞口原样保留。且 MATHWELL/RQA 测的是假 PASS，不覆盖否决权最危险的假 FAIL 侧，不能用来给"全不否决"背书 |
| **(c) 按比对轴分层否决【裁决】** | 见下 | semantic confident-fail → 否决；exact normalize-fail → 默认 hold-for-review（阻促进但记 `needs_review` 非 `failed`），独立 flag 可单关；owner 拍 exact 默认值 |

**裁决：(c) 按 `compared_by` 分层。** 论证：

1. **两条路可靠性不对称是 CONFIRMED 的机制事实**（非文献推测）：
   - **semantic 路配享否决**：`confidence>=0.8` 保守门（:393-394）+ "宁可漏过不误杀真题"（docblock）已经是文献
     要求的保守设计。一个高置信度的独立语义判定不一致，值得阻止促进——这个更窄命题 MATHWELL/RQA 均未直接反驳
     （它们测假 PASS）。
   - **exact 路默认不发硬否决**：`normalizeAnswer`（:199-205）无任何置信过滤，且对 quiz_gen 行必然拿 solver 一行
     `final_answer` 撞整段 `reference_md`（§现状 0.3，F2 注释自认 "would falsely fail"）。true_false 更毒：
     `EXACT_KINDS` 含 `true_false`（:155）但 true_false 无 choices_md（source_verify.ts:105-109 注释确认），label
     展开对它无效，`"正确"≠"真"` 稳定假否决，且 verify-framework 内无 boolean 同义表。
2. **"独立 ≠ 更可信"**：一个**独立但脆**的信号（exact normalize）完全可能比自证信号误判率更高。独立性是信息来源
   性质，可靠性是误判率性质，v1 把两者划了等号。§现状 3 给出独立信号误判率高于自证的具体机制（同模型格式抖动）。
3. **假 FAIL 率零外部证据，如实承认**：被引文献（MATHWELL EC 通过率、RQA 33%）全是**假 PASS** 数据；本项目否决权
   的真实风险是**假 FAIL**（把对题杀掉），文献一个字没测（在那些论文里 solve-check 是过滤器，假 FAIL 只降产出率、
   不伤学习完整性；本项目把过滤器改成否决闸，假 FAIL = 一道正确的珍贵 n=1 题被杀）。这呼应 dossier 净指引 #6 的
   文献空白 + R2 原则（verify-framework.ts:255-256 "宁可漏过不误杀真题"）。**在残集大小和假 FAIL 率都未知时，
   默认把不确定性往"少杀题"方向 round。**
4. **机制上如何落地分层**：exact-path fail 与 semantic-path fail 都**阻止 promote**（都让草稿留 draft），但：
   - 二者由**两个独立 flag** 控制（不是 v1 的单一全局 bool）：`SOLVE_CHECK_TIER34_VETO.semantic`（默认 `true`）
     与 `SOLVE_CHECK_TIER34_VETO.normalize`（默认值 = **owner 拍**，见文末开放问题①；spec 推荐初始 `true` 但记
     `needs_review` 而非 `failed`，即"阻促进+待人复核"而非"判定题错"）。这直接回应 Lens A MAJOR-1 尾："单一
     flag 不能只关 exact 假否决、留 semantic 否决"。
   - **记录语义区分**：solve-only 阻促进且 `parsed.overall==='pass'` 时，`verificationStatus` 落既有
     `needs_review` 分支（:392-396），`event.outcome='partial'`（:524）——与 material_grounding/kind_conformance
     今天行为一致。exact-path 的不一致记为 `needs_review`（"待人复核"）而非 `failed`（"证明题错"），诚实反映
     normalize 比对的弱信号性质。
5. **可回滚不是空话，且已免费可观测**（呼应 dossier 对抗角度 #1）：两个 flag 是 module-level（跟随
   `SOLVE_CHECK_SEMANTIC_THRESHOLD` 等既有 plain-const 惯例）。**诚实标注**（回应 Lens B m6）：翻 flag 需 source
   edit + esbuild 重 bundle + worker 容器重部署，**不是运行时 toggle**（对比 `AI_PROVIDER_OVERRIDE` 的 env
   运行时开关）。为让 flag-off 可单测且不新增运行时配置面，否决判定抽成**纯函数 seam**
   `solveCheckBlocks(result, flags)`（见 M1），测试直接传 flags，无需 `vi.doMock` 静态 import。观测：Q4 把
   `compared_by`/`verdict`/`reason`/`solver_final_answer` 写进 `event.payload`，owner 可 SQL 查 exact-path fail
   分布对照人工复核（`needs_review` 草稿在既有 Option B review 面可见——**注意**：该 review→人工回写"这题其实对"
   的闭环是否已一等公民存在，本 spec 未 ground，见 Q6 诚实降级 + 开放问题）。

### Q2 — 采样策略：单次 vs 多样本 vs 自适应【裁决保留但论证重写】

**裁决：(a) 单次 solve。** 但论证基于**成本 + Q1 的轴分层使单样本安全**，删除 v1 对 Wang 2022 / 2511.00751 的
错误刻画（Lens A MAJOR-3 CONFIRMED 这两处误用）：

1. **成本（真实、保留）**：§现状 2 每晚数十题，exact +1 / open +2 次调用。多样本再乘 N。Q1/Q7 的
   "+100-200%/题" 是 eager 成本，而 M2 的短路进一步把它压到"仅 all-else-pass 的题"才花。
2. **删除 v1 的 Wang 2022 误用**：v1 说"Wang 测推理链内部投票，非生成 vs 独立求解场景"——**这是错的**。
   self-consistency 用在 solve-check 里就是对 solver 那次求解抽 N 次、对 `final_answer` 多数投票，直接降 solver
   方差，正是 Wang 的原样用法。不用"场景不同"驳回一个同构技术。
3. **删除 v1 的 2511.00751 误用**：v1 引它证"多样本收益萎缩"，但 2511 是前沿模型（Gemini 2.5）负结果；本项目
   solver 是 `mimo-v2.5-pro`（非前沿），弱 solver 噪声更大，self-consistency 收益**更大**，2511 结论很可能**不
   迁移**。不搬出适用条件外的论文。
4. **单样本为何仍成立**：不是因为 self-consistency 无用，而是因为 **Q1 的轴分层已把单样本的主要代价（假 FAIL）
   兜住**——exact 路默认 hold-for-review（可关），semantic 路有 0.8 门 + "宁可漏过"。单样本 fail 触发的是"待人
   复核"而非"昂贵的确定性杀题"，所以单样本此波自洽。**若上线后 semantic-veto 的假 FAIL 率被观测证明偏高**，
   owner 可选的最小升级是**确认性重解**（fail 触发第二次 solve，两次都 fail 才 veto）——比无差别多采样便宜，
   且只作用于真正 veto 的那一侧。留作 owner 选项，不在本波。
5. **删除 v1 的自适应 DEFER 触发判据**（Lens A MAJOR-3 CONFIRMED 其自相矛盾）：v1 说触发条件是"solve_check fail
   但其它信号都强烈支持"——但其它信号（material_grounding/kind_conformance/grounding）**全来自同一次闭卷
   QuizVerifyTask 自复核**（§现状 1 自己论证的）。"独立信号 fail 但自复核 pass"若回落去信自复核，就否定了
   solve_check 存在的全部理由。这个 DEFER 判据不可操作，删除，不作为"以后能补"的退路。

### Q3 — 失败题处置

**裁决：复用既有三态，不新建处置路径。** `quiz_verify.ts` 既有 `verificationStatus`
（`verified|needs_review|failed`，:392-396）+ `writeAgentNote`（:587-611）对"solve_check 阻促进"天然覆盖：

- solve_check block + `parsed.overall==='fail'` → `failed`（既有分支）。
- solve_check block + `parsed.overall==='pass'`（自复核觉得没问题、独立求解不同意）→ `needs_review`（既有分支，
  与 materialGroundingOk/kindConformanceOk fail 今天同路径——solve_check 只是 AND 链上第三个能触发它的项）。
- 两种都 `draft_status` 保持 `'draft'`（既有 else :507-513 只写 metadata/updated_at，不碰 draft_status）——draft
  从未被写 active（Lens B m7 的不变量，见 M2 注释），不存在"降级"动作。
- `!promote` 的 `writeAgentNote`（:587-611）已按 `!promote` 布尔触发，solve_check 阻促进自动纳入。

"重生成"不在本单元（既有失败分支均不触发自动重生成，solve_check 单独获此能力会破坏一致性；是横跨全部失败原因的
独立产品决策）。

### Q4 — 留痕形态

**裁决：payload 专属块（权威审计）+ axis verdict（不依赖 note 投影）。**

- **payload 块**（现 :541-563，material_grounding/kind_conformance 之后）追加，镜像其条件 spread 写法：
  ```
  ...(solveResult
    ? { solve_check: { verdict, compared_by, solver_final_answer: solveResult.solver_final_answer ?? null,
                       reason } }
    : {}),
  ```
  `compared_by`/`solver_final_answer` 是 `SolveCheckResult` 既有字段（:121-129），非新造；写进 payload 是唯一
  新增表面积，落既有 jsonb，零 DDL。**注意**：门在 `solveResult`（短路后可能 undefined），不再用
  `tierChecks.includes('solve_check')`（对 quiz_verify 恒真）。
- **axis**：`unified.checks`（现 :416-431）条件追加 `{ axis_name: 'solve_check', verdict: solveResult.verdict }`
  ——**只携 verdict**，reason 走 payload 块（避免 v1 M5 的 reason→note 重命名脆点；VerifyAxis :88-90 base 形状
  只保证 axis_name+verdict，note 投影是否存活未 ground，不依赖它）。
- `event.outcome` 派生（:524）不改，solve-only block + overall='pass' → `partial`，与既有一致。
- **成本记账诚实记录**（§现状同 tier2）：`SolveCheckRunTaskFn` 返回形不携 cost，payload `cost_micro_usd` 继续只
  反映 QuizVerifyTask 一次调用（与 source_verify `cost_micro_usd: null` 对称）；真实 `$` 经 `runTask` 独立
  `writeCostLedger` 入全局账本，不被本 verify 事件复述——如实记录，不假装解决。
- **ingest_at / memory-outbox（Lens B m8，per #695 O1）**：本单元给 `experimental:quiz_verify` 事件**不新增
  event action**（cardinality 不变），outbox poller（`triggers.ts WHERE ingest_at IS NULL`）的谓词面因此
  genuinely 不受影响。新增的 `solve_check.reason` 字符串可能引用 solver 答案/题目参考答案；若该事件将来 feed
  memory embedding，这段文本随之流入（additive JSONB，无新 action，低真实风险）。一行注释记录该交互，不留待
  未检查。

### Q5 — tier2 先例复用边界【v1 裁决被推翻】

**裁决：不抽共享 helper，`source_verify.ts` 完全不动。** 论证（Lens B m5 CONFIRMED）：

v1 想抽 `solveCheckAxisNote(result) → {verdict, reason}` 给两个消费者共用。但它匹配 source_verify 的
`CheckOutcome{check,verdict,reason}`，**不匹配** quiz_verify 的 axis `{axis_name,verdict}`（+ payload 的
`reason`）——需要 reason→note 重命名，导致 v1 自己都写成"可内联的别扭 `.map(({reason,...rest})...)`"。抽出来后
**只有 source_verify 一个真实消费者**（quiz_verify 这边直接读 `solveResult.verdict`/`solveResult.reason`），**没有
第二个消费者会漂移**，register G4 `notdraft-predicate-duplication` 的类比不成立（那是 ~17 处真手抄）。

`source_verify.ts:266-275` 的 `solveCheckToOutcome` 虽是恒等三元，但它工作正常、有测试回归。为一个不存在的 DRY
收益在**工作正常的 tier2 handler** 上做行为保持重构，是净增风险（要跑 source_verify 全套回归证明"行为不变"）。
**裁决：quiz_verify 直接内联 verdict/reason，source_verify 保持字节不变，本单元只碰两文件。**

### Q6 — 数理域差异化阈值【裁决保留，观察钩子诚实降级】

**裁决：DEFER 不做代码差异化。** 但**诚实降级 v1 对观察钩子的过度承诺**（Lens A MINOR-1 CONFIRMED）：

1. RQA（arXiv 2410.15512）未同行评审，dossier 降权；本项目题库数理占比未知（dossier 空白）——现在设"数理走不同
   阈值"分支是编造尚不存在的题型判据（哪个 `kind`/`knowledge_ids` 算数理？该分类本身需独立设计，非本 scope）。
2. **钩子只能产出未标注的 fail 计数，不能算假阳性率**：Q4 记 `verdict`/`compared_by`/`solver_final_answer`，但
   **不记 ground-truth**（这个 fail 到底是真 fail 还是假 fail）。要算"数理题假阳性率是否过高"（Q6 DEFER 的正是
   这个）需人工逐条裁决每个 fail。v1 说"draft 在 review UI 被人工看到"——但**未 ground** review 面是否单独暴露
   solve_check-vetoed 的 draft、是否把人工"这题其实对"回写进可分析库。**无标签 → 钩子只产 fail 计数 → 计数混淆**
   （数理题 fail 多，可能真更常坏，也可能 normalize 更常假否，两者不可区分）。
3. **钩子切不了数理域**：`compared_by='normalize'` 不标识数理（choice/词汇 fill_blank 也走 normalize），`kind` 不
   编码学科。v1 一边说"数理分类器不存在所以不做差异化"，一边说"钩子能按数理域切片"——自相矛盾。DEFER 的理由
   （无分类器）恰好也让钩子无法按数理切片。

**诚实结论**：观察钩子产出的是**未标注的 fail 计数 + compared_by 分布**，对"数理是否需差异化"这个决策价值有限
（需人工标注才能升级为假阳性率）。这与 Q1 的"默认往少杀题 round" + exact-path hold-for-review 绑定：先让 fail
可见、攒分布，再谈是否升级为硬 veto 或数理差异化——与"数据门只 gate 翻转不 gate build"红线一致。**真钩子**（人工
在 review 面对 solve_check-veto draft 打真/假 fail 标签并回写）是新 scope，不在本单元。

### Q7 — 成本护栏 + 手动端点无硬顶【裁决保留，理由修正】

**裁决：本单元不新增护栏代码；手动端点硬顶记独立 Linear follow-up。** 但**修正 v1 的"正交"理由**（Lens B M4
CONFIRMED 反了）：

1. **硬顶层**：solve_check 只在 quiz_verify 触发，quiz_gen 行的产生已被夜间 `DEFAULT_MAX_PER_RUN=25` 结构性限流；
   接线不改这层，只让被限住的题 verify 阶段多 1-2 次调用（既有硬顶的线性放大，非新无界面）。
2. **warning 层**：`cost-today.ts`（register 已描述的 pull-only 面）自动汇入额外调用（`runTask` 记账独立于本单元）。
   零 push 告警是 register 已 ESCALATE 的**横跨全部 AI task 的独立缺口**，不塞进本窄单元（反向的 scope 碎片化——
   把大特性捏进小接线）。
3. **手动端点 count 无硬顶，修正 v1 的"正交/钱主要花在 QuizGenTask"**：本单元把每题**边际 verify 成本从 1 →
   2-3 次 LLM 调用**，所以一个无界 `count` 现在乘的是**已变 material 的 verify 成本**。`quiz_verify` 跑在 AGENT
   队列（2h expire + DLQ），大批 `count=N` 的链式 quiz_verify job 现在跑 ~2-3× 长，可能刮到 2h 顶（幂等守卫
   自愈，但 expire-retry 浪费）。**solve-check 让手动端点硬顶更 load-bearing，不是正交。** 仍留独立 Linear
   follow-up（改 `handlers.ts` 路由/校验，与本两文件不相交），不在本 PR，但去掉"正交/主要 QuizGenTask 成本"
   的说辞。

---

## 机制设计（文件/函数级，接地 `b7d6dd27`）

### M1 — `verify-framework.ts`：两轴否决 flag + 纯函数否决 seam（无 helper 提取）

紧邻 `SOLVE_CHECK_SEMANTIC_THRESHOLD`（现 :149）之后新增：

```ts
// YUK-538（本 spec Q1）— tier3/4 按比对轴（compared_by）分层的否决开关。solve_check 是 tier3/4 唯一独立于
// 自复核 QuizVerifyTask 的信号，但它的两条比对路可靠性天差地别：
//   - semantic（open 题）：runSemanticJudge + confidence>=0.8 保守门（:393-394）→ 配享否决。
//   - normalize（exact 题）：裸 NFKC+lowercase+strip 字符串相等（:199-205），无置信门、无 boolean/数值等价，
//     且对 quiz_gen 行必然拿 solver 一行 final_answer 撞整段 reference_md（F2 注释 :171-176 自认 "would
//     falsely fail"）。tier3/4 generator=solver=mimo-v2.5-pro（registry.ts:705/721），同模型格式抖动
//     （0.5↔1/2、真↔正确）是假否决富集区 → 默认阻促进但记 needs_review（"待人复核"非"证明题错"），可单关。
// 两个 flag 独立：能只关 exact 假否决、留 semantic 否决。翻 flag 需 source edit + esbuild 重 bundle + worker
// 重部署（非运行时 toggle，对比 AI_PROVIDER_OVERRIDE）。normalize 默认值由 owner 拍（见 spec 开放问题①）。
// 详见 scratchpad/research/2026-07-03-verify-check-draft.md §Q1。
export const SOLVE_CHECK_TIER34_VETO = {
  semantic: true,
  normalize: true, // owner-decision default; hold-for-review (needs_review), NOT proven-wrong
} as const;

// 纯函数否决判定（测试 seam，回应 Lens B m6）：接 SolveCheckResult + flags，返回是否阻促进。测试直接传
// flags 覆盖，无需 vi.doMock 静态 import，也不新增运行时配置面。unsupported/pass 永不阻促进（R2 保守）。
export function solveCheckBlocks(
  result: SolveCheckResult,
  flags: { semantic: boolean; normalize: boolean } = SOLVE_CHECK_TIER34_VETO,
): boolean {
  if (result.verdict !== 'fail') return false;
  if (result.compared_by === 'semantic') return flags.semantic;
  if (result.compared_by === 'normalize') return flags.normalize;
  return false; // compared_by === 'none' 不会伴随 verdict='fail'，防御式
}
```

`runSolveCheck` 本体（:262-403）**不改一行**。

### M2 — `quiz_verify.ts`：短路接线 solve_check + 分层否决 + payload

**import 段**（现 :57 附近）追加：

```ts
import {
  type SolveCheckQuestion,
  runSolveCheck,
  solveCheckBlocks,
  checksForTier, // 既有
} from '@/server/quiz/verify-framework';
```

**短路 gate + 否决**（回应 Lens B M3 的 eager-spend + 物理不可能的插入位置）。**正确位置**：在
`materialGroundingOk`（:363-365）/ `kindConformanceOk`（:372-373）**都算完之后**、`promote`（:382-387）**之前**
插入（注意 `checksPass`/`isTooClose` 在 :346-348，本就在 kindConformanceOk 之前——v1 说的"插在 :372 之后、
:346 之前"物理矛盾，实际全部输入项在 :382 promote 处汇合，solve 块插在 :373 与 :382 之间）：

```ts
// YUK-538（本 spec §Q1 + Lens B M3）— 短路：solve_check 是 tier3/4 唯一独立第二调用（贵）。只在其它免费检查
// （全来自单次 QuizVerifyTask 自复核）都 pass 时才花独立 solver 的钱——短路不改 promote 结果（&& 链里 solve
// 是最后一项，前面任一 false 则 promote 已定 false），但省成本 + 锐化 rollback 信号（solve verdict 只出现在
// 它是边际否决的行，不 smear 到已注定失败的行）。tierChecks 对本 handler 恒含 solve_check（每行 tier3/4），
// 但仍显式 gate 防御 CHECK_SETS_BY_TIER 未来重配。
const freeChecksPass =
  parsed.overall === 'pass' && checksPass && !isTooClose && materialGroundingOk && kindConformanceOk;
const solveResult =
  freeChecksPass && tierChecks.includes('solve_check')
    ? await runSolveCheck(
        {
          id: row.id,
          kind: row.kind,
          prompt_md: row.prompt_md,
          reference_md: row.reference_md,
          choices_md: row.choices_md,
          judge_kind_override: row.judge_kind_override,
          rubric_json: row.rubric_json,
          knowledge_ids: row.knowledge_ids,
          metadata: metadataRaw,
        } satisfies SolveCheckQuestion,
        { runTaskFn, profile: { id: subjectProfile.id, full: subjectProfile }, db },
      )
    : undefined;
// 分层否决（Q1）：solveCheckBlocks 读 compared_by 分 semantic/normalize flag。undefined（短路/无 solve_check）
// → 不阻。
const solveCheckOk = solveResult === undefined || !solveCheckBlocks(solveResult);
```

字段来源与 `source_verify.ts:358-368` 逐字段同构（同一 row 已在作用域）。

**promote 谓词**（现 :382-387）追加 `solveCheckOk`：

```ts
const promote =
  parsed.overall === 'pass' &&
  checksPass &&
  !isTooClose &&
  materialGroundingOk &&
  kindConformanceOk &&
  solveCheckOk;
```

（注：因短路，`solveResult` 仅在前五项全 true 时非 undefined；`solveCheckOk` 在前五项任一 false 时恒 true，
`&&` 短路保证 promote 结果与"先算 solve 再 &&"完全一致。）

**`unified.checks`**（现 :416-431）条件追加（只携 verdict）：

```ts
...(solveResult ? [{ axis_name: 'solve_check' as const, verdict: solveResult.verdict }] : []),
```

**payload 块**（现 :541-563 之后）追加（见 Q4）：

```ts
...(solveResult
  ? {
      solve_check: {
        verdict: solveResult.verdict,
        compared_by: solveResult.compared_by,
        solver_final_answer: solveResult.solver_final_answer ?? null,
        reason: solveResult.reason,
      },
    }
  : {}),
```

**m7 不变量注释**（现 :505 else 分支附近，一行）：

```ts
// YUK-538（Lens B m7）— quiz_verify 无 demote 分支（对比 source_verify.ts:456-481 的 YUK-479 demote）是
// 安全的：没有任何路径在 quiz_verify 前把 quiz_gen 行预提升到 active（cold-start image-candidate-accept
// 硬编码 web_sourced→source_verify；verify-and-promote/proposal-appliers/legacy-record-appliers 的 active
// 写者均不针对未验证的 quiz_gen draft）。solve_check 新增的否决项落在既有 else，只写 metadata，不需 demote。
```

`verificationStatus`/`outcome` 派生（:392-396、:524）**不改一行**——solve-only 否决 + overall='pass' 自动落
`needs_review`/`partial`（§Q3）。

### M3 — 交叉引用注释（零行为变更）

- `verify-framework.ts` 顶部 docblock（:1-25）solve-check 段末追加一行：tier3/4 接线见 quiz_verify.ts（YUK-538，
  本 spec）——本文件 runSolveCheck/CHECK_SETS_BY_TIER 声明早于接线，勿以"tier3/4 从未消费"断言本文件有 bug。
- `quiz_gen.ts` `count` 参数附近（`QUIZ_GEN_DEFAULT_COUNT` 声明处）一行指针 → Q7 独立 Linear follow-up（防后续
  读者误以为"count 无硬顶"是本单元遗漏）。

---

## 实施切片（PR 粒度）

| # | 内容 | 类型 | 文件 | pre-flight |
|---|---|---|---|---|
| **1** | M1：verify-framework.ts 两轴 flag + `solveCheckBlocks` 纯函数 seam | server-only | 修改 `verify-framework.ts` | 无（非 UI，无 schema） |
| **2** | M2：quiz_verify.ts 短路接线 + 分层否决 + payload + m7 注释 **+ 既有 test suite call-count/mock 迁移 + 新增 5 测试** | server-only | 修改 `quiz_verify.ts`、`quiz_verify.test.ts` | 无 |
| **3** | M3：交叉引用注释 | docs-only | 修改 `verify-framework.ts` 头部、`quiz_gen.ts` | 无 |
| — | Q7 手动端点硬顶 | 无代码，仅 Linear follow-up | — | — |

**建议**：合并单 PR（两 server 文件 + 一测试文件），或 1→2→3 顺序（2/3 依赖 1 的新 export）。**source_verify.ts
完全不动。** 规模显著小于 v1（砍掉 source_verify 重构切片）。

---

## 测试与 gate

### `quiz_verify.test.ts` — **既有 suite 迁移（Lens B M1 CONFIRMED，硬性）** + 新增

**背景（CONFIRMED，`b7d6dd27` 实测）**：`seedDraftQuestion` 的 `BASE_META.generation_method='search_grounded'`
（:88）→ `deriveSourceTier` 落 **tier 4**（provenance.ts:165-167），其 CHECK_SETS 含 solve_check。所以接线后
**每道** `runQuizVerify` 测试都会（在 all-else-pass 时）多打一次 `SolutionGenerateTask`。既有 call-count 断言
**必须迁移**（v1 §测试宣称 "source_verify 零改" 正确，但**沉默**了 quiz_verify 既有 suite 需迁移）：

- **runTaskMock 换成按 kind 分发的 mock**：现 `runTaskMock`（:49-54）对所有 kind 返回同一 `verifyOutput()`。
  接线后需 `dualTaskMock(verifyText, solverText)`——`kind==='SolutionGenerateTask' ? solverText : verifyText`。
- **call-count 断言更新为新稳态**（tier4 all-pass 题 = verify + solve = 2 次/题）：
  - `:245`（pass promotes）`toHaveBeenCalledTimes(1)` → **2**。
  - `:405`（idempotency）`toHaveBeenCalledTimes(1)` → **2**（首次跑 verify+solve；第二次 skip）。
  - `:429`（retry）`toHaveBeenCalledTimes(2)` → **3**（首次在 QuizVerifyTask 就 reject 未到 solve；第二次
    verify+solve）。注意第 3 次调用命中未排队的 `vi.fn` 默认返回 `undefined` → `runSolveCheck` 解构
    `undefined.text` 抛 → 被 runSolveCheck 内 try 吞成 `unsupported` → 不阻促进，status 仍 `verified`。
  - `:642`（batch 2 题）`toHaveBeenCalledTimes(2)` → **4**。
  - 各断言的 `mock.calls[i][0]` kind 检查按新增 solve 调用相应调整。
- **tier3 material 测试（:541/:571/:600）**：同样 all-else-pass 时会多打 solve；material-missing（:571）/
  material_grounding=fail（:600）**因短路不打 solve**（freeChecksPass=false）——这些断言天然保持（solve 不触发），
  但需确认 call-count 若有断言则按短路更新。

### 新增测试用例（对齐既有 `runQuizVerify` describe，现 :232-626）

1. **solve pass + 其它全 pass → promotes**（回归接线不破 happy path；tier4 default seed + dualTaskMock 的
   solverText 给出与 reference 一致的 `reference_solution.final_answer`）。
2. **exact-path solve fail 单独否决**（Lens B M2 CONFIRMED：默认 seed 是 `short_answer`+`judge_kind_override:
   'semantic'`（:105/:109）→ `isExactQuestion` 走 open 路 → SemanticJudgeTask，dualTaskMock 的 else 分支喂
   verifyText → `SemanticJudgeOutput.safeParse` 失败 → `unsupported` → **pass**，fail 不可建）。**因此 fail-case
   必须改种一道 exact 题**（`kind:'fill_blank'` 或 `choice`+choices，judge 非 semantic），solver 给不一致
   `final_answer`，normalize mismatch → fail。断言：`draft_status='draft'`、`verificationStatus='needs_review'`、
   `event.outcome='partial'`、`payload.solve_check.verdict='fail'`、`payload.solve_check.compared_by='normalize'`、
   `unified.axes` 含 `{axis_name:'solve_check',verdict:'fail'}`。
3. **semantic-path solve fail（新覆盖，无先例可照抄）**（Lens B M2）：`source_verify.test.ts` 的 solve 测试全走
   choice/true_false 的 **normalize 路**（:96/:366），**从不 exercise semantic 路**——不能"照抄"。要测 semantic
   fail 需**三路分发 mock**：`SolutionGenerateTask`→solverText、`SemanticJudgeTask`→构造的 incorrect 判定
   （`coarse_outcome:'incorrect'`, `confidence>=0.8`）、其余→verifyText。断言 `compared_by='semantic'` + fail 阻促进。
4. **solve unsupported（solver 抛错/空答案）→ 不阻促进**（其它全 pass 仍 promote，`payload.solve_check.verdict=
   'unsupported'`）。
5. **flag-off 回退（硬性，回应 Lens B m6）**：exact fail 场景下，把 `SOLVE_CHECK_TIER34_VETO.normalize=false`
   传入 `solveCheckBlocks`——**通过纯函数 seam 直接测**（`solveCheckBlocks(failResult, {semantic:true,
   normalize:false})===false`），无需 `vi.doMock`。若要端到端验证 promote 变化，用可注入 flags 的路径（实施阶段
   若 handler 不便注入，最小化为对 `solveCheckBlocks` 的直接单测 + 一个 module-const 默认值的集成断言）。**这条
   验证 Q1 的分轴回退真生效，缺失即视为 Q1 裁决未被验证。**
6. **payload 完整性**：断言 `payload.solve_check` 四字段 `{verdict, compared_by, solver_final_answer, reason}`
   类型/非空符合（回归 Q4）。
7. **短路验证（Lens B M3）**：seed 一道 grounding=fail（overall='pass' 但 checksPass=false）的 tier4 题，断言
   `SolutionGenerateTask` **未被调用**（`mock.calls.every(c => c[0] !== 'SolutionGenerateTask')`）——证明短路
   在 all-else-pass 才花 solver 的钱。

### `source_verify.test.ts` — 零改（本单元不动 source_verify，Q5）。

### Gate

- `pnpm typecheck`（新 import + flag/seam 引用无类型错误）。
- `pnpm test:db:watch src/server/boss/handlers/quiz_verify.test.ts`（targeted；source_verify.test.ts 因零改无需
  但 pre-PR 全量会覆盖）。
- Pre-PR：`pnpm test`（含 `audit:draft-status`——零新 INSERT；`audit:schema`——零 schema 改动）。
- `pnpm build`（esbuild 全量 bundle，catch import 路径错误——`verify-framework.ts` 新 export 需被 quiz_verify.ts
  正确解析）。

---

## 开放问题（owner 级，v2 收窄+锐化）

1. **【本单元核心决策】exact-path（normalize）否决默认值** `SOLVE_CHECK_TIER34_VETO.normalize`：
   - **(a) 推荐默认 = `true` 但记 `needs_review`**（阻促进 + 待人复核，非"证明题错"）：关闭 exact 问题答案进池的
     P1 敞口，同时靠三态 needs_review + Option B review 面给假否决留人工挽救余地。**前提假设**：needs_review 的
     quiz_gen draft 有人工复核→促进的闭环（本 spec 未 ground 该闭环一等公民存在，见 Q6/开放问题③）。
   - **(b) `false`（exact 只记录不阻促进）**：零假否决风险，但**重开 exact 题（choice/fill_blank，quiz_gen 主力
     题型）的 P1 敞口**——wrong-answer exact 题继续进池，只多一条日志。与本单元存在的意义相悖。
   - **(c) `true` 完整否决，但先落地 normalize 等价归一**（boolean 同义 真/对/正确/√/T + 数值 0.5↔1/2/去单位/集合
     排序 + LaTeX↔十进制）再打开：最稳但是**独立 scope**（新 normalize 逻辑 + 逐条等价类 spec），不在本接线。
   - **reconciler 推荐 (a)**：n=1 珍贵内容 + R2 "宁可漏过不误杀真题" + 假 FAIL 率零外部证据 → 默认往"少杀题+
     人工兜底" round；semantic 路（有 0.8 门）默认 `true` 无争议。但 (a) vs (b) 是否决权语义，红线要求 owner 拍。
   - **✅ OWNER 裁决（2026-07-03，session AskUserQuestion）= (a) hold-for-review。** `SOLVE_CHECK_TIER34_VETO.normalize`
     默认 `true`：exact normalize-fail → 阻促进 + 落 `needs_review`（进 `/drafts` 池带诊断），**非** `failed`（不判"证明题错"）。
     独立 flag 可单关（只关 exact 假否决、留 semantic 否决）。前提闭环（开放问题③）已接地成立，见下。
   - **⚠ 独立 review 轮修正（2026-07-03，附录 B A1）**：Opus 深度验证钉死「无削减的 hold-for-review = exact 客观题
     近乎全量假 fail 进 needs_review → /drafts 全噪 → 自动化实质停摆」（quiz_gen 行 reference_solution 恒缺、backfill
     两路都 gate 在 reference_md IS NULL 永不进、normalize 不删标点）。已落修法 (i)：reference_md fallback 增加
     首行 + 首句（仅全角 。！？ 切分，防 3.14 截断）候选 + 双侧尾标点 trim 候选，整段候选保留。(a) 的语义不变，
     残余 normalize-fail 才进 needs_review。修法 (iii)（quiz_gen 补写 rubric_json.reference_solution，救未来行）
     记捕获门 → 协调者落 Linear。
2. **semantic-veto 的确认性重解（cheap self-consistency）**：仅当上线后观测证明 semantic confident-fail 假 FAIL 率
   偏高，才升级为"fail 触发第二次 solve、两次都 fail 才 veto"。留 owner 选项，不在本波（Q2）。
3. **needs_review → 人工促进闭环是否已存在**（Q1(a)/Q6 依赖）：本 spec 未 ground review 面是否单独暴露
   solve_check-vetoed 的 draft、人工"这题其实对"是否可回写。若不存在，(a) 的 needs_review 退化成"死 draft"，与 (b)
   仅差记录语义——owner 若要 (a) 的软性真生效，需确认或补该闭环（新 scope）。
   - **✅ OWNER 接地（2026-07-03）= 闭环已成立，不是新 scope。** `/drafts`（`DraftReviewPage.tsx`，YUK-403
     "owner manual gate 的真面"）就是这个闭环：`GET /api/review/drafts[/:id]` 列表 + 详情，`POST .../enable` /
     `POST .../force-enable` 促进（practice manifest.ts:95-111）。列表/详情按 `verify_status` 三值 chip 分面
     （`unverified` 未验证 / `needs_review` 待复核 / `failed` 验证未过；`DrVChip` + 诊断面板 +
     verify-status filter，DraftReviewPage.tsx:101-109/314-337/597）。故 (a) 的 `needs_review` draft **人工可见 +
     可回写促进**，不退化成死 draft——(a) 的软性真生效。
4. **Q7 手动端点 count 硬顶**：独立 Linear follow-up（solve-check 使其更 load-bearing，非正交）。owner 若认为紧迫
   可要求并入（多碰 `handlers.ts` 一文件）；本 spec 默认不扩展。（已捕获 YUK-555。）
5. **flag 退态 E2E 回归测试**（review B-obs-2）：flag-off 目前由 `solveCheckBlocks` 纯函数单测覆盖（直传 flags）；
   handler 消费的是 module-const 默认值，端到端「翻 flag 后 promote 变化」无运行时 seam 可驱。defer 到真要翻
   `SOLVE_CHECK_TIER34_VETO` 时补一条 `vi.doMock` 回归测试再动 const。

---

## 附录 — Attack 裁决 Ledger（两轴逐条，接地 `b7d6dd27`）

### Lens A（判定语义轴）

| # | 攻击 | 裁决 | 重接地 / 理由 |
|---|---|---|---|
| **A-MAJOR-1** | exact-path 是裸 normalize 字符串相等、无置信门；v1 "fail 高置信度"对 exact 为假；true_false/数值/reference_md 回退假否决 | **ACCEPT（承重）** | CONFIRMED：`normalizeAnswer` :199-205 仅 NFKC+lower+strip；`agree=...includes(...)` :347 二值；无 confidence 门（0.8 仅 semantic :393）。`EXACT_KINDS` 含 true_false :155；quiz_gen 不写 reference_solution（quiz_gen.ts:675-676）→ 必回退 reference_md :195-196，F2 :171-176 自认 falsely fail。→ Q1 改分轴否决，删"fail 高置信度"（限 semantic），exact 默认 hold-for-review + 独立 flag |
| **A-MAJOR-2** | 文献武器化反了（引假 PASS 给否决 fail 背书）；tier2 对称性未验证且方向反 | **ACCEPT** | CONFIRMED：MATHWELL/RQA 测假 PASS，未测假 FAIL；tier2 reference 网源锚定（source_verify.ts:191-204），tier3/4 同模型自源（registry 全 mimo-v2.5-pro）→ 新风险类别非对称扩展。→ Q1 论证 3 如实承认假 FAIL 零外部证据 + 同模型是 RQA 警告区间 |
| **A-MAJOR-3** | Q2 单样本+Q1 否决=两最激进错配；Wang 2022 刻画错；2511 不迁移；DEFER-c 触发判据自相矛盾 | **ACCEPT（部分改机制）** | CONFIRMED 三处误用/矛盾。→ Q2 保留单样本但改论证（成本+Q1 轴分层兜底），删 Wang/2511 误用，删自相矛盾 DEFER-c，确认性重解列 owner 选项。**不采纳"必须上 self-consistency"**——轴分层已使单样本安全 |
| **A-MINOR-1** | Q6 观察钩子是安慰剂（量不出假阳性率、切不了数理域、自相矛盾） | **ACCEPT** | CONFIRMED：钩子无 ground-truth 标签→只产未标注 fail 计数（混淆）；`compared_by='normalize'` 不标数理、`kind` 不编码学科。→ Q6 诚实降级为"未标注计数"，绑 Q1 少杀题 round |
| **A-MINOR-2** | 三 check 联合谓词边际价值只断言未证；solve 独占残集恰是假 FAIL 富集区 | **ACCEPT** | 部分内生于 dossier 文献真空（净指引 #6）。→ Q1 论证 3 承认残集未知 + 默认往少杀题 round；Lens B M3 短路恰好**测量**该残集（solve 只在 all-else-pass 触发） |

### Lens B（接线运行时轴）

| # | 攻击 | 裁决 | 重接地 / 理由 |
|---|---|---|---|
| **B-M1** | 既有 quiz_verify.test call-count/mock 断言破裂；slice-2 误框成纯 additive | **ACCEPT（硬性）** | CONFIRMED：BASE_META `search_grounded`（:88）→ tier4 含 solve_check；:245/:405/:429/:642 call-count 破裂；runTaskMock（:49-54）单返回值喂 SolutionGenerateTask → unsupported。→ §测试列全 suite 迁移为必需编辑 + 新稳态计数 |
| **B-M2** | `dualTaskMock` 在默认 semantic seed 上建不出 solve fail；"照抄 source_verify"误导 | **ACCEPT** | CONFIRMED：默认 seed short_answer+semantic（:105/:109）→ open 路 SemanticJudgeTask，dualTaskMock else 喂 verifyText → unsupported → pass；source_verify 测试全走 normalize（:96/:366）never semantic。→ fail-case 改种 exact 题；semantic-fail 需三路 mock，标为新覆盖 |
| **B-M3** | eager solve 花冤枉钱（其它 check 已 reject 仍打 solver）+ 插入位置物理不可能 | **ACCEPT** | CONFIRMED：v1 无条件算 solveResult；&& 短路可 gate 在 all-free-pass 后不改 promote 结果、省钱、锐化 rollback。位置：checksPass :347 < kindConformanceOk :372，"插 372 后 346 前"矛盾。→ M2 短路 + 修正插入位置（:373↔:382 之间）。与 A-MINOR-2 收敛 |
| **B-M4** | Q7 "手动端点正交/主要 QuizGenTask 成本" 被本接线反驳 | **ACCEPT** | CONFIRMED：边际 verify 成本 1→2-3 调用 × 无界 count；quiz_verify 在 AGENT 队列 2h expire。→ Q7 改口"更 load-bearing 非正交"，仍留 follow-up |
| **B-m5** | Q5 共享 helper DRY 未实现（实际单消费者） | **ACCEPT** | CONFIRMED：`solveCheckAxisNote` 匹配 CheckOutcome 不匹配 axis（需 reason→note）；`solveCheckToOutcome` 仅 source_verify.ts:266/374 引用，无第二消费者。→ Q5 裁掉提取，source_verify 完全不动，本单元只碰两文件 |
| **B-m6** | rollback flag = 编译期 const，既重又难单测；矛盾 | **ACCEPT** | CONFIRMED：const 不可重赋值，flag-off 测试需 vi.doMock/DI；v1 "翻成 false 即可" glosses 重 bundle+redeploy。→ M1 抽 `solveCheckBlocks(result, flags)` 纯函数 seam（测试直传 flags），诚实标注非运行时 toggle |
| **B-m7** | quiz_verify 无 demote（不对称 source_verify YUK-479），依赖的不变量未声明 | **ACCEPT（一行注释）** | CONFIRMED：source_verify demote :456-481；quiz_verify else :507-513 只写 metadata。安全前提=无路径预提升 quiz_gen 行（image-candidate-accept 硬编码 web_sourced）。→ M2 加一行不变量注释 |
| **B-m8** | ingest_at/memory-outbox 交互未检查（#695 O1） | **ACCEPT（一行文档）** | 本单元无新 event action（cardinality 不变）→ outbox 谓词面不受影响（正确答案）；solve_check.reason 文本若 feed embedding 随之流入（additive JSONB，低风险）。→ Q4 加一行记录 |

### 幸存（不攻，v1 正确）
接线遗漏而非设计争议（三腿收敛 + Questgen 同构反面先例）；零 schema 改动（`VerifyAxisVerdict` 含 unsupported
:79，`VerifyAxis` :88-90）；draft-review.ts additive-safe；verify-and-promote.ts 正确传播（solve fail→needs_review
→promoted:false）；runSolveCheck throw-safe（SolutionGenerateTask leg :309-316 + runSemanticJudge 自吞
question-contract.ts:261-265 均→unsupported）；audit:draft-status 无关(UPDATE-only)；模型 id 全 mimo-v2.5-pro
（registry.ts:705/317/721/741）。

---

## 附录 B — 独立 review 轮裁决（2026-07-03，8 finder → 1 Opus 深度验证 + 双确认免验，实施于 M1-M3 落地后）

### 修（已实施，同一 fix commit）

| # | Finding | 裁决 / 落点 |
|---|---|---|
| **A1（MAJOR，承重）** | **假 fail 削减**。Opus 验证钉死三事实：① exact-routed 客观题（judge='exact' 或 null+choices/EXACT_KINDS）normalize-only、miss 即 fail 无 semantic 回退；② quiz_gen 行 `reference_solution` 恒缺——backfill 两路都 gate 在 `reference_md IS NULL`，quiz_gen 行恒非空**永不进**→ candidates 必回退整段「答案+解析」reference_md；③ `normalizeAnswer` 只删空白不删标点（『长安。』≠『长安』也 fail）。**净效果：无削减 = exact 客观题近乎全量假 fail 进 needs_review，/drafts 全噪，自动化实质停摆**——原设计的「hold-for-review 兜假否决」被掏空为「全量手动闸」。 | **修法 (i)**：`referenceAnswerCandidates` fallback 增加**首行**候选（`split(/\r?\n/)[0]`）+ **首句**候选（首行再按全角 。！？ 切分——ASCII '.' 排除防 `3.14`→`3` 截断）；`answerCandidates` 增加**尾标点 trim** 变体（保守集 `。．.!！?？`，仅尾部，双侧对称适用）；整段候选保留（多候选 `.includes` = 任一命中即 pass），candidate[0] 仍整段（semantic 路 reference 不变）。**假 pass 反向风险评估**：solver 的 final_answer 需 normalize-等于一条非答案散文行才误 pass——exact 路已被 EXACT_KINDS/choices/judge='exact' 门住，quiz_gen prompt 契约首行=裸答案（choice/true_false=正确选项原文），残余风险=罕见误 pass 回到 pre-solve-check 现状，远小于今天的确定性全量假 fail → **不加 kind 门**。测试：答案+解析裸答案 PASS / 真分歧仍 FAIL / 尾标点双向 / 多行首行 / 3.14 防截断（verify-framework.test.ts A1 describe）。F2 注释同步改写 |
| **ALT-1/C1（MAJOR，深度+跨文件双独立确认）** | **诊断断链**：solve_check 否决的 needs_review 草稿在 /drafts「驳回理由」显示的是模型自己的 pass 自评（`summary_md` 按构造写于 solve 之前且必为 pass 语气——solve 只在 free checks 全过后才跑）——hold-for-review 的实用价值被掏空 | server-only 修（UI 零改）：`draft-review.ts` `deriveVerifyVerdict` 在 `payload.solve_check.verdict==='fail'` 时合成 `solve_check(<axis>) 否决：独立求解答案「X」；<reason>（模型自评：<summary_md>）` 进 `verify_reason`；listDraftReview 与 getDraftReviewDetail 共经此函数。+3 db 测试（list 合成 / pass 不改写守卫 / detail 合成） |
| **EFF-1** | solve legs 的 cost/run-id 不可观测（event 列只记 QuizVerifyTask 一跳） | `SolveCheckRunTaskFn` 返回形加可选 `task_run_id`/`cost_usd`；`SolveCheckResult` 加 `task_run_ids[]`（按调用序）+ `cost_usd`（跨 leg 求和）；semantic 路经 recording wrapper 捕 judge leg；payload.solve_check 块加两字段。「solve_check 每题成本」可从 event 表回答。+3 unit 测试 |
| **EFF-3** | `referenceAnswer.length===0` 的 unsupported 在 solver call 之后 → 注定无效仍花 LLM call | hoist 到 solver call 之前（verdict/reason 不变；该 return 不再携 solver_final_answer——没跑）。测试强化：断言 runTaskFn 未被调用 |
| **SIMP-1** | promote 五连词与 freeChecksPass byte 重复，第 6 个 check 时会漂移 | `const promote = freeChecksPass && solveCheckOk`（正白名单锚 `parsed.overall==='pass'` 经 freeChecksPass 传递，RL1 注释保留并注明） |
| **SIMP-2/R3** | runTaskMock/dualTaskMock/tripleTaskMock 三分发器 | 收拢为 `taskMock(defaultText, overrides?, taskRunId?)` 单分发器；`runTaskMock` 保留为 wrapper（15 处既有调用零迁移） |
| **R1/R2** | solverOutput 三份 / semanticJudgeOutput 两份逐字节重复 | 抽 `tests/helpers/solve-check-fixtures.ts`（依赖零、unit/db 两分区均可 import）；verify-framework.test.ts + quiz_verify.test.ts 迁移；source_verify.test.ts 仅加互指注释（本轮 comment-only 裁决） |
| **R4** | tier2 全轴否决 vs tier3/4 分轴的不对称未记录 | `solveCheckBlocks` docblock 主记（tier2 reference 网源锚定 vs tier3/4 同模型自源）+ source_verify.ts 文件头互指注释（逻辑零改） |
| **ALT-3** | pass-case payload 测试缺 solver_final_answer/reason 断言（与 fail-case 不对称） | qsolve_pass 补齐四字段断言 |
| **B-obs-1** | 幂等重试测试第三次调用靠 vi.fn 默认 undefined 解构异常的巧合 | 改显式第三 mock（`solverOutput('')` → 显式 empty-final_answer unsupported 路径）+ 补 success event 的 `payload.solve_check` 断言 |

### SKIP（留档）

| # | Finding | 裁决 |
|---|---|---|
| **A2** | `stripLeadingChoiceLabel` 的 `.` 非 dotAll，多行 labelled 答案不 strip | **skip**：单修不降一分假 fail（主因是答案+解析整块不对称非 label）；A1 首行/首句 split 后输入变单行使其 moot。留 low-pri 注释于函数内 |
| **ALT-2** | flag 粒度（编译期 const 重） | **as-designed**：ALT-1 修后残余风险大降；编译期 const 的诚实披露保留（M1 docblock） |
| **B-obs-2** | flag 退态 E2E 回归 | **defer** 到真要翻 flag 时（vi.doMock 回归测试）；已注开放问题⑤ |
| **SIMP-3** | 测试骨架重构 | 循例不动 |
| **EFF-2** | 手动端点 count cap | 已捕获 **YUK-555**（Q7/开放问题④） |

### 捕获门（协调者落 Linear）

- **修法 (iii)**：quiz_gen 生成时补写 `rubric_json.reference_solution.final_answer`（+equivalents），让未来行走结构化
  比对不再依赖 reference_md fallback——治本侧，独立 scope（动 quiz_gen prompt/parser），本轮只落修法 (i) 治标。
