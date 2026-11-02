# kind 两轴正交化 — kind-system 结构勘察（YUK-390/391/392 planning input）

> READ-ONLY recon, 2026-06-17, against `main`. Input for the Step 3 (YUK-390 承重墙) TDD plan. All citations file:line. No DB CHECK constraint on `question.kind` (only `question_difficulty_range` schema.ts:199). `kind` and `judge_kind_override` are both bare nullable `text` (schema.ts:156/161).

## 1. 三套词表

**Vocab (1) canonical persisted `question.kind`** — `src/core/schema/business.ts:16-28` `QuestionKind = z.enum([...])`. **9 值（非 8）**: choice, true_false, fill_blank, short_answer, essay, computation, reading, translation, **derivation**（M2.1 加，:25-27）. Persisted: `question.kind text NOT NULL` (schema.ts:156).

**Vocab (2) profile/skill key `SubjectQuestionKind`** — `src/subjects/profile-schema.ts:12-22`. 8 值: single_choice, multiple_choice, short_answer, translation, reading_comprehension, proof, calculation, word_problem. 消费: `profile.questionKinds`、`sourcingRoutePreference` keys、`target-discovery.ts` ROUTE_TOKEN_MAP(:469-491)、`QUIZ_GEN_SKILL_KIND_KEYS`.

**Vocab (3) skill dir name `quiz-gen-<key>`** — `src/subjects/quiz-gen-skills.ts:37-41` `QUIZ_GEN_SKILL_KIND_KEYS`（从 vocab2 派生）.

**(1)↔(2) bridge**: `src/subjects/question-kind.ts` 唯一双向 mapper. `SKILL_TO_CANONICAL`(:36-45 多对一 lossy): single_choice/multiple_choice→choice, reading_comprehension→reading, proof→derivation, calculation/word_problem→computation. `CANONICAL_TO_SKILL`(:54-61). `canonicalKindToPersistedForms`(:131-141) 展开 canonical→所有 persisted 形式（read-side 脏数据 workaround）. 头注 :120-126 明示 seed/fixture writer 把 profile vocab 漏进 `question.kind`.

**9 kind → answer-class {exact,keyword,semantic,steps} 概念映射**（route-resolve.ts:145-176 + judge-routing.ts:43-57）:
- choice/true_false → **exact**（choices.length>0 短路所有 kind, route-resolve.ts:130-131）
- fill_blank → keywords? **keyword** : exact (:146)
- computation → keywords? keyword : semantic (:147)；physics 特例→unit_dimension(:133-139)
- short_answer/reading/translation/essay → **semantic**（else keyword, :173-174）
- derivation → math **steps**→else semantic→else keyword(:151-154)；generator 输出强制 semantic(judge-routing.ts:56)
- 现有 JudgeKind enum 8 值(business.ts:171-180)含 steps/unit_dimension/multimodal_direct/rubric/ai_flexible. 计划 4 值 answer-class 是其**子集**.

## 2. `judge_kind_override` 列

bare nullable text(schema.ts:161), 无 CHECK/enum. 语义=**可选手动覆盖 resolved route**, set 时短路所有结构路由(route-resolve.ts:120-121, judge-routing.ts:42). **Schema 写约束更窄**: 三 Zod schema 限定恰好 `exact|keyword|semantic`（quiz_gen.ts:153, sourcing.ts:41, question_author.ts:49）——即计划 answer-class 减 steps. steps/unit_dimension/rubric 故意排除 generator override(quiz_gen.ts:147-152).

**写**: quiz_gen.ts:664, image-candidate-accept.ts:684, materialize-ask-check.ts:87, rejudge.ts:91(in-memory 强制 semantic), source_verify.ts:363(read→forward). **读**: route-resolve.ts:120, judge-routing.ts:42, verify-framework.ts:113/158-159(isExactQuestion), invoker.ts:34.

**"升格为主列" 需处理**: (a) legacy 行全 NULL（route 读时 lazy 派生）→ 需 backfill 跑同结构逻辑材化值，且 backfill 要读**脏 kind**(§6)；(b) 3 值 generator enum 要么扩到 4 值（加 steps）要么 steps 保持 derived-only；DB 列已 free-text（类型无需迁移），真正 gate 是 Zod schema；(c) 名字 `_override` 暗示可选——升主语义反转（NULL 变有意义/非法）→ 要么 rename(DDL+所有读写点) 要么显式定义 NULL="derive from structure" fallback.

## 3. judge-routing 孪生（必须同步）

- **`src/server/judge/route-resolve.ts:116-177`** `resolveQuestionJudgeRoute(q, subjectProfile)` — 运行/判分时 resolver, 返回 8 值 JudgeRoute(:41-49). JudgeInvoker.invoke 真正 dispatch 依据(invoker.ts:96). 两条 live submit: submit.ts:211, paper-submit.ts:227.
- **`src/core/schema/judge-routing.ts:41-58`** `defaultJudgeKindForQuestion(q)` — 生成时默认 route 推断, 返回更窄 JudgeKindT. generator stamp judge_kind_override 用(quiz_gen.ts:605, image-candidate-accept.ts:641).
- 第三近亲 `verify-framework.ts:157-169 isExactQuestion`（solve-check 镜像 exact-vs-semantic, :162-167 明示 "mirrors route-resolve.ts"）.

**为何必须同步**: defaultJudgeKindForQuestion 算出**持久化**进 judge_kind_override 的值；resolveQuestionJudgeRoute 读回该列, NULL 时必须**复现同一结构决策**. 分叉则一题按一规则生成、按另一规则判分. **分叉是故意 load-bearing**: route-resolve profile-aware（steps/unit_dimension/multimodal_direct 需 subjectProfile.judgePolicy.preferredRoutes :107-109/:133-139/:151-154/:166-172），judge-routing cross-subject pure（无 profile, 故意 derivation→semantic）.

**确定性 vs LLM route**: 确定性=exact(归一化串比)+keyword(关键词在场)；LLM=semantic(invoker.ts:147)/steps(:149-159 vision)/multimodal_direct(:160-170)/unit_dimension(:171-186). 客观集 `OBJECTIVE_JUDGE_ROUTES={exact,keyword}`(personalized-difficulty.ts:74).

## 4. 5 处 per-kind 判分镜像（Step 4 surface）

1. **`PROSE_KINDS`** judge-routing.ts:29-34 ={short_answer,reading,translation,essay}. 分支: judge-routing.ts:57, embedded_check_generate.ts:80, quiz_gen.ts:178.
2. **`EXACT_KINDS`** verify-framework.ts:155 ={choice,true_false,fill_blank}（local const）. 分支 :168 in isExactQuestion(:157-169).
3. **`OBJECTIVE_KINDS`** target-discovery.ts:265 ={choice,true_false,fill_blank}（exported :450）. 当前仅 doc/intent, live R3 用 R3_CALIBRATION_KIND='choice'(:271/:418).
4. **`OBJECTIVE_JUDGE_ROUTES`** personalized-difficulty.ts:74 ={exact,keyword}（route 级, 已 answer-class 形）. 分支 :78/:466(SQL IN).
5. **route-resolve/judge-routing if-chains 本身**(§3). 另: `isRecallKind`/`rotationClassForKind`(target-discovery.ts:258-260) 是**独立 kind→class 轴**(recall vs application, ADR-0030), Step 4 **不要误并**.

## 5. 生成端塌缩（Step 5 surface）

**kindsMatch 拒收**: quiz_gen.ts:535-543, sourcing.ts:386-394(同构), sourcing-sequence.ts:148(池过滤非拒收). kindsMatch 本体 question-kind.ts:86-91.
**QuizGenQuestion.kind: QuestionKind 闭集**: quiz_gen.ts:141-142；镜像 SourcedQuestion/QuestionAuthorQuestion 同带闭 QuestionKind + 3 值 judge_kind_override enum.
**4 处硬编码 8 值 prompt 串**（task-prompts.ts, 全 `choice | true_false | fill_blank | short_answer | essay | computation | reading | translation`，**全漏 derivation**）: :308, :636, :745, :870. 含 derivation 的 inline 9 值: :545/:606.

## 6. 脏数据（Step 3 backfill surface）

fixture/skill writer 把 **profile vocab(2)** 直接持久化进 `kind` 列. 明示 question-kind.ts:120-126, wenyan/fixtures/index.ts:18-30.

**kind 列实际出现的 distinct 值（fixture data.json + few-shot.json census）**:
| 值 | vocab | count |
|---|---|---|
| single_choice | profile(2) | 14 |
| derivation | canonical(1) | 10 |
| calculation | profile(2) | 9 |
| fill_blank | canonical(1) | 6 |
| translation | both | 4 |
| reading_comprehension | profile(2) | 3 |

fixture **schema**强制 profile vocab 进 kind: math/fixtures:7 `z.enum(['single_choice','fill_blank'])`, physics/fixtures:29, wenyan/fixtures:31-37.

**fail-closed backfill 必须**: profile→canonical via SKILL_TO_CANONICAL(question-kind.ts:36-45)；neither-vocab 值 normalizeToCanonicalKind 返 null(:73-79). backfill 还要算 **answer-class**（非仅 canonical kind）进 judge_kind_override——需读 `choices_md`+`rubric_json` per row, 复现 route-resolve/isExactQuestion. **无 CHECK** 拦脏写, 也不会拦坏 backfill.

## 7. A1 / A5 touchpoints

**A1**: QuizGen 落行 quiz_gen.ts:656-677(kind:q.kind :658, judge_kind_override:judgeKind :664, source:'quiz_gen', draft_status:'draft'). 生成只能 emit canonical vocab（QuizGenQuestion.kind:QuestionKind）→ **新行干净**, 脏的是历史/fixture(§6). `LearningRecordActivityKind`(business.ts:99-108) 是 activity-kind 轴, **与 question-kind 正交**——别混 activity-kind 与 answer-class.

**A5**: 客观位结构优先保护 route-resolve.ts:130-131(choices>0→exact) + verify-framework.ts:162-167. R3 calibration 要求客观项否则不产 calibration label(target-discovery.ts:267-271/:416-425), pin kind='choice' 正因 choice 确定性→exact 不管 override. 若 Step 3/4 改客观位判定（如读 judge_kind_override 而非结构）→ 误分类客观项静默坏 active-PPI calibration(personalized-difficulty.ts:74-78/:466). `IMAGE_CONSUMING_JUDGE_ROUTES={steps,multimodal_direct}`(route-resolve.ts:90) 门控图片答案；误路由图片答案到纯文本确定性 route→对空串判分→假"错"污染 FSRS(:82-89).

## 风险清单 & 计划前待决

1. **是 9 kind 不是 8**. 4 prompt 串已漏 derivation. derivation 是唯一映射到新第 4 类 steps 的 kind. **待决: derivation 是 kind / answer-class / both?**
2. **judge_kind_override 名义升主、数据欠填**. legacy 全 NULL. 升主需结构 backfill（读 choices_md+rubric_json）. **待决: NULL 是否保留为 "derive from structure", 还是 backfill 做全?**
3. **generator enum 3 值, answer-class 4 值**. quiz_gen.ts:153 等故意排 steps（runner 存在性 + 防幻觉）. **待决: generator 能 emit steps, 还是 steps 保持 derived-only(profile-gated)?**
4. **孪生故意不对称**. route-resolve profile-aware（含 steps/unit_dimension/multimodal_direct）；judge-routing pure. 收敛"读一个 answer-class"有丢失 profile-aware 分支 + 图片 route 门(:90) 的风险——这些不属 4 值 answer-class 但同处 dispatch.
5. **isRecallKind/rotationClassForKind 是独立轴**(recall vs application, ADR-0030). 别并进 answer-class.
6. **三 fixture schema 硬编码 profile vocab 进 kind**(math:7/physics:29/wenyan:31-37). 必须同迁移+改 schema, 否则下次 fixture load 再脏.
7. **kind 无 DB CHECK**. 要 fail-closed 须迁移加约束——但约束会**对现有脏行失败**除非 backfill 先跑（**ordering hazard**）.
8. **A5 客观位脆弱**. R3 calibration + active-PPI 静默依赖 choice→exact 结构保证. 改客观/确定性类读法须保 route-resolve.ts:130-131 + OBJECTIVE_JUDGE_ROUTES SQL filter(:466).
9. **canonicalKindToPersistedForms 是脏数据 read-side workaround**. Step 3 backfill kind 为纯 canonical 后可能成死代码——核所有消费者.
10. **rejudge.ts:91 + solve-check 强制 in-memory judge_kind_override:'semantic'**——第 4 种隐式 override 语义. 确认升主后这些 forced-semantic 路径存活.
