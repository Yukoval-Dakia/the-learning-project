# 题源扩展设计 — 可信外部题源接入 + 出题规范指导（YUK-216 / Strategy D S2）

> 状态：owner 已逐节批准（2026-06-05 brainstorm，A/B/B+/C/D/E/F 六节 + 三轮澄清拍板）；
> 同日外部技术审（7/10，可进 plan）五条修正**已实证并折入**：tier 1 provenance 优先推导、
> §2.1 provenance metadata 合约、source_ref_kind 消歧、读模型扩宽入 slice 5、questionAuthoring 瘦身。
> 下一步：writing-plans 拆 implementation plan（spec 批准后）。
> 关联：[YUK-216]（本设计）· [YUK-214] S1 ingest→practice 桥接（前序）· [YUK-199] QuizGen search-grounded（强化对象）· kickoff 简报 `.omc/research/strategy-d-kickoff-briefing-2026-06-05.md`。

## 0. 问题与拍板账

**Owner 痛点（2026-06-05 提出）**：完全由 AI 自主生成的题目可能不够标准——具体两条：
1. **内容质量不可靠**：表述歧义、答案错、解析站不住。
2. **题型不像真题**：不符合考试题型规范/出题习惯（编程等未来学科同理：不像真实工程/面试题）。

难度标定与知识点覆盖不是本轮痛点（澄清 Q1 排除）。

**澄清轮拍板**（全部 owner 决定）：

| # | 问题 | 拍板 |
|---|---|---|
| Q1 | 痛点 | 内容质量 + 题型规范 |
| Q2 | 现实题源 | 四线全要：纸质/扫描真题教辅、电子题集（PDF/Word）、在线题库/网站、**检索素材供生成**（阅读题取真实原文） |
| Q3 | 进池准入 | **分层验证门**：真题人工 review 后 active；生成题一律 draft→verify；强度随层递增 |
| Q4 | 规范来源 | **双轨**：profile 硬规范 + 真题 few-shot |
| Q5 | 在线接入 | **按需检索 + 自动入库**（人不挡入库路，验证门裁决，evidence 留痕兜审计） |
| Q6 | 成功判据 | 四条全选：练习题主体来自可信源 / 每题可追源 / 阅读类题有真原文 / 生成题质量能对比 |
| 前置 | 学科优先级 | 先强化现有学科（math/physics/wenyan）；编程 subject + 可执行验证后置留接口 |
| 架构 | 三方案对比 | **方案 1：Source-tier + 按需四线复用**（题库中心化与纯生成强化均否） |

## 1. 现状地基（2026-06-05 实证）

- **QuizGen 已是 search-grounded 非裸生成**：`generation_method='search_grounded'|'closed_book'`；search_grounded 强制 ≥1 `source_ref`（`src/core/schema/quiz_gen.ts:117-128`，§0 自报 provenance）。QuizVerify 三检（grounding / copy_safety / knowledge-hit），过门 promote `draft_status` `'draft'→'active'` + FSRS enroll，不过门留 draft 永不进池，event 留痕 `experimental:quiz_verify`（`src/server/boss/handlers/quiz_verify.ts:12-24`）。
- **provenance 落点已在**：`question.source` / `question.source_ref` 列；`source_document.provenance` jsonb；artifact `intent_source/source/source_ref`。
- **真实 ingestion** = 最高可信题源；S1（YUK-214）已打通 ingest→practice。
- **缺口**：无题库级外部接入（唯一外部输入是 Tavily 搜索片段）；无 trust 分层语义；出题规范未注入 SubjectProfile。

## 2. A — Source-tier 模型（零 migration）

**不加新列**。tier 是纯推导函数 `deriveSourceTier(question)`。**推导不靠裸 `source` 枚举**（2026-06-05 外审折入：ingestion import 写 `source=session.entrypoint`，手动错题写 `source='manual'`，裸枚举判断会混层），而是 **provenance 优先**：

| Tier | 名 | 推导依据 | 语义 |
|---|---|---|---|
| 1 | `authentic` | **必须有 ingestion provenance**（`metadata` 中的 ingestion session 引用；具体键名 plan 阶段对 import route 写入实证）——不靠裸 `source='manual'` | 人出的题，物理来源 |
| 2 | `sourced` | source = `web_sourced`（新枚举值，`QuestionSource` 是 text 列外的 Zod enum——`src/core/schema/business.ts:30`，加值零 DDL）+ `metadata.web_sourced` 合约（见下） | 人出的题，网上检索来 |
| 3 | `material` | source = `quiz_gen` 且 `metadata.quiz_gen.generation_method='material_grounded'`（新方法值，`QuizGenGenerationMethod` 代码合约改动非 DDL）+ `metadata.quiz_gen.material_source_document_id` | AI 出题，锚在真实素材 |
| 4 | `generated` | `quiz_gen`（search_grounded / closed_book）、`variant_gen` | AI 出题，无实体素材锚 |

### 2.1 Provenance metadata 合约（slice 1 的核心交付，外审修正）

每个新来源在落库时写**显式 Zod 合约**的 metadata，不留读路径猜测空间：

- **`web_sourced`**：`metadata.web_sourced = { url, title, fetched_at, whitelist_match, extraction_hash? }`。
- **`material_grounded`**：`metadata.quiz_gen.material_source_document_id`（**注意：`question` 表无 `source_document_id` 列**——§8 原实证项已答：不存在；素材引用走 metadata，零 migration）。
- **`source_ref` 消歧**：现 `quiz_gen.source_ref` 是触发对象指针而非 URL（`src/server/boss/handlers/quiz_gen.ts:375` 附近），URL 在 `metadata.quiz_gen.source_refs`。每个新来源使用 `source_ref` 时**必须同时写 `source_ref_kind`**（metadata 内），避免语义多义。

三个消费点：① 每题展示标注（tier 徽章 + provenance 链——**数据层本设计落地，UI 标注 deferred**，见 §7）；② 组卷/召回偏好（§6 slice 5，**需扩宽读模型**：`ReviewCandidateSchema` 与 `get_review_due` 输出现均无 source/tier 字段——`review-plan-tools.ts:275` / `context-readers.ts:690`）；③ 验证门强度选择（§4）。

## 3. B — 四线管道 + B+ 需求侧调用次序

### 3.1 四线（各自复用什么）

1. **PDF/扫描线 → tier 1**：复用现有 OCR ingestion 管道**原样**；电子 PDF 转图后与拍照同路（零新建）；人工 review 后 import。批量 = 多 session，第一波不做批量便利装置。
2. **在线检索线 → tier 2**：唯一全新件 **SourcingTask**——输入「学科 + 考点/题型 + 数量」，按 profile 源白名单检索 → 抽取结构化题 → **自动落库** `draft_status='draft'` + `source='web_sourced'` + `source_ref`=URL → 链式 enqueue 验证（Q5 拍板：人不挡入库）。
3. **素材生成线 → tier 3**：QuizGen 扩展 `generation_method='material_grounded'`——先检索真实素材（阅读原文/真实数据），素材**持久化**入既有 `source_document` 表（带 URL provenance），出题强制引用素材；验证门额外校验「题确实考这份素材」。阅读题真原文判据由此兑现。
4. **闭卷/variant 线 → tier 4**：完全不动，自然垫底。

### 3.2 B+ 需求侧调用次序（owner 自述模型，正式化）

四线是 **agent 缺题时的统一找题次序**，任何消费场景（组卷、弱点专项、QuizGen 触发、复习池补题）需要「知识点 X 的题」时：

```
1. 先查已入库   question 表既有题（任意 tier，优先高 tier）
2. 外部检索     SourcingTask 找现成题 → 自动入库 draft → 验证门
3. 素材生成     material_grounded → 验证门
4. 闭卷兜底     closed_book / variant_gen → 验证门（最重）
```

- 能找到人出的题就不自产——「纯 AI 生成不够标准」在调用层的体现。
- 每步产出自动入库 → 次序天然有记忆性：**题库是用出来的，不是囤出来的**。
- 次序是策略不是硬编码：per-题型偏好放 profile（如阅读题直奔第 3 步——真原文 + 新题比网上旧阅读题更对路）。
- 边界：第 1 步「已入库」含 owner 做过的真题；本次序服务「要新题/扩充练习」场景，不绕过错题本。

## 4. C — 分层验证门（QuizVerify 泛化）

按 tier 配置检查项与强度的统一验证框架，复用既有形态（pg-boss 链式 job、draft_status 生命周期、event 留痕）：

| Tier | 验证门 | 检查项 |
|---|---|---|
| 1 authentic | **人工 review 即门**（现状不变，不叠自动门） | — |
| 2 sourced | 自动·中 | 结构完整性（题面/答案/解析齐）+ **solve-check** + 源一致性（对照源页面）+ 与已入库题去重 |
| 3 material | 自动·中 | 素材 grounding（题确实考素材）+ **solve-check** + 题型规范符合（对照 profile 硬规范） |
| 4 generated | 自动·最重 | 现 QuizVerify 三检 + 题型规范符合 + **solve-check** |

**solve-check（核心新增）**：verify 时由独立 solver（与出题不同 capability/prompt）**真把题解一遍**，解出答案与题带答案对不上 = fail。对「内容质量不可靠」最硬的自动手段——答案错、表述歧义解不动的题进不了池。每题只在**入库 verify 时跑一次**（非每次做题），成本 = 新题入库速率，单用户可忽略。

每次 verify 写 event（tier + 各检查结果 + 拒因），喂 §5 可观测判据。检查器设计为**可插拔**——编程学科将来挂「沙箱跑测试」checker 即接入（本设计不实现）。

## 5. D — 规范双轨

- **轨 1 · 规范层 = 标准 Agent Skills（第五轮定稿，owner 纠正 + 调研核实，取代「键控 markdown pack」表述）**：
  - **出题规范是真 Agent Skill**（agentskills.io 标准）：每题型一个目录 `src/subjects/<id>/skills/quiz-gen-<kind>/`——`SKILL.md`（frontmatter `name`==目录名 + `description` 写清做什么/何时用）+ `references/`（评分细则 rubric.md、坏题反例 anti-patterns.md）+ `assets/`（精选范例 few-shot.json）。**三层 progressive disclosure 由 SDK 原生提供**：L1 metadata 常驻（~100 tok）、L2 正文命中才读、L3 资源按需逐文件——few-shot/细则不命中不烧 token。
  - **激活 = 键控为主、model-invoked 为副**（关键裁决）：出题任务的题型是**请求参数给定的**，不需要 description 路由——handler 按 `(subject, kind)` 把 `Options.skills` **白名单到唯一一个**（`['quiz-gen-<kind>']`），确定性由 key 保证、token 由 progressive disclosure 保证。因为存的是标准 SKILL.md，将来开放场景（agent 自主选题型 / Copilot 会话式出题）零迁移切 model-invoked。
  - **runtime 接线（调研实证，slice 4 的具体 scope）**：本仓全部 AI task 走 Agent SDK `query()`，SDK v0.3.143 已有 `Options.skills?: string[] | 'all'`（`sdk.d.ts:1721`）；当前失效根因是 runner 隔离（`runner.ts:211-220` 空 tmpdir CLAUDE_CONFIG_DIR + `:243-263` buildQueryOptions 不传 skills）。接线三处：(a) `buildQueryOptions` 透传 `skills` + skill 发现目录；(b) 保持 dev-config 隔离前提下精确发现 `src/subjects/<id>/skills/`（settingSources/additionalDirectories，不整体取消隔离）；(c) quiz_gen handler 键控白名单——与既有 per-handler MCP+allowedTools 注入同构（`quiz_gen.ts:271-314` 同一条缝）。
  - **profile（strict Zod，保持瘦）只剩被代码逻辑消费的结构化事实**：源白名单（SourcingTask 过滤）、per-题型找题次序偏好（§3.2 路由）、题型枚举 key 表。**不建 skill 注册表抽象**（反过度工程：skill 名按 `quiz-gen-<kind>` 约定解析，目录缺失走降级链 kind → subject 通用 → 无；引用完整性交给 `skills-ref validate` 式校验 + audit 轻检，注册表等第二个消费方出现再议）。
  - **验证门加载同一 skill**做「题型规范符合」检查——出题与验题对齐同一份，改一处两边生效。
  - **安全语义**：`Options.skills` 是 context filter 不是 sandbox（未列入的文件仍可被 Read 触达）——**skill 文件里不放任何密钥**。
  - **术语**：统一叫 skill，且现在是**标准层面**的统一——交互 skill（U6 Copilot，skill_context/skill_turn）与出题规范 skill 是同一 SKILL.md 生态的两个消费端。slice 4 附带 doc rider：AF spec §1.3 加注。注意 `src/server/copilot/skills/` 是同名陷阱（纯 TS service 函数，非 SDK skill），接线时勿混。
  - 难度标尺暂不进（Q1 非痛点）。
- **轨 2 · 真题 few-shot**：生成时按「学科 + 题型（+ 知识点近邻）」检索已入库**高 tier 范例**（authentic 优先）注入 prompt 作软风格锚。真题库越厚越像真题——与 Strategy D 飞轮互喂。
  - **检索器机制**（owner 问答折入，2026-06-05）：filter = subject + kind + tier（authentic 优先降级 sourced）+ `draft_status='active'`（过门题才配当范例）；排序 = tier → 知识点重叠数（jsonb 包含查询，`due-list.ts:215` 同款先例）→ 最近；LIMIT 2-4。注入块声明「模仿题型结构/表述/答案格式、不得抄袭内容」，copy_safety 兜底。0 命中降级为 profile 硬规范-only（现状），不阻塞。
  - **增益曲线**：题库薄时命中「泛题型」范例，每张 ingest 的真卷加密 (题型 × 考点) 覆盖，few-shot 逐渐升级为「同考点同题型」范例——零训练，纯检索（RAG over 自有题库），立刻生效。
- **生成策略的归属**（owner 两轮问答折入，2026-06-05 定稿）：生成策略剖成两半——
  - **学科半（策略内容，subject-catered）→ 两级落点**（第四轮拍板后定稿，取代早先「全进 promptFragments」表述）：**短小、单句级**的学科策略片段沿用既有 `promptFragments` 模式（`profile-schema.ts:61`；先例 `variantExamplePolicy`）；**per-题型的成段规范内容**进标准 Agent Skill（轨 1，SDK 原生 progressive disclosure）。skill 名按 `quiz-gen-<kind>` 约定解析，无注册表（轨 1 第五轮定稿）。
  - **机制半（引擎，跨学科）→ 代码**（task 实现层）：few-shot 检索算法、skill 候选集接线（`Options.skills` 键控白名单，body 加载交 SDK 原生）、prompt 骨架、条数、降级逻辑。profile 片段经 `task-prompts.ts` 既有模式织入，skill 正文由 SDK progressive disclosure 拉取。外审「questionAuthoring 保持瘦」约束的最终落实：**引擎参数不进 profile，成段内容不进 profile（进 skill 文件），profile 只剩结构化事实**。
  - **task input** 放运行时参数（数量、目标知识点）。
  - **与 AF skill 层的关系**（owner 第三轮问答折入）：AF 设计（`specs/2026-06-04-agent-framework-design.md` §1.3）定义 skill = prompt/context/policy 行为包，且 skill 是「apply which subject policy」——**skill 携带场景行为，不携带学科内容**。完整四层 = profile（学科内容）/ skill（场景行为：注意什么、怎么解释、输出形状）/ 引擎代码（机制）/ task input（运行时）。本设计的 SourcingTask/QuizGen 按 AF §2.5 归 **narrow backend task**（窄 allowlist、pg-boss），非 Copilot skill；将来若要 Copilot 会话式触发找题/出题（「帮我找几道 X 的题」），做薄入口（skill 或 tool grant）调同一后端——显式 out of scope，留接口（与 AF「ingestion correction skill」例子对 OC-5 的关系同构）。
- **闭环点**：验证门（§4）的「题型规范符合」检查用轨 1 同一份规范——出题与验题对齐同一标准源，改一处两边生效。

## 6. E/F — 验收对账与切片

### 6.1 四判据兑现表

| 判据 | 兑现机制 | Wave 1 边界 |
|---|---|---|
| 练习题主体来自可信源 | 组卷/召回按 tier 偏好选题（§3.2 消费端） | 偏好逻辑落地 + tier 分布可查询；不做统计面板 |
| 每题可追源 | tier 推导 + provenance 链（source_ref URL / ingestion session / source_document） | **数据层可追**；UI 徽章/链接 deferred 到 UI wave（design pre-flight 硬规矩） |
| 阅读类题有真原文 | 素材线：原文持久化 + 题面强制引用 | 全量落地 |
| 生成题质量能对比 | verify event：per-tier 通过率、拒因分布 | event 数据全量；查看走轻量查询/admin 小节 |

### 6.2 实施切片（每片独立绿，各自 Linear issue）

1. **地基（定义收紧，外审修正）**：`deriveSourceTier(question)` + **provenance metadata Zod 合约**（§2.1 四条：authentic 须 ingestion provenance / `metadata.web_sourced` 形状 / `material_source_document_id` / `source_ref_kind`）+ enum 扩容（`web_sourced`、`material_grounded`）+ 验证门框架泛化（含 solve-check）+ tests——纯后端。**provenance 合约是本片核心交付**，钉死后 2/3/5 才不糊。
2. **在线检索线**：SourcingTask（依赖 1 的合约与验证门）——纯后端
3. **素材生成线**：素材检索持久化 + 据材出题 + grounding 检查（依赖 1）——纯后端
4. **规范双轨**：profile 瘦 section（白名单/次序/题型 key 表，无注册表）+ **标准 Agent Skill 目录**（`src/subjects/<id>/skills/quiz-gen-<kind>/`，SKILL.md + references + assets）+ **runner 接线三处**（buildQueryOptions 透传 skills / 隔离内精确发现 skills 根 / handler 键控白名单——`runner.ts:243-263`、`runner.ts:211-220`、`quiz_gen.ts:271-314`）+ few-shot 检索器 + 验证门接 skill——后端 + profile + skill 文件；附 AF spec §1.3 加注 doc rider
5. **消费端**：组卷/召回 tier 偏好接线（§3.2 次序）+ **读模型扩宽**（`ReviewCandidateSchema` / `get_review_due` 输出加 source/tier）——纯后端

1→2→3 依赖验证门地基；4、5 相对独立可调序。

## 7. 不做清单

1. 不批量爬站建库（题库中心化方案已否：工程重、合规风险、单用户无库存需求）。
2. 不建新表、零 migration（question / artifact / source_document 全复用；新写入者按 step9 invariant 白名单流程登记）。
3. 不动 FSRS 调度算法——tier 只影响「组卷选哪题」，不影响「何时复习」。
4. 不新建 PDF 文本解析路径——电子 PDF 转图走现有 OCR 管道；对电子 PDF 的 OCR 质量不满意时再单开。
5. 编程 subject 不做（验证 checker 可插拔留接口）。
6. UI 标注（tier 徽章 / provenance 展示 / 质量对比面板）deferred 到 UI wave。
7. 不做难度标定与覆盖选题优化（Q1 排除的非痛点）。

## 8. 风险与开放点（plan 阶段处理）

- **已答实证项（2026-06-05 外审）**：~~`question` 表 `source_document_id` 列存在性~~ → **不存在**，素材引用走 `metadata.quiz_gen.material_source_document_id`（§2.1）；~~ingestion 题的 `source` 值~~ → `source=session.entrypoint`（且 manual 错题同写 `source='manual'`），故 tier 1 推导改 provenance 优先（§2）。
- **plan 时仍待实证**：import route 写入 metadata 中 ingestion session 引用的具体键名（tier 1 推导落点）；SourcingTask 抽取的结构化形状对 `StructuredQuestion` 的复用度；few-shot 检索的实现位（SQL 检索 vs 既有检索原语）。
- **solve-check 误杀**：表述合法但 solver 弱解不出 → fail 拒真题候选。缓解：拒题留 draft + 拒因 event，可人工捞回；per-tier 阈值可调。
- **源白名单冷启动**：owner 初期需在 profile 填首批可信域名；SourcingTask 对白名单外源只引用不入库（或降权），plan 阶段定。
- **与 OC-5 站衔接**：ingestion 复查面（YUK-164 #2）后续落地时，tier 1 的人工门与其合一，不另建面。
- **skill 生态展望（owner 问答折入，非本设计 scope）**：runner 接线一次建成后，后续 skill 全是纯增目录。候选（按契合度）：judge 判分细则 skill（与出题 skill 共用 `references/rubric.md`，出题/solve-check/判分三方对齐——**YUK-216 内顺手**）；教学法包（YUK-213 cut-over 后）；ingestion correction（OC-5 站，AF §1.3 原生例子）；coach 计划规范、note 风格规范（等信号）。U6 交互 skills（TS 函数形态）**不迁移**到 SKILL.md——等真实复用场景出现再议。判据三条：成段领域知识 / 按需性 / 多消费方。
