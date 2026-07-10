# YUK-597 — 科目原语 v3：trait 组合 + prose charter（implementation contract draft）

2026-07-10 · **v3.2 已批准（owner 判词 2026-07-10）—— implementation contract 权威稿**。两轮 owner review 已闭合：R1（4 P1 + 2 P2：general 写面锁定 / 原子 COW / journal 血统字段 / 冷启动降级链 / 锁序 / 四锚点验收）+ R2（2 P1 + 3 P2：控制面全局 advisory lock 灭 phantom / fallback 下 version 用 effective 身份 + builtin 地板收口 / 外国种子一律 COW / deep-equal no-op / 两 journal 共用 change_seq）。各节带 v3.1/v3.2 标记。承接链：v2 契约（`2026-07-10-yuk597-custom-subjects.md`，owner 批准 #748）→ owner「Subject Control Plane」proposal v2（`2026-07-10-subject-control-plane.md`）→ 9 席对抗面板（run `wf_2c38ce81-8c2`：3 外部检索 + 4 对抗 + 2 替代设计）→ owner 三判词收束。本稿是 **v2 的 delta 契约**：替换其 §2 状态模型与相关写面，其余章节（goal 防线、knownSubjects、传播、启动/失败矩阵、backup 纪律）按明示方式承接。已获批，取代 v2 成为实施权威（v2 未被替换章节按上述明示方式继续生效）；YUK-603（scope_mode，已上生产 `4918753c`）不受影响。

## 0. 判词收束记录（本稿的输入，不再复议）

| 判词 | 内容 | 来源 |
|---|---|---|
| A | 科目常态 ~10 个、有时更多 → **跨科复用是一等需求** | owner 2026-07-10 |
| B | 「新工作新配置」语义足够 → **LISTEN/NOTIFY/SSE/outbox/epoch 全部出局**，传播 = v2 基线 | owner 2026-07-10（与 Character.ai/Custom GPTs 品类语义一致，面板检索席佐证） |
| C | 排序 = 教室先于 CMS：Phase-0 bug → 原语裁决 → 598/599 → 600 → **602 提前** → 601；资产层挂触发器 | owner 认可 Fable 建议 2026-07-10 |
| R | 科目级 rubric 定位 = **全局规范指导题目级 rubric**：写端注入（生成/提取），judge 介入为 calibration-gated 二期 | owner 2026-07-10 |
| 面板共识 | 唯一全场共识采纳项 = append-only 版本 journal + rollback-forward（Custom GPTs restore 教训；Humanloop 全生命周期产品死亡教训）；draft/publish 状态机、双计数器、purge、rubric/source/curriculum 三资产类不采纳 | `wf_2c38ce81-8c2` |
| owner v3 review R1 | 4 P1（general 写面须锁定原地编辑 / COW 须原子写合同 / journal 须承载 fork 血统与 seed_version 快照 / 冷启动降级链须定义）+ 2 P2（写路统一锁序 / rubricGuidance 四锚点独立验收）→ v3.1 闭合 | owner 2026-07-10 |
| owner v3.1 review R2 | 2 P1（subject-first 锁序有换绑 phantom → 控制面全局 advisory lock；fallback 后 version provenance 未定义 → effective 身份 + builtin 地板收口）+ 3 P2（外国种子一律 COW——按 trait ownership 不按 subject origin；相同 payload deep-equal no-op；两 journal 共用单调 change_seq）→ 本 v3.2 闭合 | owner 2026-07-10 |
| owner 终判 | **批准 v3.2 全文** → 本稿为 YUK-597 实施权威（取代 v2 的 §2 状态模型与相关写面；实施开工令另下） | owner 2026-07-10 |

沿 v2 不动的判词：D1 = subject_profile 入 DB 全案；D2 = opaque `subj_<cuid2>`；2026-06-07/08 全部红线。

## 1. v2 → v3 裁决级变更

| v2 条目 | v3 判决 | 依据 |
|---|---|---|
| `subject_profile` 单表 `definition jsonb` 整 blob | **替换**为 trait 表族（6 kind）+ `subject_trait_binding`；科目 = 绑定的聚合视图 | 判词 A：10+ 科目共享 DNA 时 blob 强制 N 份分叉；面板 alt-B「复用是判别性需求」 |
| thin-create = 克隆 general definition 快照 | **替换**为绑定 general 的共享 trait（零复制）；编辑时 copy-on-write fork | 结构性解掉面板 data-model 席「fallback_clone 标签撒谎」flaw：未 fork 的科目**真的**活跟随 general |
| `persona_state` 显式列 + 单向闩 | **删除列**，改为派生：`isGeneralFallback ≡ 全部绑定仍指向 default-fallback 的种子 trait` | 派生态不会撒谎；面板 pedagogy 席「成熟度派生不手写」 |
| revision 快照历史 =「可选层，owner 未点名不建」 | **升格一等**：每 trait append-only `subject_trait_journal` + rollback-forward | 面板唯一全场共识；无 draft 状态机、无 active_revision 指针、无双计数器 |
| `PUT /api/admin/subjects/:id` 整 definition | **替换**为 per-trait `PUT /api/admin/traits/:id`（CAS + 装配级 fan-out 校验） | trait 是编辑单元；装配校验防组合破坏 |
| （无） | **新增** charter trait 的 `rubricGuidance` 节：写端注入题目级 rubric 生成/提取 prompt | 判词 R |
| worker 60s refresh + app 即时 + 浏览器 mutation 失效 | **原样保留**；owner proposal §7 的 LISTEN/SSE/BroadcastChannel/outbox/epoch 不采纳（BroadcastChannel 允许作 ~15 行可选贴纸，非合同项） | 判词 B |
| （owner proposal）四类 typed 资产控制面 | method_pack 维持 disk+git，DB 化挂触发器；rubric_pack/source_catalog/curriculum_pack 搁置（各自独立否决理由，§5.3） | 面板 pedagogy/right-sizing 席 |
| 实施依赖序 …→ 601 → 602 | **602 提前到 601 之前**（onboarding 先于 admin 编辑器） | 判词 C |

不变量（v2 原样承接，本稿不重述细节）：opaque 不可变 id；`subject_name_claim` 单命名空间（NFC 归一）；thin-create 幂等（display_name_norm 部分唯一索引 + 200 回放 + custom↔builtin 撞名 422）；`ensureSubjectRoot` root id 钉 `seed:<id>:root` + genesis/anchor（event-sourced from birth）；goal 写路径防线（v2 §3.5）；knownSubjects 分类合同（v2 §6）；boot-gate 水合 + never-throws 失败矩阵（v2 §4）；backup FK_ORDER/SCHEMA_VERSION/round-trip 纪律（v2 §3.7，表清单见本稿 §6）；scope_mode（已上生产）。**v2 §9 实施前置项 ①-⑪ 逐条裁定**（owner 亲自升格的前置纪律，不许静默丢）：①②③⑧⑩⑪ **仍为前置**（① subjectProfiles stale-const 穷举、② upsert×.has 守卫、③ KnownSubjectId→string tsc、⑧ 硬编码 SCHEMA_VERSION/表数 grep——按本稿新表族口径、⑩ accept canonical 纯度、⑪ countWeakNodesInDomain opaque 分桶，各归原 issue 首验）；⑤⑨ **已随 PR-0 落地消化**（root 直标题 SQL、due-list live-resolve 成本）；④⑥⑦ **被 trait 模型消解**（无克隆、无 persona_state 列、无深拷贝独立性问题），其中 ⑦ 转生为新前置 **⑫ fork 深拷贝独立性**（fork payload 与源 trait 的引用隔离），另加 **⑬ 装配 deep-equal 基线**（=本稿 §8-13）与 **⑭ version 消费者穷举核查**：judge 相关四 trait 身份串已是默认（§2.1），实施前 grep `profile.version` / `profile_version` / `capability_ref.version` 全部消费者（已知：invoker.ts:126-130、attribute.ts:235,253、paper-submit.ts:593、submit.ts:607、rejudge.ts:189、admin-subjects.ts:16、YUK-573 / `audit:calibration` 读点），确认无人依赖「全量配置身份」或 '1.0.0' semver 形状语义；有则该消费者单独裁定。

## 2. 状态模型：trait 表族

### 2.1 六个 trait kind 与字段切分（SubjectProfile 全字段无遗漏映射）

| trait_kind | 承载字段（自 profile-schema.ts:38-92） | 消费性质 |
|---|---|---|
| `charter` | languageStyle、promptFragments 六槽（roleNoun/noteExamplePolicy/variantExamplePolicy/teachingStyle/checkQuestionPolicy/learningIntentPolicy）、noteTemplate 五节、**新增 methodology**、**新增 rubricGuidance** | 纯 LLM prompt 消费（prose 命名节） |
| `judge_policy` | questionKinds、judgePolicy{preferredRoutes,notes}、judgeCapabilities | 确定性 registry 路由 + 校验 |
| `cause_taxonomy` | causeCategories | FK 语义（错因 tag id + review_priority 数学 + 下拉） |
| `source_policy` | grounding{requirement,allowedSources,uncertaintyPolicy}、sourceWhitelist、sourcingRoutePreference、exampleSources | 供题路由 + whitelist 匹配 |
| `render_theme` | renderConfig（+ 未来 uiTheme token 位） | 渲染 switch（katex 等）。`SUBJECT_TONE` 本地 map（MistakesPage:78/QuestionsPage:102）沿 v2 保留——custom 恒 neutral，复活触发器见 §5.3 uiTheme 行 |
| `scheduling` | schedulingHints | FSRS 参数 |

`id`/`displayName` 归 subject 控制行。**装配 `version` = judge 相关四 trait 的身份组合串** `jt:<charter_id@rev>;<judge_id@rev>;<cause_id@rev>;<source_id@rev>`（装配时计算，不落列）。三个刻意设计点：① **组件 = trait_id@revision 而非裸 revision**——fork（新 id 从 rev0 起）与换绑（换 id 不动 rev）都必然改变串（裸 rev 组合在这两种操作下会碰撞：fork 未编辑的 rev0 种子 → 串不变但配置已分叉）；② **只取 judge 相关四 trait**（charter/judge_policy/cause_taxonomy/source_policy）——`version` 经 invoker.ts:126-130 盖进不可变 judge 事件的 `capability_ref.version` 与 D6 `profile_version` 章（attribute.ts:235,253 / paper-submit.ts:593 / submit.ts:607 / rejudge.ts:189），render/scheduling 的编辑与判分无关，混进去会伪信号「判分能力换代」污染 append-only 证据史；render/scheduling 变更**有意不动 version**（全量配置身份由 §3.5 admin 读面按 trait 逐个下发，编辑器不缺信息）。**粒度权衡成文**：charter 整体计入 judge 相关（rubricGuidance/风格确实影响新题 rubric 作者化），代价是纯教学向的 charter 编辑（teachingStyle 等）也会 bump version——trait 粒度下无法再细分，接受这个良性抖动；不接受的反向（把 charter 排除）会漏掉 rubricGuidance 的真实判分代际；③ `SubjectProfileSchema.version` 是必填 `z.string().min(1)`（validate-profile.ts:152 硬校验），组合串满足。**术语纪律（owner 裁定）：这是「身份代际」串，不是内容哈希**——相同 payload 的重复写（rev 照 bump）仍会换代；需要内容等价判断的场景（如 §6 reconcile）用 `seed_version` / deep-equal，不用本串。④ **组件 = effective 身份（v3.2 / owner R2-P1）**：正常态 = `id@<liveRev>`；降级链（§2.2）触发时 version 必须指向**实际被采用**的配置——journal 回溯采用 rev4 → 组件写 `id@4`（不是坏行的 rev5）；代码种子兜底 → 合成身份 **`id@seed:<seedVersion>`**（无 journal revision 可指，血统串是它唯一可审计的身份）。D6 章因此永远指向真实生效的配置，不指向没人用过的坏行。**charter payload = 扁平命名节对象，`.strict()`**（歧义钉死：不是嵌套 promptFragments）：顶层键集 = `{ languageStyle, roleNoun, noteExamplePolicy, variantExamplePolicy, teachingStyle, checkQuestionPolicy, learningIntentPolicy, noteTemplate{definition,mechanism,example,pitfall,check}, methodology, rubricGuidance }`——写门在这层 `.strict()` 拒未知节名（422）。**装配层负责映回** `SubjectProfile` 旧形状（languageStyle 回顶层、六槽回 `promptFragments{...}`、methodology/rubricGuidance 作为 promptFragments 两个新字段），注入点按槽名取值与今日逐字节兼容。六个 per-kind Zod schema 统一落 `src/subjects/trait-schemas.ts`：charter（如上，strict）、judge_policy `{questionKinds, judgePolicy, judgeCapabilities}`、cause_taxonomy `{causeCategories}`、source_policy `{grounding, sourceWhitelist, sourcingRoutePreference, exampleSources}`、render_theme `{renderConfig}`、scheduling `{schedulingHints}`（后五个复用 profile-schema 既有子 schema，全 strict）。methodology/rubricGuidance 两个新字段 = `z.string().default('')`——**显式不带六槽的 `.min(1)`**（空串是合法初态；带 .min(1) 会让 thin-create 与全部装配校验当场翻红；分歧有意，测试钉死「全空两节校验绿」）。校验席勘误记录：`validateProfile` 非 `.strict()` 且丢弃 parse 产物（validate-profile.ts:142-150），它不承担未知节守门——守门在 trait 写门 strict schema；既有六槽消费点不迭代键（task-prompts.ts:106/266/455/501/525/667），加字段零破坏。

### 2.2 DDL（Drizzle 语义）

```ts
subject:                                    // 控制行：身份 + 生命周期
  id                text PK                 // builtin: general/yuwen/math/physics；custom: subj_<cuid2>
  display_name      text notnull            // rename 权威（root.name 同步，v2 §3.4 语义）
  display_name_norm text notnull
  origin            text enum('builtin','custom') notnull
  is_selectable     boolean notnull default true    // general → false（结构性排除，v2 §2.1）
  retired_at        timestamptz null
  revision          integer notnull default 0       // 控制行 CAS（rename/retire/restore）
  created_at / updated_at

subject_trait:                              // 单活行 = 当前生效 payload（无 active 指针）
  id                     text PK            // custom: trt_<cuid2>；种子: trt_seed_<subject>_<kind>（migrate 幂等键）
  trait_kind             text enum(六 kind) notnull
  origin                 text enum('builtin','custom') notnull
  payload                jsonb notnull      // per-kind Zod schema（§2.1 字段组）
  payload_schema_version integer notnull
  seed_version           text null          // 种子血统 semver：仅种子 trait 非空，代码种子改内容即 bump；
                                            // reconcile 的比较对象（v2 profile_version 在 trait 粒度的转世）。
                                            // custom/fork trait 恒 null（无种子血统，reconcile 不触达）
  owner_subject_id       text null FK → subject.id
                                            // v3.2（owner R2-P2）：custom/fork trait 的属主科目（fork/thin-create 时落）；
                                            // 种子 trait 恒 null——其属主由 id 模式 trt_seed_<subject>_<kind> 表达。
                                            // 「自有才可原地写」判据的载体（§3.1）
  revision               integer notnull default 0   // CAS，每写 +1
  created_at / updated_at

subject_trait_journal:                      // append-only 历史（undo-to-any + 审计，一张表两用）
                                            // v3.1（owner P1-3）：每行是该 revision 的**完整状态快照**——
                                            // payload + schema 代际 + 当时的 seed_version + 血统指针，
                                            // 缺任何一个都无法从 journal 重建历史 trait 状态
  trait_id           text FK → subject_trait.id
  revision           integer
  payload            jsonb notnull
  payload_schema_version integer notnull
  seed_version       text null              // 本 revision 时点的种子血统（reconcile/reset_to_seed 会改它，
                                            // 快照进每行才能重建「这版内容对应哪代种子」）
  action             text enum('create','edit','rollback','reconcile','reset_to_seed','fork_source') notnull
  actor              text enum('owner','migrate') notnull
                     // 固定映射：create/reconcile → 'migrate'；edit/rollback/reset_to_seed/fork_source → 'owner'
  source_trait_id    text null               // fork_source 行专用：来源 trait
  source_revision    integer null            // fork_source 行专用：来源 revision（provenance 可重建）
  rolled_back_from   integer null
  change_seq         bigint notnull          // v3.2（owner R2-P2）：与 subject_control_journal 共用
                                            // 全局序列 subject_change_seq——两本 journal 的公共全序坐标，
                                            // exact as-of = 按 change_seq 重放（trait/subject revision 是
                                            // 各自局部序，created_at 不承诺并发提交顺序）
  created_at         timestamptz notnull
  PK(trait_id, revision)

subject_trait_binding:                      // 科目 = 六绑定的聚合（只存现态；时间线在 control journal）
  subject_id  text FK → subject.id
  trait_kind  text enum(六 kind) notnull
  trait_id    text FK → subject_trait.id
  PK(subject_id, trait_kind)                // 每科每 kind 恰一绑定；trait_kind 与目标 trait.trait_kind 一致由写门校验

subject_control_journal:                    // subject 粒度 append-only 时间线（trait journal 的镜像）
  subject_id  text FK → subject.id
  revision    integer                       // = 控制行 revision（每次控制行写 +1，天然单调键）
  action      text enum('create','rename','retire','restore','reset','rebind','fork') notnull
  detail      jsonb notnull                 // rebind/fork: {kind, from_trait_id, to_trait_id}；rename: {from,to}；
                                            // create/retire/restore: {}；reset: {rebound: [{kind, from_trait_id, to_trait_id}]}
  actor       text enum('owner','migrate') notnull
  change_seq  bigint notnull                // 共用 subject_change_seq（见 trait journal 注）
  created_at  timestamptz notnull
  PK(subject_id, revision)

subject_name_claim: 沿 v2 §2.2 原样
```

- **装配**：`resolveSubjectProfile(subjectId)` = 读六绑定 → 六 trait payload → 拼回现有 `SubjectProfile` 聚合形状。**「消费点无感」的诚实边界（校验席核实）**：**服务端**消费点无感（domain.ts / bridge / questions-list / runner ctx.subjectProfile 等继续拿同一形状，水合后从 registry 取装配结果）；**浏览器侧 12 消费点不走装配**——SPA 现在静态打包四个硬编码 profile（ui/lib/subject.ts 同步 registry），custom 科目对它们不可见，这正是 v2 §7 已设计、YUK-598 承载的 provider 化工作（slim projection：displayName/renderConfig/causeCategories/isGeneralFallback 经 `GET /api/subjects` 下发；sync 函数保留为 builtin 兜底）。v3 不新增浏览器义务，但把这条边界写明，防「无感」被读成含 SPA。registry 内存侧缓存装配结果；**trait 写后重装该 trait 的全部绑定科目，控制行写（rename 等影响装配输出的）同样触发本科重装**——否则 rename 后缓存里滞留旧 displayName 直到下一次无关写。
- **复用语义**：多科绑定同一 trait_id = 真共享（改一处、绑定者新工作全部生效）。**写面双轨（v3.1，详 §3.1）**：只改一科 → subject-scoped 编辑**同事务自动 fork-and-edit**（默认安全路径）；改全体绑定者 → trait-scoped 显式共享写（编辑器带波及面提示）。不存在「暗改别科」路径，也不存在「fork 成功 edit 失败」的两步中间态。
- **坏行隔离与降级链（v3.1 / owner P1-4——「last-good」在冷启动时不存在，链条成文）**：单 trait 行 safeParse 失败时——① **运行期**（进程已有装配缓存）：绑定科目保留内存 last-good + WARN；② **冷启动**（新进程无缓存）：**从该 trait 的 journal 按 revision 降序回溯，取第一条 safeParse 通过的历史 payload 作 last-good** + WARN（journal 的第二用途——历史就是快照仓）；③ journal 也全坏/无行：**种子血统 trait（seed_version 非空）→ 回 `BUILTIN_TRAIT_SEEDS` 代码种子**；custom/fork trait 坏死时**按绑定者的 origin 收口（v3.2 / owner R2-P1）**——绑定者是 **builtin 科目** → 整科回退 import-time 代码 profile（**四 builtin 地板不可破**，即便它绑了 custom trait）；绑定者是 **custom 科目** → 该科本轮装配缺席。任一层都不 throw，其余科目不受影响。**降级态的 version 用 effective 身份**（§2.1④），管理读面显式区分 live 与 effective（§3.5）。测试 9 断言**最终返回哪份 profile**（见 §8）。
- **alias 水合（显式重申，防承接丢失）**：装配水合在读 subject 行时 **JOIN `subject_name_claim` kind='alias'**，把别名传入 `register()/upsert()`——v2 §4 该步骤原先长在被替换的 blob 读取器内，trait 模型下归装配水合层（YUK-599）。丢这步 = wenyan→yuwen 等 legacy 域别名全体 miss（KILL-1 回归）。

### 2.3 派生态（不落列）

- **general 绑定永久钉死（v3.1 / owner P1-1）**：general 的六条绑定**结构性锁定**在 `trt_seed_general_<kind>`——fork 与换绑写门对 `subject_id='general'` 一律 422（负测钉死）；general 只允许 ① 原地编辑其种子 trait（走 §3.1 显式共享写，本就是「改 fallback 全体跟随」的语义）② trait 级 reset-to-seed。没有这条锁，general 一旦换绑，`isGeneralFallback` 的比较靶漂移：未 fork 科目仍显示「沿用默认」却不再真的跟随——派生真值的诚实性以此为前提。
- `isGeneralFallback(subject) ≡ 六绑定全部指向 general 的种子 trait`（**general 自身豁免**——它对自己恒真是语义噪音，admin 枚举对 general 置 null/不适用）——**按 trait 身份（id）判定，不比内容**：owner 编辑过 general 的 charter 后，未 fork 的科目仍为真（它们确实在活跟随 general，这正是标签的诚实语义；thin-create 此后新建的科目同样绑定编辑后的 general trait——v2「DB wins」意图的直译）。thin-create 后为真；任一 fork/换绑后为假；reset（§3.4）后回真。`GET /api/subjects` 下发该派生布尔（v2 §7 payload 合同不变）。
- owner proposal 的四级成熟度阶梯不采纳；两态派生（沿用默认配置 / 已配置）+ retired 已覆盖诚实刻度（面板 pedagogy 席）。

## 3. 写面与 API

### 3.1 编辑：双写面（v3.1 / owner P1-2——「编辑即 COW」落为原子写合同）

**主写面（编辑器默认）：`PUT /api/admin/subjects/:id/traits/:kind`（subject-scoped，自动 COW，单事务）**

```jsonc
PUT { "expectedSubjectRevision": 4, "expectedTraitRevision": 3, "payload": { ...该 kind 全字段... } }
```
同一事务内：取控制面 advisory lock（见下「并发协议」）→ per-kind strict Zod parse → **deep-equal no-op 预检（v3.2 / owner R2-P2）**：规范化后的新 payload 与当前生效 payload 深等 → **200 no-op**（不 fork、不写 journal、不 bump——「保存未修改的表单」不得制造内容相同的空分叉、不得翻转 isGeneralFallback；显式脱离另有 §3.3 fork 端点）→ **所有权判定（v3.2 / owner R2-P2——按 trait ownership，不按 subject origin）**：
- **自有** ≡ `trait.id == trt_seed_<本科>_<kind>`（本科自己的种子）**或** `trait.owner_subject_id == 本科`（本科 fork/创建的 custom trait）→ 原地写：装配校验（自有种子可能被他科借绑 → 校验波及全部绑定者）→ trait CAS → journal 'edit'。
- **非自有**（他科种子——哪怕本科独占绑定；他科的 fork；general 种子）→ **同事务 fork-and-edit**：新 `trt_<cuid2>`（owner_subject_id=本科；journal rev-0 'fork_source' 携带**来源快照** + rev-1 'edit' 携带新 payload）→ 改绑定 + subject.revision+1 + control journal 'fork' → 装配校验本科。yuwen 独占借绑 math 种子再编辑 → fork，**math 种子永不被外科暗改**，math 日后 reset-to-seed 读到的仍是自己的血统。**不存在** fork 成功而 edit 失败的中间态（一个事务，全有或全无）。
- **例外**：`subject_id='general'` 永不 fork（P1-1 锁定；general 只有自有种子可编，走原地写 + fan-out）。

**显式共享写（编辑器「编辑共享面（影响 N 科）」按钮）：`PUT /api/admin/traits/:traitId`**

```jsonc
PUT { "expectedRevision": 3, "payload": { ... } }
```
影响全部绑定者的自觉动作：per-kind strict parse → **装配级 fan-out 校验**（每个绑定科目 assemble + `validateProfile`，任一失败 → 整体 422 回显科目+issues）→ trait CAS → journal 'edit'。commit 后重装全部绑定科目。**诚实定位**：今日 `validateProfile` 跨字段检查全在单 kind 内（validate-profile.ts:136-178），fan-out 是防御网 + 未来跨 trait 约束挂点，非当下正确性依赖；~10 科规模毫秒级。

**并发协议（v3.2 / owner R2-P1——row-lock 锁序有换绑 phantom，整体替换）**：v3.1 的 subject-first 行锁序有结构洞——共享 trait 写须先读 `boundBy` 才知道锁哪些 subject，但读名单与锁 trait 之间，并发科目可以**换绑进入**该 trait，逃过锁定与 fan-out 校验。控制面是低频写面（单用户、日级操作数），正确解不是更精巧的锁序而是**整面串行化**：一切控制面写事务（本节两写面、§3.3 fork/换绑、§3.4 全部控制行写、§3.6 thin-create、§6 reconcile）开头执行 `pg_advisory_xact_lock(SUBJECT_CONTROL_PLANE_LOCK)`（常量 key，事务结束自动释放）——phantom、锁序、死锁问题整类消失；reconcile 的 owner-journal 判定天然在锁内。**CAS 保留但语义降为陈旧提交守卫**：advisory lock 串行化并发事务，`expectedRevision` 拒绝的是「UI 拿着旧状态提交」（409），两者各司其职。数据面（学习流量）零涉及。

### 3.2 回滚：`POST /api/admin/traits/:traitId/rollback`

```jsonc
POST { "expectedRevision": 8, "targetRevision": 5 }
```
从 journal 取 rev5 行 → 走 §3.1 全套校验（含 fan-out；目标若引用已退场 capability → 422 不静默降级）→ 写为 **rev9**（rollback-forward = git-revert 非 git-reset；journal 记 action='rollback' + rolled_back_from=5）。**恢复范围钉死（v3.1）**：恢复 `payload` **与** `payload_schema_version`（皆取自目标 journal 行，schema 代际是内容的一部分，upgrade-on-read 兜旧代际）；**不改 seed lineage**——行上 `seed_version` 保持当前值（rollback 是内容裁决，不是血统操作；血统只被 reconcile / reset_to_seed 移动）。历史行永不改写。

### 3.3 fork 与换绑

**fork（显式剥离，不带编辑）：`POST /api/admin/subjects/:id/traits/:kind/fork {expectedSubjectRevision}`**
复制当前绑定 trait 的 payload 为新 `trt_<cuid2>`（origin='custom'，**owner_subject_id=本科**）+ 改写该科绑定 + subject 控制行 revision+1 + control journal 'fork' 行，单事务。新 trait 的 **journal rev-0 行 = action='fork_source'，`source_trait_id`/`source_revision` 列指向来源、payload 列存来源快照**（兼任创建记录，provenance 可重建——v3.1 journal 血统字段）。日常「改共享 trait 的本科版本」**不必**先调这里——§3.1 subject-scoped 编辑已原子 fork-and-edit；本端点是「先剥离、稍后再改」的显式意图面。fork 后双向独立（无同步语义）。`subject_id='general'` → 422（P1-1 锁定）。

**换绑：`PUT /api/admin/subjects/:id/traits/:kind/binding {targetTraitId, expectedSubjectRevision}`**
「化学借数学的 rubric」的载体。写门：target 存在且 `trait_kind` 匹配 → **装配校验本科**（assemble + validateProfile，fail→422）→ 改绑定 + subject 控制行 revision+1（并发守卫走 subject.revision CAS，`subject_trait_binding` 不设自己的计数器）+ **`subject_control_journal` 记 'rebind' 行**（{kind, from_trait_id, to_trait_id}）→ commit 后重装本科。绑定时间线由 control journal 承载（校验席戳穿了初稿「trait journal 覆盖」的错误论证——trait journal 只有 payload 史，重建不了「某日化学绑的是谁」；append-only 红线下 as-of 重建与 backup 保真都需要这张表）。一切控制行写（create/rename/retire/restore/reset/rebind/fork）同事务落 journal 行，PK 复用控制行 revision。

### 3.4 控制行写面（rename / retire / restore / reset / validate——显式路由，CAS 轴 = subject.revision）

```jsonc
PATCH /api/admin/subjects/:id            { "expectedRevision": 2, "displayName": "化学基础" }   // rename
POST  /api/admin/subjects/:id/retire     { "expectedRevision": 3 }
POST  /api/admin/subjects/:id/restore    { "expectedRevision": 4 }
POST  /api/admin/subjects/:id/reset      { "expectedRevision": 5 }
POST  /api/admin/subjects/:id/validate   { "traitPayloadOverrides": { "charter": {...} } }      // 无状态，不带 CAS
```

- **rename**（PATCH）：控制行 CAS + display_name/norm 更新 + root.name 按 id 同步同事务 + control journal 'rename' 行（{from,to}）+ claim 不动 + 历史 payload 不回写（v2 §3.4 语义原样；trait 零涉及）。撞 display_name_norm 唯一索引 → 409。
- **retire/restore**：控制行 `retired_at` + control journal 'retire'/'restore' 行（v2 语义：retired 仍 resolvable、不进 selectable/词表/nightly）；restore 撞名 409；**general 不可 retire**（固定 default fallback；owner proposal 的可替换 fallback 机制不采纳——未来要换另立小改）。
- **reset（subject 级）= 只换绑，永不改共享 payload**：六绑定全部指回本科种子 trait（custom → general 种子；builtin → 本科 `trt_seed_<subject>_<kind>`），displayName 保留（custom）/回种子且**同事务 root.name 回种子名**（builtin，镜像 rename 的三写点纪律）；孤儿化 fork trait 及其 journal 保留（无硬删面）。控制行 revision+1 + control journal 'reset' 行。**与 v2 §2.4 的显式分歧**：v2 reset 会重写 definition 内容；trait 模型下种子 trait 是共享活行，从一科发起的 reset 不得波及其他绑定者——若种子 trait 本身被编辑过，恢复出厂内容须用下述 trait 级动作（全局、显式）。
- **reset-to-seed（trait 级）：`POST /api/admin/traits/:id/reset-to-seed {expectedRevision}`**：仅对有种子血统的 trait（`seed_version` 非空）合法；payload 覆写为**当前代码种子** + `seed_version` 对齐 + revision+1 + journal（action='reset_to_seed'，actor='owner'）。共享行为与任何 trait 写一致：装配级 fan-out 校验，影响全部绑定者（这正是「把 general 恢复出厂」应有的全局语义）。
- **validate（无状态）**：装配（可带 overrides）+ validateProfile，只回 issues 零落库（编辑器预检；面板 alt-A 席的 draft 替代物）。

### 3.5 读面（YUK-601/602 编辑器与 badge 的 HTTP 表面）

```
GET /api/admin/subjects              → 管理枚举：全量 subject 含 general 与 retired
                                       { id, displayName, origin, retiredAt, isGeneralFallback, version(组合串) }
                                       （现有 admin slim 端点扩容——编辑器选科的数据源，GET /api/subjects 只给 selectable 不够）
GET /api/admin/subjects/:id/traits   → 六绑定 { kind, traitId, origin, ownerSubjectId, seedVersion,
                                       revision, effectiveRevision, degraded: 'journal_fallback'|'code_seed'|null,
                                       payload, sharedBy: [subjectId] }
                                       // v3.2：live revision 与 effective fallback 身份分列下发——
                                       // 降级中的 trait 在编辑器可见「实际在用哪份」
GET /api/admin/traits?kind=<kind>    → 跨科 trait 目录 [{ traitId, origin, seedVersion, revision, boundBy: [subjectId] }]
                                       （换绑选择器的数据源——「化学借数学的 rubric」得先能列出候选）
GET /api/admin/traits/:id/journal    → append-only 历史（rollback UI 的数据源）
GET /api/subjects                    → v2 §7 payload 合同原样 + isGeneralFallback（派生；general 置 null）
```
`sharedBy` 让编辑器在写共享 trait 前展示波及面（配合 §3.1 fan-out 422 的可解释性）。

### 3.6 thin-create 修订（比 v2 更薄）

`POST /api/admin/subjects {displayName}` 单事务：① subject 行 ② canonical claim ③ **六条绑定 → general 的六个 trait 行（零新 trait 行、零 payload 复制；general 若已被 owner 编辑过，绑定的就是编辑后的活 trait——§2.3 语义）** ④ `ensureSubjectRoot`（v2 §3.1 语义：root genesis + anchor）⑤ `subject_control_journal` 'create' 行（revision 0，actor='owner'）→ commit 后 registry 装配上架。幂等/撞名/回放全沿 v2 §3.2。201 payload 沿 v2 + `isGeneralFallback: true`（派生）。

## 4. charter 规范与 rubricGuidance（判词 R 落地）

### 4.1 节 → 注入点映射（合同表）

| charter 节 | 注入目标 | 现状锚 |
|---|---|---|
| languageStyle + promptFragments 六槽（roleNoun/teachingStyle 等）+ noteTemplate | 既有注入点原样（note/quiz/copilot/intent prompts） | profile-schema.ts:42,61-68 消费点不动 |
| methodology（新） | copilot/note 教学 prompt 的方法论段（渐进接入，首版可空串） | 新增节，空串 = 无注入 |
| **rubricGuidance（新）** | **仅「作者化题目级 rubric」的 prompt**（校验席实读核定的真实作者化锚点，判据 = 装配 rubric 生成 prompt 的点）：quiz-gen 生成（task-prompts.ts:649/745 一带）、question_author、sourcing 提取（task-prompts.ts:883 一带）、copilot 教学 ask-check 的 **buildTeachingTurnPrompt**（task-prompts.ts:524-541，rubric_json 指令 :533——materialize-ask-check.ts:87 只是持久化行，不是注入点）。**显式排除**：image-candidate-accept / auto-enroll（accept 时写 `rubric_json:null`，无 prompt 可注入）、answer_class_backfill（纯复制）；**reference_answer_backfill 的排除是刻意范围裁定而非「无判分语义」**——它的 buildSolutionGeneratePrompt 产出的 expected_signals 确实并进 rubric_json 供 Steps/SemanticJudge 消费，但 R 判词瞄准的是 criteria/keywords/required_points 的作者化风格；该 prompt 列为二期候选（与 judge 注入同批，calibration-gated） | 今日六槽中无任何 rubric 槽——AI 写 rubric 零科目级指导，风格漂移无人管 |

### 4.2 rubricGuidance 边界（红线级）

- **一期/二期判据（成文，防切分显得随意）**：一期 = **新题目创作面**——rubric_json 随题目诞生被作者化的 prompt（quiz-gen / question_author / sourcing 提取 / 教学 ask-check 出题），R 判词的字面对象；二期 = **既有题目的判分行为面**——改写或增强已存在 rubric_json（solution-generate 的 expected_signals 合并）与 judge prompt 注入，动它等于改判分行为，必须 calibration-gated。
- **judge 读端零变化（限定口径）**：判卷 prompt 与**既有** `question.rubric_json` byte 不变 → YUK-573 校准遥测零扰动；**新生成题目**的 rubric 风格变化是 R 判词的目的本身，不在「零扰动」承诺内。
- **judge 介入 = 显式二期**，前置条件 = 校准线 before/after agreement 对照（measure-then-tune）；本契约不含。
- 配套审计（触发器：rubricGuidance 非空后）：`audit:rubric-conformance` report-only 扫存量题目 rubric 与本科规范的偏离。

## 5. 传播、资产与搁置清单

### 5.1 传播（判词 B 成文）

v2 §4 原样承接：app serve 前水合 + 写后进程内 post-commit 重装（即时）；worker `startSubjectRefresh` 60s 全量 reconcile（level-triggered，是承重路径不是兜底）；浏览器 mutation 即时失效 + 窗口聚焦重取。**LISTEN/NOTIFY、SSE、BroadcastChannel、outbox、catalog epoch 均不进合同**（B：新工作新配置足够；面板检索席：fan-out≈1 时流式无正当性、K8s level-triggered 定律、LISTEN 推送半边在本仓是死代码）。BroadcastChannel 若实施者顺手加（~15 行零服务端）不算违约，但不是验收项。**in-flight 稳定性（owner proposal D7 的处置，防漏账）**：任务在入口取 `ctx.subjectProfile` 拿到的是不可变装配对象，registry 重装是**换 Map 引用**不改旧对象——已捕获引用天然稳定；长 job 中途**重读** registry 会拿到新版（最终一致，v1 接受），D7 的全量 per-job snapshot 机构不采纳，触发器 = 真实的中途换挡事故。

### 5.2 资产层（method_pack）

维持 disk+git。**Phase-0 两个已验证 live bug 立即单独修**（与本契约批不批无关）：① Dockerfile 漏 COPY `src/subjects/_shared/skills`（生产 copilot/quiz-gen 共享包正在静默降级，Dockerfile:70-72 仅三科）；② runner 扁平 skill 目录跨科撞名（quiz-gen-calculation 类无科目前缀）→ populate 时目录名加科目前缀 + 构建期撞名 audit。method_pack DB 化触发器：owner 开始**从 UI 高频**编辑方法论包。

### 5.3 搁置清单（各自独立否决理由，不只是「贵」）

| 项 | 否决理由 | 复活触发器 |
|---|---|---|
| rubric_pack（直喂 judge） | 判卷标准在题目行粒度；与 YUK-573 measure-then-tune 相撞 | 校准线跑出 before/after 方法后，作为二期 judge 注入的载体再议 |
| curriculum_pack | 与自底向上 evidence tagger 成两条竞争进图路径；种子/证据 KC 去重语义未定义；空心 KC 污染 ≥5 gate | 冷启主线通电后若出现真实「预置课程骨架」需求，先解决去重与 provenance 语义 |
| source_catalog | 现消费者只有 matchesWhitelist 字符串后缀匹配 | sourcing 路由需要富目录元数据的那天 |
| draft/publish 状态机、purge、成熟度四级 | 面板终裁 §二（Custom GPTs/Humanloop 证据；retire 已覆盖删除时刻） | 出现第二作者 / 真实 blast-radius 事故 / 隐私级擦除需求 |
| uiTheme token 位 + SUBJECT_TONE 本地 map 消灭（含 proposal 的 tone audit） | custom 恒 neutral 是 v2 已接受的降级；render_theme trait 已留位 | owner 点名要求自定义科目的视觉分科（届时 token 进 render_theme payload + tone audit 同批） |

## 6. 迁移与种子

v2 的 `subject_profile` 表**从未实施**（幸运窗口）→ 直接建 §2.2 表族，无二次迁移。migrate 种子（`reconcileBuiltinTraits`，沿 v2 §3.6 语义按 trait 粒度）：

1. **种子真相源 = `BUILTIN_TRAIT_SEEDS[subjectId][kind] = { payload, seedVersion, payloadSchemaVersion }`**（实施时从现有 4 个 profile 分解生成；**seedVersion per-trait 独立**，初值各 '1.0.0'——bump charter 种子不会虚触发 judge/render 等其他 kind 的 reconcile）。migrate 对每个种子 trait：**先读行比 seedVersion，相等则整行跳过**（不碰 payload/updated_at/revision/journal——「重跑零副作用」由条件写成立，不是裸 `ON CONFLICT DO UPDATE` 能给的）；行不存在 → INSERT + journal rev-0（action='create'，actor='migrate'）；`ON CONFLICT DO NOTHING` 只兜首插并发。charter 的 methodology/rubricGuidance 节种子为空串。**通则：一切 trait 创建路径必须写 rev-0 journal 行**（seed='create'/migrate；fork='fork_source'，见 §3.3）。
2. subject 行 ×4 + 绑定 ×24 + claims（canonical ×4 + builtin 别名迁入）。
3. 升级判定 per-trait：**触发信号 = 代码种子 semver ≠ 行 `seed_version`**（v2 profile_version 的转世；纯内容改动 bump 代码种子 semver 即传播，Zod 形状不变也能升级）。相等 → **硬 no-op**（不写 journal、不 bump revision——reconcile 路径的幂等由此成立，migrate 重跑零副作用）；不等且未被 owner 编辑 → 覆盖升级 + `seed_version` 对齐 + journal 'reconcile'；被编辑过 → 保留 + WARN。**并发纪律（v3.2）**：reconcile 事务同样先取 §3.1 的控制面 advisory lock，owner-journal 判定在锁内读——不与并发的 owner 写互踩。**「被 owner 编辑」谓词按 journal 的权威单调键 revision 定义**（不用 created_at——时钟并列/偏斜下脆弱）：`∃ actor='owner' 行，其 revision > max(revision WHERE action ∈ {create, reconcile, reset_to_seed})`——边界谓词使状态可清除：owner 编辑后 reset-to-seed 恢复出厂 → 谓词翻回未编辑，后续种子升级恢复送达（append-only 下「永久冻结」问题的解法；reset_to_seed 自身虽是 owner 行但同时就是新边界，严格大于号天然自排除）。v2 的 user_modified 布尔由此派生，**不设列**。
4. builtin 各科绑定**自己的**种子 trait（yuwen 的 judge_policy ≠ general 的）；共享 upside 主要给 custom（thin-create 绑 general）与 owner 手动换绑。

backup：FK_ORDER 追加 `subject` → `subject_trait` → `subject_trait_journal` → `subject_trait_binding` → `subject_control_journal` → `subject_name_claim`（父先子后）；SCHEMA_VERSION bump；constants.test 断言随动；round-trip 覆盖**六表**（两本 journal 全量保真，**含 `change_seq` 列**——exact as-of = 按公共 change_seq 全序重放，v3.2）。**restore 序列尾**：`setval('subject_change_seq', max(两表 change_seq)+1)`——序列本身不随行备份，不补 setval 会撞已有坐标。

## 7. 对实施单的影响（批准后对齐，惯例同 v2 轮）

| Issue | 处理 |
|---|---|
| **新增小单 ×2（判词 C 首位，立即）** | Phase-0：Dockerfile `_shared` COPY 修复；skill 目录前缀 + 撞名 audit |
| YUK-598 | 基本不变（三集合/provider/scope_key 与原语正交）；isGeneralFallback 改派生源 |
| YUK-599 | `subject_profile` 单表 → §2.2 六表族（两本 journal）+ per-trait reconcile（seed_version 短路）+ backup 表清单更换；水合装配层（**含 alias claim JOIN**） |
| YUK-600 | thin-create 换 §3.6 修订版（更薄）；goal 防线 + knownSubjects + nightly 候选源原样；**+ rubricGuidance 注入接线**（§4.1 四锚点——与 knownSubjects 同属 AI prompt 合同批） |
| **YUK-602（提前）** | onboarding 手填 UI，排在 601 前；badge 数据源 = 派生 isGeneralFallback |
| YUK-601 | trait 编辑器（per-kind 表单 + charter 节编辑）+ fork/换绑 UX（选择器数据源 = §3.5 跨科目录）+ journal/rollback/reset-to-seed UI + validate 预检 + §3.5 读面 + audit:profile --db（装配粒度）**+ 夜间 cron `--strict`（v2 PR7 原样保留）**；needs_review 裁定沿 v2 defer-to-badge；revision 快照历史被 journal 取代（v2「可选层」升格为一等，非丢弃）；UI design doc 前置不变 |
| 触发式 follow-up（届时立单） | `audit:rubric-conformance`（rubricGuidance 非空后）；method_pack DB 化；uiTheme（§5.3） |

## 8. 验收矩阵（红线测试）

1. thin-create「化学」→ subject 行 + claim + 六绑定指向 general 种子 trait + root/genesis/anchor 同事务；**零新 trait 行**；isGeneralFallback=true（派生）。
2. **共享传播**：owner 编辑 general 的 charter → 未 fork 的化学**新工作**装配到新 payload（app 即时 / worker ≤60s）；已 fork 的科目不受影响。
3. **COW 原子性与隔离（v3.1）**：化学经 subject-scoped 端点编辑共享 charter → **单事务** fork-and-edit（journal rev-0 'fork_source' 带来源快照 + rev-1 'edit'；绑定已换；control journal 'fork' 行）→ 仅化学变化；再改 general charter → 化学不动；isGeneralFallback 翻 false。**原子性反证**：装配校验失败的 fork-and-edit → 零残留（无新 trait 行、无 journal、绑定未动）。
4. fan-out 校验：编辑被 3 科绑定的 judge_policy 引入非法 capability id → 422 回显三科 issues，零科目生效。
5. rollback-forward：rev5→rev9 重写目标 payload；journal 含 rolled_back_from=5；目标引用已退场 capability → 422。
6. CAS：并发两写后者 409 `{currentRevision}`。
7. rename：控制行 + root.name 同步 + **control journal 落 'rename' 行**；trait journal/claim/历史 payload 不动。
8. reset：绑定全部回种子 trait；孤儿 fork trait 及其 journal 保留。
9. 坏 trait 行降级链三层各自断言（v3.1）：手写坏 payload 进 subject_trait → **运行期**绑定科目保内存 last-good；**重启后**装配 = journal 回溯的最近合法 revision（断言 payload 逐字段等于该 journal 行）；**journal 清空后重启** = 种子 trait 回代码种子（断言等于 `BUILTIN_TRAIT_SEEDS` 值）、custom trait 绑定科目缺席（registry 无该科 + WARN）；全程 never-throws，其余科目正常。
10. **rubricGuidance 注入——四锚点各自独立正测（v3.1 / owner P2-6）**：设置化学 rubricGuidance → ① quiz-gen 生成 prompt ② question_author prompt ③ sourcing 提取 prompt ④ 教学 ask-check 的 buildTeachingTurnPrompt，**四者分别断言含该节**（快照/包含断言各一，不合并）；**judge prompt byte-diff 为零**（负测另见 test 20）。
11. reconcile：bump yuwen charter **代码种子 seed_version** → 未被 owner 编辑的行覆盖升级 + journal 'reconcile' + seed_version 对齐；owner 编辑过的保留 + WARN；**seed_version 相等 → migrate 重跑零 journal 行零 revision 变化**（幂等）；owner 编辑后 reset-to-seed 再 bump 种子 → 升级恢复送达（谓词边界清除）。
12. backup：dump→wipe→restore **六表族（两本 journal：trait payload 史 + subject 控制时间线）**全量保真——含 `subject_control_journal` 的 as-of 重建能力；FK_ORDER 漏登记 module load 即 throw。
13. 装配兼容：resolveSubjectProfile 输出与今日 4 个硬编码 profile 逐字段 deep-equal，**除**：`version`（改 `jt:` 身份组合串，断言格式）与 charter 新增两节（断言 default 空串）——迁移零行为变化基线的诚实口径（`version` 值语义变化已在 §2.1 成文：D6 章从 '1.0.0' 变为 judge 相关身份串）。
14. **换绑**：化学把 judge_policy 换绑到数学的 trait → 装配用数学值；并发换绑后者 409（subject.revision CAS）；kind 不匹配 422。
15. validate 无状态：带 overrides 回 issues，零落库。
16. retire/restore：retire 后 resolvable 但不进 selectable/词表/nightly；restore 撞名 409；general retire 被拒。
17. **v2 §8 承接红线全量对账**（编号统一冠 v2- 前缀防与本矩阵撞号）：阻断②组（v2-tests 6-7，knownSubjects）与阻断④ goal 归一组（v2-tests 12-13）随承接机制原样保留；**v2-test-8（启动日志序 hydrated 先于 listening、drop 表重启四 builtin 照常）、v2-test-9（worker 免重启可见 + SIGTERM 清 refresh 定时器 + `pnpm build` 无 top-level await 混入 CJS）、v2-test-14（命名空间抢占 422 + 内存 register 显式 throw）→ 归 YUK-599 红线**；v2-tests 10/11/15/16 已由本矩阵 1/6/12/11 覆盖；阻断①组（v2-tests 1-5）已随 PR-0 上生产。
18. **alias 水合直测**（KILL-1 防回归）：装配水合后 `resolveKnownSubjectId('wenyan')==='yuwen'`（claim JOIN 生效）；drop claim JOIN 即红。
19. methodology 注入：设置某科 methodology → copilot/note 教学 prompt 含该节；空串 → prompt 零变化。
20. rubricGuidance **负测**：image-candidate-accept / auto-enroll / answer_class_backfill / reference_answer_backfill 路径的 prompt（如有）与持久化行为在 rubricGuidance 非空时 byte-diff 为零（排除表是合同不是巧合）。
21. 读面：GET admin subjects 枚举含 general+retired（isGeneralFallback 对 general 置 null）；GET .../traits 六绑定含 `sharedBy`；GET /api/admin/traits?kind= 跨科目录含 `boundBy`；GET .../journal 与写序一致。
22. **reset-to-seed 专测**：编辑共享种子 trait → reset-to-seed → payload == 当前代码种子、seed_version 对齐、journal 'reset_to_seed'、全部绑定者重装到出厂值。
23. **version 身份语义**：fork 未编辑的 charter → version 变（id 换）；同 rev 换绑 judge_policy → version 变；编辑 render_theme → version **不变**（判分无关，D6 章免抖动是设计不是缺陷）。
24. **general 写面锁定负测（v3.1 / owner P1-1）**：对 general 发 fork → 422；发换绑 → 422；原地编辑其种子 trait（显式共享写）→ 成功且全体未 fork 科目新工作跟随；reset-to-seed → 成功。
25. **deep-equal no-op（v3.2）**：subject-scoped 提交与当前生效 payload 深等的表单 → 200、零新 trait、零 journal、isGeneralFallback 不翻；显式 fork 端点照常可用（脱离是显式意图）。
26. **外国种子 COW（v3.2）**：yuwen 换绑独占借用 math 的 judge_policy 种子 → subject-scoped 编辑 → 自动 fork（owner_subject_id='yuwen'）；math 种子 payload 未变，math reset-to-seed 后仍是自己的血统。对照：yuwen 编辑**自己的**种子 → 原地写。
27. **降级态 provenance（v3.2）**：journal 回溯降级中建 goal/判分 → D6 章的组件 = `id@<effectiveRev>`（非坏行 live rev）；代码种子兜底 → `id@seed:<seedVersion>`；GET .../traits 同步下发 effectiveRevision + degraded；builtin 绑定的 custom trait 坏死 → 整科回 import-time 代码 profile（四 builtin 地板断言）。

## 9. Non-goals（显式，防止再漂）

- LISTEN/NOTIFY / SSE / outbox / catalog epoch / draft-publish 状态机 / purge / 成熟度四级阶梯。（BroadcastChannel 不在此列——它是零服务端的同源标签贴纸，非验收项但实现不违约，见 §5.1；防漂对象是服务端推送机器。）
- rubric_pack 直喂 judge、curriculum_pack、source_catalog（§5.3 触发器表管辖）。
- **校准/learner-model 版本轴**：ITS 席警告「科目改版可能重释历史 mastery」记录在案，归 YUK-573 校准线作为已知边界管理，非本契约义务（科目 trait 不携带 per-KC 参数）。
- KC 粒度 trait 绑定（KLI 席「逐 KC 对齐」）：future，待 KC 级消费者出现。
- 多作者/RBAC、fixtures 产品化（沿 owner proposal §1.2）。

## 10. 红线自查（2026-06-07/08）

全局一图 ✓（trait 层零图语义）；科目=effective-domain 派生视角 ✓（trait 只挂策略，不碰图）；实体无 subject 列 ✓；跨科=mesh 边 ✓；AI 合同 subjectId-scoped ✓（knownSubjects 原样）；synthetic root=工程锚 ✓（v2/PR-0 语义不动）；pre-AI 路径只降级不删除 ✓。UI Design Compliance：YUK-601/602 动 UI 前 design doc 前置不变。

## 附：证据链

面板九席稿：session scratchpad `panel-all-seats.md`（3 席自 transcript 抢救）；面板终裁稿见会话记录 2026-07-10；owner proposal 原稿 `docs/design/2026-07-10-subject-control-plane.md`（保留为背景材料，其 §7/§8 机制按判词 B 与 §5.3 搁置表处置）。外部证据要点：Custom GPTs/Character.ai 可变 blob + restore 面板（journal 的品类先例）；LangSmith 指针式回滚 vs Humanloop 关停；LaunchDarkly/Unleash/K8s level-triggered 传播定律；ALEKS/Math Academy/RemNote 图-视图族谱（红线的理论背书 = 知识空间理论）。
