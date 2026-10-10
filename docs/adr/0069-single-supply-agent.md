---
status: accepted
---

# ADR-0069 — 单一备题员：题目的唯一入口与同一道准入门

**Status:** Accepted（设计方向，2026-10-11）；尚未实施。
**Decision source:** owner 2026-10-10 愿景评审「题源次序：只看质量，并且 agent 为题目唯一实际入口，而不是三根管子」；2026-10-11 拍板 S1–S4（决定记录 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/decisions/2026-10-11-supply-and-brain.md`），讨论票转实施。
**Tracking:** [YUK-1468](https://linear.app/yukoval-studios/issue/YUK-1468)。
**Related:** ADR-0067（教研白板与事件例会——本文 D7 修订其 D5 一处）、ADR-0068（通用学科，D7 来源覆盖诚实声明）、[YUK-1445](https://linear.app/yukoval-studios/issue/YUK-1445)（判分准入）、[YUK-1448](https://linear.app/yukoval-studios/issue/YUK-1448)（题库即题源——其验收 3 被 D3 取代）；讨论稿（细节真相源，绝对路径）`/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/supply-agent-draft.md`。

## 背景与问题

补题今天是一套固定管道：夜间扫描器 `target-discovery` 发现缺口 → `route-planner` 的写死约束序（要图先图源、要高可信先 web、客观题只走 web/拟题）→ `dispatcher` 把 job 送进 web 供给队列或 quiz_gen 生成队列；需求端另有夜间 `SupplyPlanTask` 规划与 `plan-executor` 的路由决策（`src/capabilities/practice/server/question-supply/`、`src/capabilities/practice/tasks/supply-planning.ts`）。质量不是排序依据，「管子的属性」才是；加一种找题方式要改路由、加 job、排队，且「jyeoo 的题 vs 生成的题」事实上存在两套信任。

owner 在 2026-10-10 愿景评审定方向：只看质量；agent 是题目唯一实际入口；AI 生成题不设硬顶、每题过同一准入门、来源可辨认；后台花费不设上限（「过去我们定上限定的太低了，而且设置也是真的难用」）。经讨论稿深度讨论（owner 的真选择 §7）后，2026-10-11 拍板 S1–S4。本文是决策记录，不是实施 spec：缺口单字段表、六项门的现有机件映射、战术册、成本与安全细节以讨论稿为真相源，本文只钉决定与边界。

## 决定

### D1 备题员 = 教研团成员，题目的唯一入口；工具箱是现有六个 DomainTool，零新入口

供题教研员（「备题员」）是教研团（ADR-0067 白板 + 例会体系）的一名成员，纯后台。它接收 typed 缺口单（GapTicket：考什么知识 / 错法定向、难度带、用途、数量与时限），自己决定去哪找题；现有六个 DomainTool 就是它的全部工具箱——`query_questions`（查自家题库）、`web_fetch_candidates`（Exa 检索→抽取→结构化）、`jyeoo_fetch_candidates`（高中 10–12 数学，预算租约内）、`generate_question_candidate`（自己出）、参考改编（检索金标范例后走 `author_question`）、`store_sourced_question`（唯一入库闸）。学习者永远只见到练习流，六个工具之外不新增任何入口、面或第二 commit seam。交付：候选 + 每题 provenance（来源、为什么选它、花了多少钱）+ 写回白板的供题完成 finding；失败也写回（差什么、为什么不硬凑）。空转由「无进展终止」兜住：同一缺口连续 N 轮零候选过门即停止并白板记失败面，绝不用降低门的代价换交付（N 初值见未决问题）。

### D2 缺口单来源：白板与例会为主，夜间扫描保留为安全网（S1）

缺口单来自白板 finding、例会决定（主席 `serve_probe`/`swap_item` 等动作）或手工；`target-discovery` 夜间扫描保留为安全网——例会成熟前防止供题退回纯时钟驱动。「教研员自己也发现缺口」等 §6 有证据后再议。

### D3 找题顺序完全交给 agent，只看质量，不设默认顺序（S2）

owner 未采纳讨论稿推荐的「默认自家库→外部→生成/改编顺序作 prompt prior」：顺序完全交给备题员，纯按质量取舍。**本条取代 YUK-1448 验收 3 的「先检索后生成」顺序约定**——检索与生成孰先孰后回归备题员的战术判断，唯一硬闸是 D4 的门；YUK-1448 的其余验收（题库即题源、按需准确找题、来源字段）不变。

### D4 同一道六项准入门，不分来源；AI 生成不设硬顶，失控防护 = 无进展终止，花费不设上限

不管候选来自 jyeoo、网络、生成还是改编，都过同一道门：①**自动可判**——经 YUK-1445 准入的 AI judge 独立解出且判分与金标一致，判不了的题不出；②**题面完整**——陈述可解、无歧义指代、选项/答案/解析结构齐全；③**图形正确**——图候选 staged 完好，缺图/坏图显式拒绝；④**去重**——canonical hash 精确重复合并 + KC 域 n-gram 近重拒绝（`store_sourced_question` 现有闸）；⑤**难度诚实**——无标定锚就写 unknown，不把「你做错了」当「这题难」；⑥**来源可辨认**——provenance 必填（jyeoo / web_url / generated / adapted_from:<id> / 本人材料），挂在 C19 已批的任意扩展 metadata 上。多数机件已存在；逐门现有承载与「质量」的可测定义见讨论稿 §2。AI 生成数量不设硬顶，唯一闸是这道门；失控防护是 D1 的无进展终止，不靠数量上限。花费照走费用账本但不设上限（owner 拍板）；jyeoo 的 producer 40/日硬闸与预算租约保留——那是外部授权约束，不是质量顶。

### D5 金标两级：admitted 自动、gold 仅 owner 亲手认证（S3）；agent 永不自盖

「能自动判分」在机器准入实测通过时自动标 `admitted`；「出得好、可作范例」是 `gold`，只能由 owner 亲手认证，作为 metadata 存储（`gold_certified: true` + 认证维度 + 认证人/日期），不新建表、不新建状态机。准入 ≠ 出得好，金标保持稀缺才配得上「精准找参考」；**agent 永远不能给自己出的题盖金标**——这是 ADR-0067 D1 防自喂红线在供题侧的落点。出题时按「标签 + 语义」检索 2–3 道金标进 prompt 作参考，改编产物 provenance 记 `adapted_from`。

### D6 旧路由层先并跑对比数周再退役（S4）；测试与切换由协调线全权负责

`route-planner` 的约束序、`dispatcher` 的自动派发、`SupplyPlanTask` 夜间需求规划、`plan-executor` 的路由决策——「决定走哪根管子」的判断层——先与备题员并跑数周（同缺口双跑 + 盲核对比），对比通过后删除；其机器门、预算租约、幂等（fingerprint cooldown）思想并入备题员任务。取水核心保留：jyeoo fetch 核、SourcingTask 核、quiz_gen job 及其双轴验证链不动（篇/组合结构仍需 quiz_gen，它是唯一会落 parent+question_part 行的生产者）。并跑对比、盲测与是否切换由协调线全权负责，不再找 owner——owner 原话：「测试你自己做，我不想管这个事。」

### D7 修订 ADR-0067 D5：供题批处理由备题员承接；§9 八项承重不动

ADR-0067 D5 中「供题/校准/结构维护/运维 cron 保留为批处理」修订为：**供题不再作为独立批处理路径保留，由备题员承接**；缺口发现层面的 `target-discovery` 夜间扫描按 D2 保留为安全网；校准、结构维护、运维 cron 保留。`docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md` §9 的 8 项 pre-AI 承重能力全部不动——本 ADR 不触碰其中任何一项。

### D8 入库闸泛化到所有来源，录题 agent 共用；不另造写入器

现状缺口：`store_sourced_question` 的 `source_route` 只接受 `jyeoo_fetch` / `sourcing_web`，且要求 fetch 工具产出的 `extraction_hash`；`generate_question_candidate` 是 `effect: 'read'`，只返回候选、不落库。也就是说「自己出」「改编」「本人材料」今天都进不了这道闸。第一刀必须**泛化这一个工具**，而不是新增并行写入器：`source_route` / provenance 扩为 `jyeoo_fetch | sourcing_web | generated | adapted_from:<id> | owner_material`，非 fetch 来源用各自的可复现指纹（生成输入摘要、改编源 id、材料资产 id）替代 `extraction_hash`；D4 六项门、精确/近重去重、`source_verify` 链对所有来源一致。知识点仍须 live（`dead_knowledge_node` 拒绝不变）；候选附带的新知识点只作提议，不自动批准，目标不当知识点。

照片录题若改为录题 agent（录题对比实验胜出后切换），题目同样经这一个闸入库，provenance 为 `photo_ingest`（源图、页、版面 bbox），门与去重不放宽。照片上的学生作答是关于**学习者**而非题目的事实，不经本闸：由录题侧的「记录作答」复用现有作答写入器，交准入 AI judge 判对错、过程瑕疵与能力（红笔含义按学习者偏好解读，事后订正不算作答），不属本 ADR 范围。对比实验期间录题 agent 只产出结构化结果、不写库。

## 硬边界（后果）

1. **零新入口**：六个 DomainTool 之外不新增 agent tool 面、不新增学习者可见面、不新建第二 commit seam 或第二事件总线（ADR-0067 D1 红线的供题版，验收项）。
2. **`store_sourced_question` 是唯一入库闸**（按 D8 泛化来源，供题与录题共用），六项门不因来源不同而放宽或收紧；入库题 100% 过自动判分准入（YUK-1445 口径）。
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
