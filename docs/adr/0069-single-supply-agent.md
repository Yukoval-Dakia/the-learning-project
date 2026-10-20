---
status: accepted
---

# ADR-0069 — 单一备题员：题目的唯一入口与同一道准入门

**Status:** Accepted（设计方向，2026-10-11）；尚未实施。
**Decision source:** owner 2026-10-10 愿景评审「题源次序：只看质量，并且 agent 为题目唯一实际入口，而不是三根管子」；2026-10-11 拍板 S1–S4（决定记录 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/decisions/2026-10-11-supply-and-brain.md`），讨论票转实施。
**Tracking:** [YUK-1468](https://linear.app/yukoval-studios/issue/YUK-1468)。
**Related:** ADR-0067（教研白板与事件例会——本文 D7 修订其 D5 一处）、ADR-0068（通用学科，D7 来源覆盖诚实声明）、[YUK-1445](https://linear.app/yukoval-studios/issue/YUK-1445)（判分准入）、[YUK-1448](https://linear.app/yukoval-studios/issue/YUK-1448)（题库即题源——其验收 3 被 D3 取代）；讨论稿（细节真相源，绝对路径）`/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/supply-agent-draft.md`。

**修订状态（2026-10-19）：** Refs [YUK-1594](https://linear.app/yukoval-studios/issue/YUK-1594)，Proposed。下文新 D6 与修订节须经 owner 同意才生效；原 Accepted 决定仍可在保留的旧 D6 中查阅。上方「尚未实施」是 2026-10-11 的记录，不代表当前 main 的实施进度。

## 背景与问题

补题今天是一套固定管道：夜间扫描器 `target-discovery` 发现缺口 → `route-planner` 的写死约束序（要图先图源、要高可信先 web、客观题只走 web/拟题）→ `dispatcher` 把 job 送进 web 供给队列或 quiz_gen 生成队列；需求端另有夜间 `SupplyPlanTask` 规划与 `plan-executor` 的路由决策（`src/capabilities/practice/server/question-supply/`、`src/capabilities/practice/tasks/supply-planning.ts`）。质量不是排序依据，「管子的属性」才是；加一种找题方式要改路由、加 job、排队，且「jyeoo 的题 vs 生成的题」事实上存在两套信任。

owner 在 2026-10-10 愿景评审定方向：只看质量；agent 是题目唯一实际入口；AI 生成题不设硬顶、每题过同一准入门、来源可辨认；后台花费不设上限（「过去我们定上限定的太低了，而且设置也是真的难用」）。经讨论稿深度讨论（owner 的真选择 §7）后，2026-10-11 拍板 S1–S4。本文是决策记录，不是实施 spec：缺口单字段表、六项门的现有机件映射、战术册、成本与安全细节以讨论稿为真相源，本文只钉决定与边界。

## 决定

### D1 备题员 = 教研团成员，题目的唯一入口；工具箱七个 DomainTool（2026-10-11 经 ADR-0072 修订），零新入口

供题教研员（「备题员」）是教研团（ADR-0067 白板 + 例会体系）的一名成员，纯后台。它接收 typed 缺口单（GapTicket：考什么知识 / 错法定向、难度带、用途、数量与时限），自己决定去哪找题；工具箱就是这七个 DomainTool——`search_bank` / `read_bank` / `check_bank`（查自家题库：ADR-0072 定义的题库三工具，随其 LIGHT 落地，取代本条原先所列的 `query_questions`；`check_bank` v1 仅含 ADR-0072 D5 的确定性检查）、`web_fetch_candidates`（Exa 检索→抽取→结构化）、`jyeoo_fetch_candidates`（高中 10–12 数学，预算租约内）、`generate_question_candidate`（自己出；参考改编 = 检索 2–3 道金标范例作 seed 后同样经它产出候选，provenance=`adapted_from:<id>`）、`store_sourced_question`（唯一入库闸）。`author_question` 的 draft+proposal 面保留给交互式 Copilot 拟题，不在备题员入库路径上。学习者永远只见到练习流，这七个工具之外不新增任何入口、面或第二 commit seam。（2026-10-11 修订：查库工具 `query_questions` 由 ADR-0072 的 `search_bank`/`read_bank` 取代，工具箱五增为七，其余四个工具与边界不变。）交付：候选 + 每题 provenance（来源、为什么选它、花了多少钱）+ 写回白板的供题完成 finding；失败也写回（差什么、为什么不硬凑）。空转由「无进展终止」兜住：同一缺口连续 N 轮零候选过门即停止并白板记失败面，绝不用降低门的代价换交付（N 初值见未决问题）。

### D2 缺口单来源：白板与例会为主，夜间扫描保留为安全网（S1）

缺口单来自白板 finding、例会决定（主席 `serve_probe`/`swap_item` 等动作）或手工；`target-discovery` 夜间扫描保留为安全网——例会成熟前防止供题退回纯时钟驱动。「教研员自己也发现缺口」等 §6 有证据后再议。

### D3 找题顺序完全交给 agent，只看质量，不设默认顺序（S2）

owner 未采纳讨论稿推荐的「默认自家库→外部→生成/改编顺序作 prompt prior」：顺序完全交给备题员，纯按质量取舍。**本条取代 YUK-1448 验收 3 的「先检索后生成」顺序约定**——检索与生成孰先孰后回归备题员的战术判断，唯一硬闸是 D4 的门；YUK-1448 的其余验收（题库即题源、按需准确找题、来源字段）不变。

### D4 同一道六项准入门，不分来源；AI 生成不设硬顶，失控防护 = 无进展终止，花费不设上限

不管候选来自 jyeoo、网络、生成还是改编，都过同一道门：①**自动可判**——经 YUK-1445 准入的 AI judge 独立解出且判分与金标一致，判不了的题不出；②**题面完整**——陈述可解、无歧义指代、选项/答案/解析结构齐全；③**图形正确**——图候选 staged 完好，缺图/坏图显式拒绝；④**去重**——canonical hash 精确重复合并 + KC 域 n-gram 近重拒绝（`store_sourced_question` 现有闸）；⑤**难度诚实**——无标定锚就写 unknown，不把「你做错了」当「这题难」；⑥**来源可辨认**——provenance 必填（jyeoo / web_url / generated / adapted_from:<id> / 本人材料；录题 agent 切换后另有 photo_ingest，见 D8），挂在 C19 已批的任意扩展 metadata 上。多数机件已存在；逐门现有承载与「质量」的可测定义见讨论稿 §2。AI 生成数量不设硬顶，唯一闸是这道门；失控防护是 D1 的无进展终止，不靠数量上限。花费照走费用账本但不设上限（owner 拍板）；jyeoo 的 producer 40/日硬闸与预算租约保留——那是外部授权约束，不是质量顶。

### D5 金标两级：admitted 自动、gold 仅 owner 亲手认证（S3）；agent 永不自盖

「能自动判分」在机器准入实测通过时自动标 `admitted`；「出得好、可作范例」是 `gold`，只能由 owner 亲手认证，作为 metadata 存储（`gold_certified: true` + 认证维度 + 认证人/日期），不新建表、不新建状态机。准入 ≠ 出得好，金标保持稀缺才配得上「精准找参考」；**agent 永远不能给自己出的题盖金标**——这是 ADR-0067 D1 防自喂红线在供题侧的落点。出题时按「标签 + 语义」检索 2–3 道金标进 prompt 作参考，改编产物 provenance 记 `adapted_from`。

### D6 quiz_gen 不再是独立 job / 入口，出题能力并进备题员（2026-10-19 修订，Proposed）

自己出题与参考改编统一由 `generate_question_candidate` 产出候选，经 D8 泛化后的 `store_sourced_question` 入库闸写入。该闸在当前 main 的注册名已是 `submit_question`，不恢复旧工具名、不再新增写入器。父子结构题、既有质量检查、持久化与恢复保证一并迁入；`quiz_gen` 不作为永久例外保留。先迁调用方，再排空旧任务和验证意图，最后删除独立 job 与入口。

旧路由层的同缺口并跑与盲核仍保留。quiz_gen 退役与路由层切换采用同批退役（修订第 5 点 A；owner 2026-10-20 确认）；在 owner 同意前，不以本修订启动删码或改变 YUK-1468 的在途实现。

#### 旧 D6 原文（被本 Proposed 修订取代，待 owner 同意后生效）

**D6 旧路由层先并跑对比数周再退役（S4）；测试与切换由协调线全权负责**

`route-planner` 的约束序、`dispatcher` 的自动派发、`SupplyPlanTask` 夜间需求规划、`plan-executor` 的路由决策——「决定走哪根管子」的判断层——先与备题员并跑数周（同缺口双跑 + 盲核对比），对比通过后删除；其机器门、预算租约、幂等（fingerprint cooldown）思想并入备题员任务。取水核心保留：jyeoo fetch 核、SourcingTask 核、quiz_gen job 及其双轴验证链不动（篇/组合结构仍需 quiz_gen，它是唯一会落 parent+question_part 行的生产者）。并跑对比、盲测与是否切换由协调线全权负责，不再找 owner——owner 原话：「测试你自己做，我不想管这个事。」

### D7 修订 ADR-0067 D5：供题批处理由备题员承接；§9 八项承重不动

ADR-0067 D5 中「供题/校准/结构维护/运维 cron 保留为批处理」修订为：**供题不再作为独立批处理路径保留，由备题员承接**；缺口发现层面的 `target-discovery` 夜间扫描按 D2 保留为安全网；校准、结构维护、运维 cron 保留。`docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md` §9 的 8 项 pre-AI 承重能力全部不动——本 ADR 不触碰其中任何一项。

### D8 入库闸泛化到所有来源，录题 agent 共用；不另造写入器

现状缺口：`store_sourced_question` 的 `source_route` 只接受 `jyeoo_fetch` / `sourcing_web`，且要求 fetch 工具产出的 `extraction_hash`；`generate_question_candidate` 是 `effect: 'read'`，只返回候选、不落库。也就是说「自己出」「改编」「本人材料」今天都进不了这道闸。第一刀必须**泛化这一个工具**，而不是新增并行写入器：`source_route` / provenance 扩为 `jyeoo_fetch | sourcing_web | generated | adapted_from:<id> | owner_material`（录题 agent 切换时同一枚举再加 `photo_ingest`），非 fetch 来源用各自的可复现指纹（生成输入摘要、改编源 id、材料资产 id）替代 `extraction_hash`；D4 六项门、精确/近重去重、`source_verify` 链对所有来源一致。知识点仍须 live（`dead_knowledge_node` 拒绝不变）；候选附带的新知识点只作提议，不自动批准，目标不当知识点。

照片录题若改为录题 agent（录题对比实验胜出后切换），题目同样经这一个闸入库，provenance 为 `photo_ingest`（源图、页、版面 bbox），门与去重不放宽。照片上的学生作答是关于**学习者**而非题目的事实，不经本闸：由录题侧的「记录作答」复用现有作答写入器，交准入 AI judge 判对错、过程瑕疵与能力（红笔含义按学习者偏好解读，事后订正不算作答），不属本 ADR 范围。对比实验期间录题 agent 只产出结构化结果、不写库。

## 2026-10-19 修订：quiz_gen 并进备题员

**Status: Proposed。Refs [YUK-1594](https://linear.app/yukoval-studios/issue/YUK-1594)。owner 同意修订前不合入。**

owner 原话：「quiz_gen.ts 单独存在就很奇怪。」本节把出题要求归入备题员结构，不增加 agent、工具或子系统。服务交付阶段为「按真实时间安排」，承接 YUK-1468 的单一供题入口与 D4、D8 契约。**本票不含任何代码改动、测试代码或实施拆票**；owner 同意后，由 PM 将实施需求挂回 YUK-1468 的结构设计。

### 证据基线与现名

以下现状均按 2026-10-19 的 `origin/main` [d41f2421](https://github.com/Yukoval-Dakia/the-learning-project/commit/d41f242138ee2336abd9a58bd2e99f3f958b5263) 核对。链接行号对应这份基线，实施时须重新检索，不把引用数量当作待迁调用方数量。

- `rg -l 'quiz_gen' src | wc -l` 为 102，包含测试、类型、注释和历史数据读取。生产调用另用 `rg -n 'quiz_gen|quiz-gen|runQuizGen|runSourcingSequence|dispatchSupplyTarget|enqueueQuizGen|enqueueSupplyDispatchJob' src scripts -g '*.ts' -g '!*.test.ts' -g '!*.typecheck.ts'`，并追踪调用符号，见第 4 点。
- D1、D8 所称 `store_sourced_question` 已并入 [`submitQuestionTool` / `executeStoreSourcedQuestion`](../../src/capabilities/practice/server/tools/submit-question.ts#L663-L805)。[`store-sourced-question.ts`](../../src/capabilities/practice/server/tools/store-sourced-question.ts) 只保留内部兼容导出，实际注册在 [`practice/manifest.ts`](../../src/capabilities/practice/manifest.ts#L1489-L1515)，没有第二个同名 DomainTool。本节的“泛化 store”指扩展这一个现役提交闸，不复活旧工具。
- [`generateQuestionCandidateTool`](../../src/capabilities/practice/server/tools/generate-question-candidate.ts#L31-L105) 已调用 `QuestionAuthorTask`，只返回候选与费用证据。其 [`QuestionAuthorDraft`](../../src/core/schema/question_author.ts#L34-L58) 已能表达 `StructuredQuestion`，但这不等于已经接通 quiz_gen 的父子行写入。`submit_question` 的 `draft` 分支已接受多来源；`candidate` 分支的 `source_route` 仍只接 `jyeoo_fetch | sourcing_web`，不能伪造 `extraction_hash` 来塞生成题（[`inputSchema`](../../src/capabilities/practice/server/tools/submit-question.ts#L115-L158)）。
- 已核 GitHub 文件清单：#1777 已合并，#1784 已关闭。这里读取 main 的 `source_verify` 与准入实现，只改本 ADR，不改这些 PR 的文件，也不据票面旧描述回退已落地的准入保护。

### 1. D6 结论：收掉独立生成路径，保留能力与证据

推荐采用新 D6。备题员负责选择战术，`generate_question_candidate` 负责出候选，泛化的 store 负责唯一提交。删除目标是 [`buildQuizGenHandler` / `runQuizGen`](../../src/capabilities/practice/jobs/quiz_gen.ts#L1814-L2050)、独立 API 及其派发契约，不是把原 job 包成第八个工具。

生成所需的 plan-then-generate、材料引用、题型规范、费用与失败记录迁入现有出题能力。当前 [`planQuizGeneration`](../../src/capabilities/practice/jobs/quiz_gen.ts#L691-L781) 先调用 `QuizPlanTask`，经 [`checkPlanPins` / `checkPlanKnowledgeIds`](../../src/capabilities/practice/jobs/quiz_gen_plan.ts#L79-L160) 才生成；不是保留一个独立 `quiz_gen_plan` job。推荐保留这些约束，工具内部组织生成步骤，不另设规划 agent。jyeoo fetch 核与 SourcingTask 核仍按原 D6 保留。D1 明确保留的交互式 `author_question` draft+proposal 面不在本次删除范围，也不成为后台供题绕过准入的出口。

### 2. 父子题结论：结构候选经同一个 store 一次提交

推荐复用 `QuestionAuthorDraft.structured`，由 `role='standalone'` 与 `role='stem' + sub_questions` 区分单题和题组。生成侧只产候选；提交侧一次接纳完整题组，复用 `normalizeAuthorStructured`、`createQuestionPart` 与 publisher，不另造 parent/part 写入器。候选来源与请求幂等信息随同一个提交契约扩展，不把每个 part 当作独立工具调用。

迁移必须保留下列实际保证，而不是仅保留父子外键：

| 现役保证与代码依据 | 合并后的要求 |
| --- | --- |
| [`generateQuizDrafts`](../../src/capabilities/practice/jobs/quiz_gen.ts#L879-L985) 对照已接受 plan，逐位置核题数、answer class 和 composite 标记。篇需求不能降成平题，未声明篇的请求不能夹入题组；根须为 stem，至少 2 个 sub。 | 把需求约束带入候选与提交检查。`normalizeAuthorStructured` 本身只要求至少 1 个 sub，不能用它替掉 quiz_gen 的“至少 2 个”约束。 |
| 同函数在事务前仅归一一次，服务端重建节点 ID。材料正文先嵌进 stem；父题 `prompt_md`、`reference_md` 从树派生，父题 `choices_md=null`、整组判分为 semantic。 | 归一后的树是本次提交的共同输入，不在父行、子行各自重新编号。保留材料题自包含、整组与子题各自的判分语义。 |
| [`persistQuizDrafts`](../../src/capabilities/practice/jobs/quiz_gen.ts#L1149-L1629) 目前以整批一个 `db.transaction` 写材料 `source_document`、父行、全部子行、revision、验证意图及非空 `tool_quiz` artifact 与其 create event。生成调用在事务外；placement 在事务内复核 fence。 | 一次 store 提交完整 parent + parts，失败整组回滚。若仍按已接受 plan 交付一批，则保留整批事务语义，不暗改成逐题部分成功。费用/模型调用不塞进长事务。 |
| [`createQuestionPart`](../../src/server/questions/parts.ts#L104-L180) 先锁 root，再插 child；part 也是 `question` 行，不是另一张表。`parent_question_id` 决定 part 身份，`kind='question_part'` 只是显示标签。 | 复用原 owner，保持 root→child 锁序。按数组顺序赋 0-based `part_index`，`metadata.part_ref` 指向归一后的 sub ID；不能用模型自报编号替代。 |
| [逐 part 写入](../../src/capabilities/practice/jobs/quiz_gen.ts#L1473-L1535) 使用 stem+单个 sub 的缩窄树；继承父行最终持久化的 KC 并集、难度及 provenance。选项正文进 `choices_md`，派生 prompt 去掉内嵌选项，树仍保留选项。 | 子题能独立展示材料，不重复展示选项；客观小题保留 exact 判分，不因拆分变成 semantic。 |
| [精确重复与并发冲突](../../src/capabilities/practice/jobs/quiz_gen.ts#L1289-L1472) 以含 `composite` 区分位的 canonical hash 合并 KC；唯一索引冲突后重读协调。重复分支跳过插入和 parts，保留旧题状态及旧 parts。 | 保留结构区分、重复合并和竞态处理，不把同文本无子题的平题当作篇题，不重复造子行。当前普通 `runQuizGen` **没有按 trigger 的全程 exactly-once 保证**；不能把内容去重说成付费调用幂等。新路径复用 store 的 request_id 回执约束，不承诺模型天然 exactly-once。 |
| [组发布与验证意图](../../src/capabilities/practice/jobs/quiz_gen.ts#L1536-L1568) 同事务落地。`createQuestionPart` 每次会重发组 revision，末尾 publish 再确保整组发布；并非“一组恰好只有一次 publisher 调用”。父子都显式 draft，仅父题有验证意图。 | “一次写入”指一个提交、原子可见，不另写第二套 revision writer。初版 withheld；父题质检与后续整组判分准入未完成前不得把 part 单独送进可练池。 |
| [`promoteCompositeChildren`](../../src/capabilities/practice/jobs/quiz_verify.ts#L239-L341) 与父题同事务级联，写时再次排除 archived/dismissed；子题证据写明继承父题，不伪称独立核验。FSRS 只 enroll-if-absent，排除 synthetic root，不重置旧复习历史。 | 统一门保留组级结论与墓碑保护，所有计分单元过准入才能服务。调度状态与验证结论分别保留，不靠删旧 handler 顺手清理数据。 |
| [`dispatchQuizVerification`](../../src/capabilities/practice/jobs/quiz_gen.ts#L1707-L1742) 在提交后派发，失败留 durable intent 给恢复，不因 enqueue 失败重跑生成。placement 的重复题还须登记 authority 并排空验证意图。 | 复用 [`verify-dispatch-outbox`](../../src/server/boss/verify-dispatch-outbox.ts)，迁移期间处理既有意图；保留 claim、attempt、租约与费用结算，不重复花费来“恢复”已落库题。 |

`experimental:quiz_gen` 运行事件在事务后写，不能把它描述成与题组同事务；`tool_quiz` 只在新题非空时创建，全部重复不能生成空卷（同一 `persistQuizDrafts` / `emitQuizGenerationEvent`）。推荐保留这些可观察结果；只收敛供题 owner，不改组卷与历史读取契约。

### 3. 验证结论：把检查并入 D4，不串两套验证链

推荐以现有 `submit_question`、[`runQuestionAdmission`](../../src/capabilities/practice/server/admission/run-admission.ts#L212-L384)、[`runQuestionAdmissionChecks`](../../src/capabilities/practice/server/admission/checks.ts#L49-L117) 和 [`question_admission_run`](../../src/capabilities/practice/jobs/question_admission_run.ts#L344-L480) 为共同承载。旧检查迁成这条路径的检查与证据，不能让新题先走一遍 `quiz_verify`、再走一遍 `source_verify`。

当前“双轴”不是两个 job 串行：`runQuizVerify` 只接 `source='quiz_gen'`，核心轴为 grounding 与 knowledge_hit，并附加复制安全、材料、题型、解题和教学质量检查；`runSourceVerify` 只接 `web_sourced`。两者通过后仍只提供质检证据，通常发布 withheld，最终由 `question_admission_run` 做双解、契约校验与标定后 admitted。**`verified`、legacy `active` 和可服务的 `admitted` 不是同一状态。**

| 现有检查（迁移清单） | D4 归属与推荐落点 |
| --- | --- |
| `runQuizVerify` 的 `grounding`、`knowledge_hit` 必须 pass，不能只看 overall。[内容验证输入与判定](../../src/capabilities/practice/jobs/quiz_verify.ts#L540-L678) 调 `runQuestionContentValidation`，读取声明来源与 KC。 | ②题面可解、⑥来源真实。在共同内容检查中保留事实依据与命中需求 KC 的结果，所有来源共用同一裁决，不按来源给免检通道。 |
| 同处 `material_grounding` 要求持久化材料存在且非空，显式 fail 阻断；`kind_conformance` 对照科目题型规范。两者当前对缺失/unclear 的处理比“全项 pass”宽松。 | ②题面完整、⑥材料可追溯。继续复用 `resolveQuizGenSkillDocs` 与实际材料；缺依据记未完成，不伪造 pass。是否收紧这两项旧软判据，留 owner 定，不混入删 job 的机械迁移。 |
| `copy_safety` 取模型 verdict 与确定性 n-gram 的更严结果，overlap ≥ 0.5 为 too_close，unknown 不晋级；生产阶段只能标 `checked_by='agent_self'`。 | ⑥来源与改编可辨认。保留独立检查证据；它是对来源片段的复制检查，**不是**④题库去重。来源题的引用一致性与生成/改编题的复制安全按 provenance 解释，不能把相反方向阈值合成一个。 |
| [`checkStructureCompleteness`](../../src/capabilities/practice/jobs/source_verify.ts#L177-L200) 查非空题面、参考答案及选择题至少两个选项；quiz_gen 在生成 parse/归一阶段查结构与 judge contract。 | ②统一提交前的结构检查，加组内每个 sub 的内容检查。把检查迁到同一提交边界，不为 generated 另留 schema 后门。 |
| [`checkSourceConsistency`](../../src/capabilities/practice/jobs/source_verify.ts#L203-L285) 查有效 provenance、非空 extract、tier、`source_ref=url`，题面+答案与持久 extract overlap ≥ 0.15；不重新抓网络。 | ⑥同一道 provenance 检查中校验 fetch 来源证据。generated 使用生成输入摘要，adapted 使用源题 ID 与 revision，材料使用资产/文档身份；不强迫非 fetch 来源伪造 URL/extract。 |
| [`checkDedup`](../../src/capabilities/practice/jobs/source_verify.ts#L289-L338) 查同 KC 活跃池 n-gram；[`executeCandidateSubmit`](../../src/capabilities/practice/server/tools/submit-question.ts#L298-L645) 还查 exact hash、同源重复、near_dup 与 vector-near hold，验证时重查 hold 邻居是否仍可见。 | ④统一 store 执行精确合并、来源去重及近重处理；共同门消费 hold，不让另一条验证链抹掉它。父子 hash 的结构区分按第 2 点保留。 |
| 两个 verifier 的 `runSolveCheck`：独立求解，exact 先归一再作语义比较，开放题保守比较；quiz 的 `solveCheckBlocks` 及 source 的 unresolved exact mismatch 还有阻断规则（[`verify-framework`](../../src/capabilities/practice/server/quiz/verify-framework.ts)、[`runSourceVerify`](../../src/capabilities/practice/jobs/source_verify.ts#L529-L594)）。 | ①统一判分准入消费独立求解与比较证据，最终使用 `runQuestionAdmission` 的双解、逐单元契约及校准结果。不要在旧 solve_check 之外永久再付费跑一套等价求解；旧 unsupported 不等于新的 admitted。 |
| [`runQuizVerify`](../../src/capabilities/practice/jobs/quiz_verify.ts#L700-L846) 的 `runTeachingQualityCheck` 查 clarity、unique_answer、选择题 distractor_power；和 solve 是同级探针，受同一前置检查约束，按 `teachingQualityBlocks` 的轴规则阻断。 | ②共同内容质量检查。复用已有执行器与轴证据，不把“能判分”替代“题目清楚”；具体 veto 策略不因换 owner 丢失。 |
| [`runSourceVerify`](../../src/capabilities/practice/jobs/source_verify.ts#L552-L722) 保留 image_input_unavailable 阻断；single_source_grounding 题须有源资产并调用 `runSourceGroundingVerify`，not_grounded 拒绝，transient_error 挂起后重试。 | ③图形正确、⑥源图对照。同门按候选实际图像证据检查，区分图缺失、题不在图中与暂时无法读取。保留 staged 资产完整性检查，不把“URL 存在”当图已验。 |
| [`runSourceVerify`](../../src/capabilities/practice/jobs/source_verify.ts#L502-L527) 晋级前重查 live KC；quiz `parse_repaired` 封顶 needs_review。生成侧保留 `difficulty_evidence`，但旧 verifier 没有完成 D4 难度标定门。 | ②/⑥在提交和最终决定复核 live KC，不自动批准新 KC；保留解析修复 hold。⑤由共同门记录标定依据，无锚写 unknown，不把模型给出的 1–5 当已校准。 |

迁移后的“一道门”允许一次提交后异步检查，不表示在数据库事务里调用模型。只有一个最终准入决定；候选、质检证据、判分准入、可练状态不能混称。当前 [`CHECK_SETS_BY_TIER`](../../src/capabilities/practice/server/quiz/verify-framework.ts#L74-L143) 按来源分检查，不能原封不动包住两只 job 后宣称已统一。必要的来源证据各异，质量标准仍按 D4 共用。

现役并发保护也须迁入：验证回写复核 row version，按 learning-state→placement scope→root/child 锁序写入；旧任务不能覆盖较新准入。`quiz_verify.readBoundIndependentAdmission` 与 `source_verify` 通过当前 revision、publisher 写入的 `revision_digest` 及准入记录识别已完成准入，不能把付费输入 `base_contract_digest` 当作已发布 resolved revision 的唯一摘要（[`quiz_verify`](../../src/capabilities/practice/jobs/quiz_verify.ts#L344-L414)、[`source_verify`](../../src/capabilities/practice/jobs/source_verify.ts#L817-L1019)）。两者成功分支保留当前已绑定准入，quiz 失败分支还要求 admission generation 晚于开工快照才视为 stale。出错/重试、失败 verdict、needs_review 分开留痕；不为收掉旧验证链删除历史核验与费用记录。

### 4. 调用方结论：先迁真实入口，再删 quiz_gen

下表是 main 的调用方与退役依赖清单，不是实施拆票。目标均为向同一备题员提交缺口；候选仍经同一个 store、同一道门。标为“无直接调用”的行不能因文本命中而算作一条线上路径。

| 入口分组 | main 文件与符号 | 迁移要求 |
| --- | --- | --- |
| quiz-gen-trigger API | [`api/quiz-gen-trigger.ts:POST`](../../src/capabilities/practice/api/quiz-gen-trigger.ts#L36-L125) → `enqueueSupplyDispatchJob('quiz_gen')`；[`manifest`](../../src/capabilities/practice/manifest.ts#L834-L852) 注册 `POST /api/questions/quiz-gen`。 | 手工意图迁到现有缺口提交能力后删除专用 API 与 `quiz-gen-trigger-contracts`，不永久保留别名入口。保留鉴权、live KC 检查与诚实的接纳/失败回执。 |
| copilot_run | [`executeAcceptedCopilotRun`](../../src/capabilities/copilot/jobs/copilot_run.ts#L707-L718) 调 `executeCopilotTurn`，没有直接入队或调用 `runQuizGen`；该文件唯一 `quiz_gen` 命中在 L763 注释。间接供题来自工具 `file_bank_gap`，见下一行。 | 不把 durable Copilot worker 改成供题 worker。迁工具下游即可；D1 的 `author_question` 交互提议面保留，`write_quiz` 组卷与历史 `tool_kind='quiz_gen'` 不是独立生成 job。 |
| Copilot `file_bank_gap` | [`file-bank-gap.ts:executeFileBankGap`](../../src/capabilities/practice/server/tools/file-bank-gap.ts#L314-L530) 保存缺口后 `dispatchSupplyTarget`；工具由 [`manifest`](../../src/capabilities/practice/manifest.ts#L1542-L1549) 贡献。 | 保留缺口去重、需求 ID 和失败记录，将实际供给交备题员。它与 copilot_run 是同一调用链，不重复计数。 |
| placement-start 与恢复 | [`placement-start.ts`](../../src/capabilities/practice/api/placement-start.ts#L181-L212) → [`dispatchPlacementStarterClaim` / `dispatchPlacementStarterClaimTx`](../../src/capabilities/practice/server/question-supply/placement-starter.ts#L99-L174) → dispatcher 的 `enqueueQuizGen` → [`kernel/placement-jobs.ts`](../../src/kernel/placement-jobs.ts)。旧 `/api/placement/start` 与 `/api/placement-sessions` 共用实现。[`sweepStalePlacementStarterClaims`](../../src/capabilities/practice/server/placement-starter-recovery.ts#L426-L489) 也会重派。 | 前台接纳、后台恢复一起迁，保留 claim+入队事务、attempt fence、deadline、费用账本与真实 job liveness。只改 start、不改恢复会重新打开旧队列。 |
| question_supply_nightly | [`runSupplyDiscoveryAndDispatch` / `runQuestionSupplyNightly`](../../src/capabilities/practice/jobs/question_supply_nightly.ts#L112-L190) → `discoverSupplyTargets` → `dispatchSupplyTargets`；末尾还扫 placement claim。 | 依 D2 保留确定性缺口发现安全网，将派发改交备题员；保留供给腿失败仍执行恢复扫尾的行为。 |
| supply_execute、supply_planner 与手工 CLI | [`supply_planner`](../../src/capabilities/practice/jobs/supply_planner.ts#L450-L475) 入队 `supply_execute`；[`buildSupplyExecutorDeps`](../../src/capabilities/practice/jobs/supply_execute.ts#L69-L100) 给 [`executeSupplyPlan` / `runQuizGenRoute`](../../src/capabilities/practice/server/question-supply/plan-executor.ts#L748-L787) 注入 quiz_gen 入队口。[`scripts/supply-execute.ts`](../../scripts/supply-execute.ts#L163-L173) 直接调相同 executor。 | 路由判断依 D6 比较后退出。计划事件+需求 ID 的 singletonKey、已派发不等于已获得的回执语义必须接到新路径；CLI 不能漏成旧 job 后门。 |
| confusable_contrast_nightly | [`runConfusableContrastNightly`](../../src/capabilities/practice/jobs/confusable_contrast_nightly.ts#L96-L116) → `discoverConfusableContrastTargets` → `dispatchSupplyTargets`，目标选择 quiz_gen。 | 保留错法对照需求、原开关与 cooldown，将需求交备题员；不新建“辨析出题 agent”。 |
| 练习流 refill | [`stream-store.ts`](../../src/capabilities/practice/server/stream-store.ts#L1446-L1461) → [`refillActiveLearningPools` / `refillThinPools`](../../src/capabilities/practice/server/question-supply/refill.ts#L140-L261) → `dispatchSupplyTarget`。 | 这是默认关闭但已接线的条件路径，不能漏查。本文硬边界第 7 条尚未决定是否接管 refill，留 owner 定；若保留 off，不得在旧 job 删除后留下可开启的悬空派发。 |
| 其余直接/潜在引用 | [`scripts/dev/question-supply-spike.ts`](../../scripts/dev/question-supply-spike.ts#L110-L135) 直接调用 `runQuizGen`，是开发脚本。[`runSourcingSequence`](../../src/capabilities/practice/server/quiz/sourcing-sequence.ts#L423-L505) 与 [`matcher`](../../src/capabilities/practice/server/quiz/matcher.ts#L506-L680) 有派发逻辑，但本基线未检出生产调用；`demandToSupplyTarget` 则由 refill 使用。 | 迁或删开发脚本；确认无调用的旧入口随退役删除，不误删 refill 仍消费的转换函数。`sourcing-sequence` 文件头关于 API 的注释不是现役调用证据。 |

推荐按依赖顺序交付，不按 102 个文本命中逐文件拆票：

1. 在现有候选工具和 store 内补齐第 2 点结构、来源与幂等契约，把第 3 点检查归入同门。此时新路径就有真实消费者，不先建空 registry 或新 agent。
2. 迁 API、`file_bank_gap`、CLI 与 placement 的接纳/恢复；再迁 nightly、planner/executor、contrast 和获 owner 确认的 refill。每组迁移同时搬走其真实约束与结果读取，禁止 web 失败后偷偷回旧 quiz_gen。
3. 完成生成路径迁移验收后，停止全部旧生成生产者；选第 5 点 A 时先完成路由并跑，选 B 时路由并跑后置。核对排队、运行、重试、DLQ、placement claim 和 `verify_dispatch_intent`。旧任务要么在旧 owner 下排空，要么作可审计终态处理；不能删除 handler 来丢弃未知付费效果，也不能重跑生成来补验证。
4. 最后删除独立 `quiz_gen` job 注册、API、队列派发契约及无消费者的 `quiz_gen_plan` 编排；`quiz_verify` / `source_verify` 的旧执行入口在检查和旧意图迁完后退出，不留两套并行裁决。[`manifest`](../../src/capabilities/practice/manifest.ts#L1004-L1045)、[`kernel/quiz-gen-contract.ts`](../../src/kernel/quiz-gen-contract.ts)、[`kernel/supply-dispatch.ts`](../../src/kernel/supply-dispatch.ts)、[`kernel/placement-jobs.ts`](../../src/kernel/placement-jobs.ts) 同批收口。
5. 删除前区分代码入口和历史词汇。`core/schema/quiz_gen.ts` 还被 [`verify-contract`](../../src/core/schema/verify-contract.ts)、`verify-framework` 与 placement outcome 读取；[`provenance.ts`](../../src/core/schema/provenance.ts)、`write-quiz.ts`、`practice-read.ts`、`fewshot-retrieve.ts` 仍解释历史题/卷。共享 schema 搬到实际 owner 后迁完 import 再删旧模块，持久化 `source='quiz_gen'`、metadata、核验事件、费用与历史卷可读性保留，不做全库替换字符串。

### 5. 排期结论：已选同批退役（A）；owner 2026-10-20 确认

| 排法 | 代价与可比较内容 | 退出条件 |
| --- | --- | --- |
| A．同一批：旧路由+quiz_gen 对照完整备题员路径，通过后一起退役（已选） | 少一次切换，但路由策略、生成器、父子写入、验证门同时变化，结果差异难归因；数周内维护两条写入与验证路径，回退也牵涉两套队列。 | 同缺口包含平题、父子题与恢复情形；盲核质量、成本、时限及未交付原因，所有调用方和旧任务收口后一起删。 |
| B．单独一刀：先迁生成/提交/验证并退役 quiz_gen，再并跑路由层 | 多一次有边界的切换，先承担第 2、3 点等价迁移验收；旧路由暂时仍作需求决策，但其供给执行交同一备题员，不再直达生成器。后续比较的是“旧策略约束下的选择”与“备题员自由选择”，不是原封不动的旧 quiz_gen 管线。 | 先保存旧路径基线证据，确认结构、来源、历史与恢复保证后迁调用方、排空旧任务并删 job；再按原 D6 并跑数周。对照约束只存在于现有任务输入，随旧决策层删除，不新增生产入口。 |

owner 于 2026-10-20 确认选 A（同批退役）：旧路由与 quiz_gen 对照完整备题员路径，通过后一起退役。原稿曾推荐 B（先收敛生成路径再比较路由），因可分开调用边界、减少比较变量；现以 owner 选择为准。选 A 即接受数周对照须运行未经改造的旧整条链；不能选择 A 却宣称只对照改造后的生成路径。

并跑期间须隔离两臂的候选、幂等回执与证据，不能让一臂的题库写入替另一臂填平缺口；只让指定交付臂进实际可练池。记录 exact revision、缺口输入、候选及发布摘要、task-run、provider/model/cost 和失败原因，协调线负责实际验收，不把本次静态调查称作实验结果。上述复用现有提交与发布边界，不新增对照平台。

排期已确认选 A（同批退役，owner 2026-10-20）。仍待 owner 确认：保留软判据还是收紧 `material_grounding` / `kind_conformance` 的缺证据语义；refill 是否接管。既有每请求数量限制与 placement 费用授权（`QuizGenTriggerBodySchema`、`placement-starter-attempts`）不能假借 D4“无质量数量顶、费用全记账”悄悄移除，其与新缺口任务的映射由 owner 在实施前定。本票不自行改这些边界，也不为每个调用方开 Linear 票。

## 硬边界（后果）

1. **零新入口**：七个 DomainTool 之外不新增 agent tool 面、不新增学习者可见面、不新建第二 commit seam 或第二事件总线（ADR-0067 D1 红线的供题版，验收项；工具清单 2026-10-11 经 ADR-0072 修订——`query_questions` 由 `search_bank`/`read_bank`/`check_bank` 取代）。
2. **`store_sourced_question` 是备题员与录题 agent 供给入库的唯一闸**（按 D8 泛化来源；交互式 Copilot 拟题的 `author_question` 提议面与现役流水线入库不在此列），六项门不因来源不同而放宽或收紧；入库题 100% 过自动判分准入（YUK-1445 口径）。
3. **agent 永不自盖金标**；金标是 owner 的品味资产，admitted ≠ gold。
4. **失败必须写回白板**（差什么、为什么不硬凑），缺口保持可见；不用降低门的代价换交付。
5. **花费不设上限但必须全额记账**：每题 provenance 含花费，费用账本照记（§9-7）；canary / 费用事件单写规则保留。
6. **jyeoo 覆盖诚实声明**（ADR-0068 D7）：只覆盖高中 10–12 数学，备题员不得假装它覆盖别的学段；web 只经现有 Exa 面、遵守 robots、不整站爬取。
7. **§9 八项承重能力不动**（见 D7）；refill（默认关）是否交备题员接管随实施一并定，不在本 ADR 预设。

## 分阶段交付（对齐 AGENTS.md 交付阶段）

1. **最小第一刀（TEST，先行）**：手工从白板 finding 造 3 张真实缺口单（零覆盖 KC、错法定向、难度带定向各一），跑一个备题员任务，查库 / 外部找 / 自己出三条战术至少各跑一次，候选全部经 `store_sourced_question` 入库（先按 D8 泛化来源，「自己出」才进得了闸）。验收：①零新入口、零并行写入器；②入库题 100% 过自动判分准入；③每题 provenance 完整、金标检索路径可复现；④费用全记账并出交付报告；⑤与 dispatcher 现状在相同缺口上做一次人工盲核对照（讨论稿 §6）。
2. **按真实时间安排（W2）**：接练习流；缺口单从白板/例会 + 夜间扫描安全网常态化产出；盲核通过、并跑数周后按 D6 退役旧路由层，并落实 D7 对 ADR-0067 D5 的修订（供题 cron 移交备题员）。

## 被拒绝的备选

- **三根管子外加智能排序（现状修补）**：管子属性仍先于质量，两套信任继续存在——被 D1「单一入口 + 同一道门」取代。
- **默认「自家库→外部→生成/改编」顺序作 prompt prior（讨论稿推荐）**：owner 未采纳——顺序完全交给 agent，纯按质量（S2）。
- **准入实测通过即自动金标**：准入 ≠ 出得好；金标会失去稀缺性与「owner 品味资产」的语义——被 D5 两级制取代。
- **切换之日直接删除旧路由层**：无对照证据、回退风险——先并跑盲核（S4），证据与第一刀共用。
- **AI 生成数量硬顶防失控**：owner 否决（「上限定的太低、设置难用」）；失控防护 = 无进展终止 + 门，不靠数量上限。
- **备题员自己也发现缺口（S1 选项 c）**：等第一刀有证据再议，例会成熟前不加第二缺口来源。

## 未决问题

- 无进展终止的轮数 N 初值（讨论稿建议 2），工程判断，待真实运行校准。
- 缺口单（GapTicket）schema 细节——以讨论稿 §1 字段表为起点，随第一刀实测定稿。
- 金标首批认证流程与语义检索面的落点：题库检索向量已存在，其版本/失效是 M012 已知待修项。
- 是否需要 Exa 之外的检索面。
- refill（默认关）是否由备题员接管。
- 「质量」入库后指标（真人作答区分度、「再练一组类似的」命中率）为预注册观察，达到样本量前不报数、不许诺。
