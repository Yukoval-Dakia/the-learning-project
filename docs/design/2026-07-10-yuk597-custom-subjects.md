# YUK-597 — 科目手填（自定义科目）+ SubjectProfile DB 化：implementation contract draft（v2）

2026-07-10 · v1 终稿（run `wf_eef6dfd1-94a`）经 owner 判词（**D1 = 臂 B 全案 · D2 = opaque `subj_<cuid2>`**，不再复议）后收到 **request changes**（4 阻断 + 8 合同缺口）；本 v2 为契约修订（run `wf_78170c3d-f74`：6 个 opus 验证/设计席逐条实读接地 + Fable 综合）。**状态：implementation contract —— owner 已批准（2026-07-10，PR #748）。实施单 YUK-598~602 对齐本稿；PR-0 = YUK-603 先行。**
**2026-07-10 稍后：本稿 §2 状态模型与相关写面已被 v3 取代**（`2026-07-10-yuk597-v3-trait-subjects.md`，owner 同日批准 v3.2 = 实施权威）；其余章节（goal 防线 / knownSubjects / 传播 / 启动失败矩阵 / backup 纪律等）按 v3 头部明示方式继续生效。

---

## 0. v2 相对 v1 的裁决级变更

| v1 条目 | v2 判决 | 依据 |
|---|---|---|
| 「`insertGoal` 单一写面幂等兜底」 | **废除**。创建面实为两条（goal-create.ts:131 / accept.ts:147 在 `projectionIsWriter('goal')` ON 时走 `projectGoal` 完全绕过 insertGoal）。防线改挂**两 writer 分岔之前的共享事务步骤**（§3.5） | 阻断④，实读证实 |
| 「worker 对 registry miss 做 lazy DB re-check」 | **废除**（三重不可行，§4.1）。改为：启动水合前置 serve/work + worker 60s 周期 refresh + app 写路径 in-process upsert | 阻断③，实读证实 |
| 「goal-create Body 加 optional `subjectDisplayName` passthrough」 | **废除**。goal 只能引用已存在科目；科目创建唯一入口 = thin-create API（§3.1）；root.name 只从服务端 registry 读 | 阻断④派生（不信 client 串） |
| 「种子迁移幂等 `ON CONFLICT DO NOTHING`」 | **替换**为 versioned `reconcileBuiltinProfiles`（§3.6）——裸 DO NOTHING 会把 builtin 冻结在首次入库版本 | 合同缺口（builtin 升级） |
| 「`GET /api/subjects/choices` choices-only 水合」 | **扩容**为 `GET /api/subjects`（selectable 视图：displayName + renderConfig + causeCategories `{id,label}`）+ TanStack Query provider——choices-only 修不了错因下拉串味与编译期 bundle 冻结 | 合同缺口（client staleness） |
| `subject_profile_alias(alias PK)` 从表 | **替换**为单一命名空间表 `subject_name_claim`（canonical 与 alias 同表同列占坑，PK 拦全部抢占，§2.2） | 合同缺口（alias 命名空间） |
| 扁平列 `is_active boolean` | **替换**为 `retired_at timestamptz null`（仓库软删惯例 schema.ts:117「archived_at is the ONLY time dimension」；无一处 is_active 先例） | B5 实读 |
| goal scope：subject 派生集冻结进 `scope_knowledge_ids` | **废除冻结**。新增 `scope_mode = 'explicit' | 'subject_live'`（§5）；且此为**既有 armed live bug**，独立于 custom subjects 先修 | 阻断① |
| bridge 词表 `known_subject_ids: string[]` | **替换**为 `knownSubjects: [{id, display_name, aliases?}]`，输出仍闭集校验 id（§6） | 阻断② |
| v1 §5「诚实缺口」= 实施期首验 | **升级**为实施前置项（§9）——alias/水合/类型/bridge 缺口是 prerequisites，不是 deferred | owner 指示 |

不变量（v1 保留，未被动摇）：opaque 不可变 id + displayName 解耦；DB = 运行时真相源、代码 4 profile = bootstrap 种子 + 断网兜底；写门 `validateProfile`（422 + issues）；建科目即建根；thin-create clone general + 「通用模式」badge；fan-out gate（nightly ≥5 KC）；custom 色板恒 neutral（**非 stale**——SUBJECT_TONE 是本地硬编码降级，MistakesPage.tsx:78-82 / QuestionsPage.tsx:102，不进水合面）。

## 1. 面板裁决（v1 §1，保留）

- **KILL-1**：未注册 custom id 在 `resolveSubjectKnowledgeIds`（domain.ts:105 `resolveKnownSubjectId(domain) === subject`，纯内存查表 miss→null）恒空 → 按科筛题空（questions-list.ts:99）、AI subjectId 合同空（query-questions.ts:65）、goal scope 派生空；仅 placement tier-3 全树兜底存活。「纯 domain 字符串零注册」结构性死。
- **F1/F3**：`seedKnowledge` 循环编译期常量，不能为运行时 id 建根 → seed root 即科目在知识树上的存在锚。
- **AMEND-1**：L1 scope_key slug/RAW 分歧 = cosmetic 死代码（live brief 走 triggers.ts:478 `loadSubjectBriefEvents`；affected_scopes JOIN 已弃用 active-subjects.ts:9-13）；opaque ASCII id 下分歧从根消失，仍统一三调用点 + 回归测试。

## 2. 状态模型

### 2.1 三集合（科目 id 的生命周期视图）

| 集合 | 语义 | 成员 | 消费面 |
|---|---|---|---|
| **resolvable-all** | 任何历史/当前 id 或 alias 永远解析得出 profile。**永不缺席**——旧数据、旧 event、旧 domain 串不悬垂 | general + 全部 builtin + 全部 custom（**含 retired**） | `resolve()` / `resolveKnownSubjectId()` / 渲染回退 / 错因回退 / AI profile 载入 |
| **active-selectable** | 当前可被「选中/建根/派生轴/进分类词表」的供给集 | builtin(未退休) + custom(未退休) — **排除 general**（结构性，`is_selectable=false`）与 retired（状态性，`retired_at != null`；两谓词独立不混） | choices chips / thin-create 唯一性 / nightly 提案（另叠 ≥5 KC gate）/ bridge 分类器闭集词表 |
| **BUILTIN_IDS** | 编译期字面常量，运行时零权威 | `['yuwen','math','physics']`（现 `KNOWN_SUBJECT_IDS` 更名，旧名 re-export 缓迁） | `KnownSubjectId` 类型 / 测试 fixture / 断网兜底 |

Registry API：`listIds(scope: 'resolvable' | 'selectable')`、`getSelectableSubjectIds()`、`getResolvableSubjectIds()`；entry 携带 `{isBuiltin, isSelectable, retiredAt}`。现状锚：`listIds()`（profile.ts:159-161）今天已含 general 而 `KNOWN_SUBJECT_IDS` 不含——两集合语义分叉已存在，本节只是给它 API 名字。**general 入表**（`is_selectable=false`），作 thin-create 克隆模板走 registry 解析（DB wins：owner 若改通用人格，后续 thin 科目继承）。

### 2.2 表 DDL（Drizzle 语义，PR3 落地）

```ts
subject_profile:
  id                        text PK            // subj_<cuid2>；builtin: general/yuwen/math/physics。不可变
  display_name              text notnull       // 人读串权威源；写时反向同步 definition.displayName（唯一有意例外，见下）
  display_name_norm         text notnull       // 应用层 normalizeSubjectKey(NFC) 预写列（不用 PG normalize()，免版本依赖）
  origin                    text enum('builtin','custom') notnull
  is_selectable             boolean notnull default true    // general → false（结构性排除）
  retired_at                timestamptz null                // 软退休；沿 archived_at 惯例，不用 is_active boolean
  persona_state             text enum('general_clone','customized') notnull default 'general_clone'
  user_modified             boolean notnull default false   // builtin 升级判定信号（§3.6）
  definition_schema_version integer notnull    // Zod 形状代际，对照 CURRENT_PROFILE_SCHEMA_VERSION 常量
  profile_version           text notnull       // 内容 semver = definition.version 投影
  revision                  integer notnull default 0       // CAS 专用，每写 +1（schema.ts:88 int-version 惯例）
  judge_capabilities        jsonb notnull default []        // 派生投影列（免解 jsonb），写时同步
  scheduling_policy         text notnull                    // 同上
  definition                jsonb $type<SubjectProfile> notnull  // 唯一真相载荷，写前 validateProfile 门
  created_at / updated_at   timestamptz notnull

// 幂等唯一性（§3.2）：
UNIQUE INDEX ON subject_profile (display_name_norm) WHERE origin='custom' AND retired_at IS NULL

// 单一命名空间（canonical 与 alias 同表同列，PK 拦截全部抢占；替代 v1 alias 从表）：
subject_name_claim:
  name_norm   text PK                          // normalizeSubjectKey 归一键 = 唯一命名空间
  subject_id  text notnull FK → subject_profile.id
  kind        text enum('canonical','alias') notnull
  // 部分唯一索引：每 subject 恰一 canonical 行
```

- **「唯一真相 vs 投影 vs 控制面」三分**（闭合 owner 缺口「definition 不是完整真相」）：`definition` = 真相载荷；`profile_version`/`judge_capabilities`/`scheduling_policy` = 写时同步投影；`origin`/`retired_at`/`is_selectable`/`persona_state`/`user_modified`/`definition_schema_version`/`revision` = 控制面（结构上不在 definition 内，不再谎称「派生投影」）。`display_name` 是唯一有意例外：**权威源**，写时反向同步 `definition.displayName`（owner 红线：rename 免迁移）。
- **种子 claims**：canonical 行 ×4（general/yuwen/math/physics）+ alias 行（yuwen←wenyan/classical_chinese/chinese_classics；math←mathematics/maths；physics←physical，profile.ts:71-82 现硬编码迁入）。custom 科目通常零 alias。
- **normalizeSubjectKey 补 NFC**：现 `trim().toLowerCase()`（profile.ts:38）缺 Unicode 归一；改 `normalize('NFC').trim().toLowerCase()`（CJK 恒等、无 locale 坑）。写门、DB 入库、内存 Map 键**必须共用同一函数**。
- **registry 内存侧静默覆盖 → 显式冲突**：`register()`/`upsert()` 两处 `.set` 前加 `.has` 预检（profile.ts:111,118 现无预检，alias 抢 `math` 会静默改写 builtin 自别名）；`upsert()` 用 `!== id` 谓词放行同 id 重装。DB PK 是第二层兜底；boot 水合遇脏行 `throwOnInvalid:false` 上报不炸进程。

### 2.3 版本三轴

| 轴 | 型 | 语义 | bump 时机 |
|---|---|---|---|
| `definition_schema_version` | int | definition 遵循的 Zod 形状代际 | 形状不兼容变更 → 改代码常量 `CURRENT_PROFILE_SCHEMA_VERSION` + 写 upgrade 函数；行入库时 stamp 当代 |
| `profile_version` | text semver | definition 内容代际（承接 `SubjectProfile.version`——它是 `z.string()`（profile-schema.ts:40），**不能**兼作 CAS） | builtin：改种子即 bump 种子 version；custom：thin-create='1.0.0' |
| `revision` | int | CAS 机器计数 | 任何写（admin/reconcile/reset/rename）无条件 +1 |

### 2.4 persona_state 与 reset-to-default

- `persona_state` 显式列（**否决**运行时与 general 深比：O(n) 且 general 种子一变全体假翻转）。单向闩：thin-create → `general_clone`；admin 改 displayName 以外任一 definition 字段 → `customized` + `user_modified=true`（判定：入参与库存各过 `SubjectProfileSchema.parse` 后剔 displayName 键规范化比较，吃掉 Zod default 填充假阳性）；只改 displayName 不翻。builtin 行恒 `customized`。唯一回路 = reset。
- **reset（builtin）**：definition/display_name/profile_version/schema_version/投影列全回**当前代码种子**（含 displayName），`user_modified=false`，`revision+1`，同事务 root.name 回种子名。
- **reset（custom）**：definition ← 重 clone 当前 general（registry 解析），**displayName 保留原值**（root.name 不动），`persona_state='general_clone'`，`user_modified=false`，`revision+1`。= 退回 thin-create 初态。
- **对外映射（写死）**：`isGeneralFallback ≡ (persona_state === 'general_clone')`。thin-create 201 响应**与** `GET /api/subjects`（§7）都下发该布尔——「通用模式」badge 的稳态数据路径是 provider，不靠 create 响应残留。

## 3. 事务与 API 合同

### 3.1 thin-create：`POST /api/admin/subjects`（科目创建唯一入口）

归属 observability capability（与 `GET /api/admin/subjects` 同域同前缀，RL5 写面红线）；onboarding 前端也调它。全站 `x-internal-token` 自动覆盖。

```jsonc
POST /api/admin/subjects   { "displayName": "化学" }        // 服务端 mint id，无其它字段旁路
→ 201 { "id": "subj_ab12…", "displayName": "化学", "isGeneralFallback": true,
        "revision": 0, "seedRootId": "seed:subj_ab12…:root" }
```

**单事务四步（任一缺失=半截科目，原子性是防「半个化学」的根本）**：
1. `INSERT subject_profile`（definition = clone general 过 `validateProfile`，displayName 覆盖；origin='custom'，persona_state='general_clone'，revision=0）。
2. `INSERT subject_name_claim`（canonical 行：`name_norm=normalizeSubjectKey(id)`）。
3. `ensureSubjectRoot(tx, id, displayName)`：INSERT knowledge `{ id: 'seed:<id>:root', name: displayName, domain: id, parent_id: null, approval_status:'approved' }` **ON CONFLICT (id) DO NOTHING** **＋ 真插入时同写该 root 的 genesis 事件 + `materialized_id_index` anchor**——knowledge 侧 `PROJECTION_IS_WRITER` 已 LIVE=1 且 `audit:projection` allowlist 为空（其成立前提 = 每 id fold==row），运行时新根若裸 INSERT 无 genesis anchor 会被判 drift。root 必须 event-sourced from birth。
4. commit。**commit 后（tx 外）**：`registry.upsert(profile)` in-process 热更——必须 post-commit，否则回滚留内存幻影。

**root id 方案钉死（跨席约束）**：`seed:<subjectId>:root` 对 builtin 与 custom 统一。§5.4 的源头排除按此 id-pattern 判；§3.4 rename 按此 id 定位（**不得**用 `domain+parent_id IS NULL`——learning_intent 3a 路径会建 `newId()` + parent_id:null 的运行时 topic root，撞判据）。

**422**：validateProfile fail → issues 列表回显（与 register()/audit:profile 逐字同函数）。alias/displayName 撞 `subject_name_claim` 或撞唯一索引 → 见 §3.2。

### 3.2 幂等（「网络重试不得产生第二个化学」）

语义级防线 = `display_name_norm` 部分唯一索引（`WHERE origin='custom' AND retired_at IS NULL`；builtin 不进此约束）。POST 命中已存在 live custom 行 → **200 + 既存科目全体（回放）**，非 422；INSERT 撞索引（并发窗口）→ 捕获 23505 → SELECT by norm → 200 回放。**永不产生第二行/第二根/第二 claim。** 索引只护 custom↔custom；**custom↔builtin 撞名由写门拒**（归一 displayName 命中任一 builtin displayName → 422）——否则 §6 分类词表会出现两个同 `display_name` 不同 id 的条目，判别近随机。client `Idempotency-Key` 表 = FULL 可选加层，不设为必需（owner 可决）。

### 3.3 编辑：`PUT /api/admin/subjects/:id` + CAS

```jsonc
PUT { "expectedRevision": 3, "definition": { …全字段… } }
```
tx 内：validateProfile（fail→422）→ `UPDATE … SET definition=…, revision=revision+1 WHERE id=:id AND revision=:expectedRevision`；rowCount=0 且行存在 → **409 `{currentRevision}`**，前端 refetch 重放。id 不可改（body 无 id）。commit 后 registry upsert。软退休 = `PUT retired_at`（行保留，resolvable 不掉线）；**无硬删面**（backup/restore 全保真）。

### 3.4 rename 联动（displayName 三写点同事务）

```
UPDATE subject_profile SET display_name=:new, definition=jsonb_set(definition,'{displayName}',:new),
       revision=revision+1 WHERE id=:id AND revision=:expected        -- CAS
UPDATE knowledge SET name=:new WHERE id='seed:<id>:root'              -- root.name 同步（id 定位）
```
**append-only 边界（显式声明）**：event/cost_ledger/tool_call_log 及一切历史 payload 里的 displayName 快照**不回写**——rename 是前向语义，历史保留 as-of 名字（evidence-first 审计不可变）。`subject_name_claim` 不因 rename 动（claim 是 id 级命名空间，与人读名解耦）。

### 3.5 goal 写路径防线（阻断④：两 writer 分岔前的共享步骤）

创建面穷举（实读）：恰两条，各自按 `projectionIsWriter('goal')`（default OFF，sot-flag.ts:57-79）二分岔——goal-create.ts tx 106-148（ON:`projectGoal`:131 / OFF:`insertGoal`:133）、accept.ts tx 115-165（ON::147 / OFF::149）。backfill-genesis-events 只写事件不 INSERT goal 行；update 路径（projectGoalGuarded）与建根无关。**防线必须挂在分岔之前，两处结构一致**：

1. **alias→canonical 归一（tx 外、scope 派生前）**：`const canonical = resolveKnownSubjectId(subjectId)`。**canonical 全程替换 raw**：scope_mode 分支判定、genesis snapshot.subject_id（goal-create.ts:95）、insertGoal.subject_id（:135）、201 响应体（:153）四个消费点全部改读 canonical，不留 raw 串。
   - goal-create：`canonical == null && subjectId != null` → **422 unknown subjectId**（现状是原样落库——goal-create.db.test.ts:106-113 编码了 `'no_such_subject'` verbatim 落库 + 空 scope，该测试随 v2 反转，承重回归点）。
   - accept：subject 来自 proposed_change（W10 inbox 用户可编辑）→ 归一 miss 时**回退 null（不 scope）+ warn log**，不整单 422（proposal 不因 subject 打字错报废）。
   - 顺带修**既有 alias-miss 潜伏 bug**：现在传 `'wenyan'` → subject_id='wenyan' 原样存 + scope 派生恒空（domain.ts:105 拿 canonical domain 比原始参数）。归一后 subject_id='yuwen'、scope 正确。
2. **`ensureSubjectRoot(tx, canonical, registry.get(canonical).displayName)`（tx 内、writer 分岔前；`canonical === null` 时跳过——无科目无根可保）**：root.name 只从服务端 registry 读，不碰任何 client 串。幂等（ON CONFLICT DO NOTHING）——thin-create 已建根时是 no-op；这里是安全网非创建面。
3. goal-parity 零成本：`assertGoalParity` 只 gather/fold goal 事件与 goal 行，不读 knowledge——同 tx 建根不进 fold，安全。

### 3.6 builtin 升级：`reconcileBuiltinProfiles`（替代裸 ON CONFLICT DO NOTHING）

**单写者 = migrate init container**（scripts/migrate.ts:39 seedKnowledge 旁跑一次；app/worker boot 只 read-hydrate，避免竞写）。每种子：无行→INSERT（builtin：persona_state='customized'，user_modified=false）+ ensureSubjectRoot；有行且 `profile_version`/`definition_schema_version` 落后 → `user_modified=false` 则整体覆盖升级（revision+1，root.name 随 displayName 同步），`user_modified=true` 则**保留用户版 + LIGHT 通道 warn log**（`needs_review` 列 = FULL，defer 到 PR6 admin badge 落地时再裁——提前建列无 consumer）。判定信号用 `user_modified` 而非 `revision==0`（reconcile 自身写行会污染 revision 信号）。

### 3.7 backup/restore 纳编（PR3 内，非 deferred）

`archive.ts:150` 在 module load 断言每张 pgTable ∈ FK_ORDER ∪ BACKUP_EXCLUDED——**漏登记 = 进程起不来**，不是静默丢数据。改点：FK_ORDER 末尾追加 `'subject_profile'`, `'subject_name_claim'`（父在子前，constants.ts:206 后）；`SCHEMA_VERSION '4.13'→'4.14'`（constants.ts:73）；constants.test.ts:34/78/80 断言随动（36→38 表）；`_round_trip.db.test.ts` 新增 subject_profile 行（definition jsonb + 三轴列）dump→wipe→restore deep-equal 断言。COLUMN_ALLOWLIST 自动派生零手工；jsonb 走 `restoreValue` 通用路径。**restore × reconcile 时序**：restore 反向 wipe 掉 migrate 刚 seed 的 builtin 行 → 正向灌归档（含 custom + owner 编辑）→ 下次 migrate reconcile 对 `user_modified=false` 的 builtin 自动追新种子、custom 原样保留。

## 4. 启动序列与失败矩阵（阻断③）

### 4.1 lazy-on-miss 正式否决（三重不可行，实读）

(1) resolver 全同步 Map 读（profile.ts:64-65,123-153），同步表面 ≈40-45 调用点，含**浏览器 React render 路径**（ui/lib/subject.ts:32,172、cause-options.ts:21）——结构上不能 async 且够不到 DB；(2) 枚举型调用根本不产生 miss（nightly `for candidate of KNOWN_SUBJECT_IDS`、bridge 三处把整词表当参数传，custom 不在 list = 静默永不被选，无信号可挂）；(3) miss 是载重合法结果（`resolveKnownSubjectId`→null 是 YUK-288 over-match guard），无法与「尚未水合」区分。

### 4.2 启动序列（never-empty 是结构保证：四代码种子在 import 期构造函数注册，与 DB 无关；hydrate 只叠加永不清空）

- **app（server/index.ts）**：现状 serve() 前无 await 缝（:29 buildHonoApp 同步 → :41 serve）。改为 async IIFE 内 `await hydrateSubjectRegistryFromDb(db)`（**never-throws**：表缺失 42P01/DB 不可达 → WARN + return，四种子兜底）→ 再 serve。**esbuild CJS 禁 top-level await**（三入口全 `--format=cjs`），只能 IIFE/async main，现有形态已兼容。监听推迟 ≈ 一次全表 SELECT（数十行/数十 ms），`/api/health` 随迟可接受。
- **worker（scripts/worker.ts / start-worker.ts）**：hydrate 放 `startBossWorker` 首行（boss.start/registerCapabilityJobs 之前 = 第一个 job 落地前）；`registerCapabilityJobs` 后启 `startSubjectRefresh(db, 60_000)`（`setInterval` + `unref()` + shutdown `clearInterval`，返回 stopRefresh 接进 installShutdownHandler）。
- **水合内容**：加载**全部行（含 retired）**入 registry（resolvable-all 语义），entry 带 `{retiredAt, isSelectable}`；JOIN `subject_name_claim` kind='alias' 挂别名；per-row `safeParse` + `upsert(throwOnInvalid:false)`，坏行 skip+WARN；`reconcileCustomIds(seen)` 只摘「本轮成功读到的 DB id 集」之外的 custom（builtin 四种子是地板永不摘；读失败走 catch 分支根本不调 reconcile，不会误摘）——注意其唯一真实触发是 **restore 使 DB 行集收缩**（§3.3 无硬删面、退休行照水合），定位为防御网而非通电件。hydrate 模块放 `src/server/subjects/hydrate.ts`（红线：profile.ts 被浏览器 import，不得引 db/client）。

### 4.3 可见性 SLA（写死；取消 v1「编辑需重启 worker」）

**新建/编辑/退休科目：app 侧即时（in-process post-commit upsert）；worker 侧 ≤60s（下轮 refresh 全表 re-upsert，DB wins for same id）。任一进程均无需重启。** LISTEN/NOTIFY 否决：worker 今天零 listen（`startListenLoop` 无生产调用点，scripts/worker.ts:6 注释是 stale），新增常驻 PG 连接换「即时性」在单用户低频下无真需求（建成不通电）。

### 4.4 失败矩阵

| 场景 | 行为 | 阻断启动? | never-empty |
|---|---|---|---|
| migration 未跑（表缺失 42P01；prod 有 compose `depends_on: migrate` 保证，仅 dev 裸跑出现） | SELECT throw → catch → WARN `hydrate skipped — keeping code seeds`，boot 继续；custom 缺席至迁移跑 | 否 | 四种子在内存 |
| DB boot 不可达 | 同上（worker 真 DB-down 由 boss.start() 自行 throw→exit(1)→compose 重启，与 hydrate 无关） | hydrate 否 / boss.start 是（既有机制） | 四种子 |
| 单行 definition 校验失败 | per-row skip + WARN + issues；builtin 保代码种子版，custom 本轮缺席 | 否 | 坏行隔离 |
| refresh 运行期失败 | WARN，保留 last-good 快照，60s 后重试；catch 分支不调 reconcile 不误摘 | 否 | 快照原封 |
| 两进程窗口（app 即时 / worker ≤60s） | 窗口内 worker 对该 custom：resolve→general 回退、resolveKnownSubjectId→null → 优雅降级非崩溃，下轮自愈；实务近零（nightly 有 ≥5 KC gate，新科目长出 KC 前不进烧 LLM 路径） | 否 | 双侧非空 |

## 5. goal scope 模型：`scope_mode`（阻断①）

### 5.1 ⚠️ 既有 armed live bug（独立于 custom subjects，先行修复）

实读闭环：`resolveSubjectKnowledgeIds` 把 seed root 自身计入返回（domain.ts:63-108 无 root 排除；root 的 domain=subjectId 自匹配）→ day-one 派生 = `['seed:yuwen:root']` **非空** → goal-create.ts:83-85 冻结进 `goal.scope_knowledge_ids`（其 docblock :16-21「resolved scope is legitimately empty/thin」是**假的**）→ placement tier-1（placement-scope.ts:25,28）非空 frozen 直接返回**永不 live-resolve**，后续上传的子 KC 永不进 scope；`selectNextPlacementItem` 按 `@> [root]` 查题恒 0 行 → `sourcingNeeded=true` 永久。另 4 个 goal-strand 读者（coach_daily.ts:189-195 / dreaming_nightly.ts:202-208 / due-list.ts:585-596 / learner-state.ts:296-302，全经 listActiveGoals 直读 frozen 列**无任何 live tier**）被 `[root]` 污染空转。**severity**：`PLACEMENT_PROBE_ENABLED` 已于 2026-07-06 翻 ON 注入生产（PLAN.md 07-09 核验）；day-zero census goal=0 → 弹已上膛、路径全通、尚无中弹行——owner 一做 onboarding 建 goal 即触发。**独立 Linear bug 单先行**（诊断查询 + 修复可先于 YUK-597 其余实施落地）。

### 5.2 语义与 DDL（FULL 列，荐；owner 已点名 scope_mode）

- `explicit`：frozen `scope_knowledge_ids` 是权威窄范围（手选 KC / proposal 策选集），读者用 frozen。
- `subject_live`：scope 从 `subject_id` **每次读时派生**；frozen 保持 `[]` 读者忽略。不变式：subject_live 永不把派生 KC 写进 frozen（即使派生集含 root 也不冻结——这一条独立于 root 排除就已根治 tier-1 钉死）。

```ts
// goal 表（schema.ts:1373-1402）加列；default 'explicit' = 裸加列对既有非科目 goal 零行为变化
scope_mode: text('scope_mode', { enum: ['explicit', 'subject_live'] }).notNull().default('explicit')
```

LIGHT 备选（无列，frozen 空 + 有 subject_id 启发式）被弃：intent 不持久——explicit 窄 goal 的 KC 被归档/merge 掏空后会被误判为整科（静默扩权）。

### 5.3 写路 / 读路 / migration

- **写路 3 条**：goal-create——explicit knowledgeIds → `explicit`+冻结；subjectId 无 explicit → `subject_live`+`scope_knowledge_ids=[]`（**删除 :84-85 的 resolve+freeze**）；皆无 → `explicit`+[]。accept——恒 `explicit`（proposal 是 evidence-first 策选窄集，用户 inbox 确认过；「整科 proposal goal 自动增长」另议，标记 owner 判断点）。projection 连线（**flag OFF 也必须**，genesis snapshot 是 `.strict()` 且 OFF 路跑 assertGoalParity）：GoalRowSnapshot（genesis.ts:112-126）+ goalLiveRowToSnapshot（parity.ts:465-489）+ goal fold reducer 三分支（`src/core/projections/goal.ts:152` genesis / `:187` propose / `:243` update）+ write-through（server/projections/goal.ts:77,91）+ insertGoal 输入，穷举加 `scope_mode`。**关键裁量：`scope_mode` 在 `GoalRowSnapshot` 定为 optional + fold 默认 `'explicit'`**——snapshot 是 `.strict()` 全必填（genesis.ts:112-125），若加必填字段，历史 genesis payload 无此键会在 `GoalRowSnapshot.safeParse`（core/projections/goal.ts:152）全体拒折，flag 翻 ON 或任何 re-fold 即炸；optional+默认镜像 DB 列默认，历史事件照折。
- **读路**：placement 单点改 tier-1 gate——`if (scopeMode==='explicit' && frozen.length>0) return frozen`，subject_live 直落 tier-2 live-resolve（两 caller placement-start.ts / placement-profile.ts 的 SELECT 加 scope_mode 列）。goal-strand 4 读者切 `listActiveGoalsWithResolvedScope(db)`（explicit→frozen；subject_live→`resolveSubjectKnowledgeIds` 按 distinct subject Map 去重一次；不建缓存子系统）。merge 重写/forensic 计数（proposals.ts:541 / merge-attribution-backfill.ts:187）零改动——subject_live frozen=[] 匹配 0 行即正确。propose-nightly gate2（跳过已有活跃 goal 的科目）只用 subject_id，不改；nightly **候选源**另改，见 §6。
- **存量 migration（SQL 可表达，判据收紧防误伤）**：`source='goal_scope_proposal'` → explicit 保 scope；`source='manual' AND subject_id IS NOT NULL` **且 frozen 为空或恰为单元素 `seed:%:root`**（`jsonb_array_length=0 OR (jsonb_array_length=1 AND ->>0 LIKE 'seed:%:root')`）→ **subject_live + frozen 清 `[]`**（WelcomePage 是唯一 live manual 路径且从不发 knowledgeIds——createGoal 单 caller WelcomePage.tsx:69 已核；但 Body 结构上仍收 knowledgeIds+subjectId 并发，收紧判据防「手选集被误清」，此类行保守留 explicit）；`manual AND subject_id IS NULL` → explicit 保 scope；其余 legacy 由列默认兜底。

### 5.4 synthetic root 源头排除（「科目的 KC 集」= 内容子 KC，不含结构锚）

排除点裁在**源头** `resolveSubjectKnowledgeIds`（全部存活 caller 要么受益要么中性：placement tier-2、placement-select leaning、questions-list、query-questions；goal-create caller 随 §5.3 删除）。判据 = **id-pattern**：`row.id === 'seed:<canonical>:root'`——**不用** `parent_id IS NULL` 粗规则（3a topic root 是 `newId()` + parent_id:null，会误伤）；顺带把 :105 的比较修为 canonical 归一（现拿已解析 domain 比原始参数，caller 传 alias 会全体 miss）。前置约束：ensureSubjectRoot 复用 `seed:<id>:root`（§3.1 已钉死）。若未来 root id 方案破裂 → 回退 FULL（`is_synthetic_root` 列）。**≥5 KC gate 口径**随之自动纯内容计数。行为对照：day-one `resolveSubjectKnowledgeIds('yuwen')` = `[]`（曾 `[root]`）；≥5 gate 对 root+4 子计 4 不过阈（曾误计 5）。

## 6. AI 分类合同：`knownSubjects`（阻断②）

现状实读：bridge 输入 `known_subject_ids: z.array(z.string())`（core/schema/cold-start-bridge.ts:40）经 runner `JSON.stringify(input)` 逐字进 user message；prompt（registry.ts:741）全程只有裸 id；输出闭集校验在 invoker `.includes()`（cold-start-bridge.ts:125-129，非 Zod enum——运行时动态集，enum 不可用，**校验机制保留**只换 `.some(s=>s.id===…)`）。现状分类质量部分依赖 id 可读（yuwen/math/physics 是强语义 token）；opaque `subj_<cuid2>` 互相零语义差 → 判别近随机，owner 因果链成立。

**合同**：`known_subjects: [{ id, display_name, aliases? }]`（FULL 带 optional aliases，present 才序列化；<100 token，builtin legacy 域别名是真实召回增益）。prompt 改法：display_name（及 aliases）是分类依据，id 是 opaque stable key **原样回传**，禁自造、禁把 display_name 填进 subject_id。**取数点红线**：新增 `getKnownSubjects()` 读**活 registry**（getSelectableSubjectIds() × registry.get + listAliasesFor 新 accessor——现 aliases 是私有 Map 无枚举 getter），**不读**编译期冻结快照 `subjectProfiles`（profile.ts:170，import 期 Object.fromEntries，水合后不更新——PR1 stale-const 审计的同类根）。

改点穷举：真分类两处 image-candidate-accept.ts:647 / auto-enroll.ts:502 → `getKnownSubjects()`；**类型签名连锁改（非被动随动）**：`NameKcFn.knownSubjectIds`（tag-knowledge.ts:66-71，现 `readonly string[]`）、`RunColdStartBridgeParams.knownSubjectIds`（cold-start-bridge.ts:47）、`ColdStartBridgeInput.known_subject_ids`（core/schema/cold-start-bridge.ts:40）全部 `string[]` → `{id, display_name, aliases?}[]`，默认回退 tag-knowledge.ts:173 `KNOWN_SUBJECT_IDS` → `getKnownSubjects()`，单科 PIN（:265,:384-393）传 `[{id, displayName}]`，闭集校验 `.includes()` → `.some(s => s.id === …)`（:125-129）；prompt 一件；可选清理 `server/boss/handlers/sourcing.ts:350` `subject: subjectProfile.id` → displayName（单科 context 冗余，低危）。

**nightly（goal_scope_propose_nightly.ts）两分述**：分类器合同**不改**——它是确定性挑选非分类，prompt 已注入 `profile.displayName`（task-prompts.ts:132）；但**候选源必换**：`:113` `for (const candidate of KNOWN_SUBJECT_IDS)` 现只迭代 3 builtin，custom 永不进候选 → 改 `getSelectableSubjectIds()`（custom 纳入；worker 侧可见性 ≤60s，§4.3），叠 ≥5 KC gate = `resolveSubjectKnowledgeIds(candidate).length >= 5`（§5.4 源头排根后自动纯内容计数）。前置验证：`countWeakNodesInDomain` 对 opaque `subj_<cuid2>` domain 串的分桶正确性（§9⑪）。

失配 fallback 不变：out-of-vocabulary → ColdStartBridgeError → un-attributed draft / review 路由；**general 永不入 known_subjects**（恒非 node domain 红线）。worker 侧词表新鲜度由 §4 refresh 承接（≤60s），非 per-id lazy 机制。

## 7. client 水合（合同缺口：编译期 bundle 冻结）

实读：4 个 builtin profile 全血内联进 SPA bundle（web/dist assets 已证）；12 个消费点经 ui/lib/subject.ts + cause-options.ts 两转发文件。custom 科目不水合的三条故障：不进 chips（listSubjectChoices 只迭代编译期常量）、displayName 渲染成裸 `subj_xxx`、错因下拉串味成 general 的 causeCategories。

**端点**：新建 `GET /api/subjects`（selectable 视图），**不复用** `/api/admin/subjects`（R11 slim 面故意不下发 causeCategories，混用破红线）。返回逐字段裁：`{id, displayName, renderConfig{font_family,notation,code_highlight}, causeCategories:[{id,label}], isGeneralFallback}`（`isGeneralFallback = persona_state==='general_clone'`，§2.4 映射——「通用模式」badge（PR6）的稳态数据源在此，不靠 thin-create 响应）；**明确不下发** promptFragments/noteTemplate/grounding/judgePolicy/sourceWhitelist（server-only AI 合同字段）。**Provider**：`useSubjects()` = TanStack Query（staleTime 5min；**不轮询**——建/编科目 mutation onSuccess → `invalidateQueries(['subjects'])`；`initialData` = 编译期 builtin 投影 → 首帧不闪、断网/500 退化到三 builtin 与今日逐位一致）。改造：WelcomePage.tsx:23-24 **模块级冻结** const 移进组件体（hook）；QuestionsPage/MistakesPage 换 hook；cause-options 改吃 rows 参数；renderConfig 加载态回退编译期 builtin。general 不进 provider（渲染回退用本地 DEFAULT_SLIM_SUBJECT_PROFILE）。顺带收敛：builtin promptFragments 可从 SPA 树摇掉，bundle 反而变小。`SlimSubjectProfile` 在 ui/lib/subject.ts:36-44 有手抄重复定义——wire 类型与 profile-schema.ts:94 对齐收敛为一处（第三处漂移预防）。

## 8. 四阻断 E2E 验收（做 X 观察 Y；每条是对应实施 PR 的红线测试）

**阻断①（scope_mode）**
1. 空 DB 仅 seed roots → `POST /api/goals {title, subjectId:'yuwen'}` → 落库 `scope_knowledge_ids=[]` 且 `scope_mode='subject_live'`（非 `['seed:yuwen:root']`）。插子 KC k1 → `resolveGoalPlacementScope` = `[k1]`（live 且不含 root）。
2. explicit 窄 goal `{knowledgeIds:['a','b']}` → `explicit`+frozen `['a','b']`；再插新 KC → placement 仍 `['a','b']`（tier-1 尊重，不被拓宽）。
3. 源头排除：day-one `resolveSubjectKnowledgeIds('yuwen')`=`[]`；插 k1 → `['k1']`；3a 路径建 `newId()` topic root + 子 k2 → 结果含 k2 **且含该 topic root**（未被误排），仅 seed root 被排。
4. migration：种 `manual+subject+scope=['seed:yuwen:root']` 行 → 跑迁移 → `subject_live`+`[]`；proposal 行/无 subject manual 行 → `explicit` 保 scope。
5. goal-strand live：subject_live goal + 新 KC → coach/dreaming/due-list/learner-state 读到的 scope 含新 KC；parity：flag ON/OFF 两态建 goal，assertGoalParity 不炸（scope_mode 连线完整）。

**阻断②（knownSubjects）**
6. 建 custom「化学」→ 上传化学题图（分类跑在 worker——测试先等下轮 refresh 或显式触发 re-hydrate，尊重 §4.3 ≤60s SLA 防 flaky）→ bridge 输入序列化含 `"display_name":"化学"`；返回 `subject_id` = 该化学 opaque id（非最近 builtin）；tagKnowledge 在 `seed:subj_…:root` 下挂化学 KC。反证：同题 opaque-only 旧合同重跑 → 分类落 builtin 或 misfit（量化 displayName 增益）。
7. stub 返回 `subject_id:'subj_notinlist'` → ColdStartBridgeError（闭集校验存活）；喂旧字段 `known_subject_ids` → ZodError（无静默双跑）。

**阻断③（启动/失败矩阵）**
8. 启动日志顺序：`subject registry hydrated: +N` 先于 `listening`；drop 表重启 → WARN + 四 builtin 照常服务（never-empty）；坏 definition 行 → skip WARN + 合法 custom 照载。
9. worker 不重启：app POST 新科目 → ≤60s 后 worker job 解析到该 profile（非 general 回退）；编辑 displayName → app 即时、worker ≤60s（v1「编辑需重启」取消的实证）；SIGTERM → stopRefresh 清定时器干净退出；`pnpm build` 过（无 top-level await 混入 CJS）。

**阻断④（写面/事务）**
10. thin-create 原子性：201 后 DB 四件套全在（profile 行 + canonical claim + `seed:<id>:root` + root genesis 事件/anchor）；人为中断第 3 步 → 全无残留。连发两次「化学」→ 同 id、恰 1 行 1 根，第二发 200 回放。
11. CAS：revision=3 两写并发 → 先者成功（→4），后者 409 `{currentRevision:4}`，未覆盖。
12. goal 归一：`{subjectId:'wenyan'}` → `goal.subject_id='yuwen'` + scope 非空（alias-miss bug 修复实证）；`{subjectId:'no_such_subject'}` → 422 无落库（goal-create.db.test.ts:106-113 随之反转）；两 flag 态（PROJECTION_IS_WRITER_GOAL=0/1）删根后建 goal → root 都被补回。
13. 伪造 `subjectDisplayName:'黑客名'` 字段 → root.name = registry 真名（goal 路径不读该字段——passthrough 已由构造消失）。
14. 命名空间：custom 声明 `aliases:['math']` → 422 `already claimed`，claim 表无新行；内存 register 同串 → 显式 throw，原映射未被覆盖。
15. backup：seed 1 custom + 1 编辑过 builtin → dump→wipe→restore → definition/revision/persona_state/user_modified 全保真；FK_ORDER 漏登记 → module load 即 throw（反证 gate 活着）。
16. 升级：bump math 种子 version → migrate → `user_modified=false` 行被覆盖追新 + root.name 同步；先 admin 编辑再 bump → 保留用户版 + warn log。

## 9. 实施前置项（prerequisites——进对应 PR 的首验清单，不是 deferred）

① `subjectProfiles`/`defaultSubjectProfile` 模块常量 stale 消费点 grep 穷举 + 改函数调用（profile.ts:170,174；PR1 第一验证项）；② `upsert()` 具体实现与 `.has` 冲突守卫交互（重装同 id 改 alias 的 claim 清理顺序）；③ `KnownSubjectId`→string 放宽 tsc 全量跑；④ thin-create clone general 逐字段 validateProfile 通过性；⑤ root 直标题存量查询（`question.knowledge_ids @> ['seed:%:root']` 预期 0，PR 前 SQL 证实）；⑥ persona 翻转 diff 对 optional 字段（sourcingRoutePreference 等）的 parse 规范化稳定性；⑦ `SubjectProfileSchema.parse` 后 definition 与 general 种子的 deep-clone 独立性；⑧ 全仓 grep 硬编码 `'4.13'`/`36` 残留；⑨ goal-strand live-resolve 在 due-list per-request 路径的实测成本（n=1 判可接受，未 benchmark）；⑩ accept 路径 proposal.subject_id 的 canonical 纯度实测（nightly 写 proposal 时的 id 形态）；⑪ `countWeakNodesInDomain` 对 opaque `subj_<cuid2>` domain 串的分桶正确性（§6 nightly 候选源换 selectable 的前置）。

## 10. PR 切分 v2（依赖序；判词后 YUK-598~602 描述对齐本表）

| PR | 内容 | 对应子单 |
|---|---|---|
| PR-0 | **scope_mode 修复（armed live bug，先行独立）**：goal 加列 + 写路停冻结 + placement tier-1 gate + goal-strand 4 读者 + 存量 migration + root 源头排除 + projection/parity/genesis 连线 | YUK-603（+ YUK-600 引用） |
| PR1 | 三集合 registry API（BUILTIN 更名 + selectable/resolvable）+ `GET /api/subjects` + provider + 12 客户端消费点 hook 化 + 模块级冻结修复 + stale-const 修复 | YUK-598 |
| PR2 | scope_key L1 三调用点统一（RAW）+ 回归测试 | YUK-598 |
| PR3 | `subject_profile` + `subject_name_claim` + migration + `reconcileBuiltinProfiles` + boot 水合（app serve-gate + worker）+ 60s refresh + `upsert()`/冲突守卫 + NFC 归一 + **backup FK_ORDER/SCHEMA_VERSION/round-trip** | YUK-599 |
| PR4 | thin-create API（单事务四步 + 幂等索引）+ goal 写路径防线（归一 422 + ensureSubjectRoot genesis-at-birth）+ passthrough 删除 + knownSubjects 分类合同 + nightly 候选源换 selectable + ≥5 gate | YUK-600 |
| PR5 | admin PUT/CAS + rename 联动 + reset-to-default + retire + 编辑器 UI + 校验 badge（前置 UI design doc） | YUK-601 |
| PR6 | onboarding thin-create UI + 通用模式 badge（前置新 UI design doc + owner 批准） | YUK-602 |
| PR7 | audit:profile `--db` + 夜间 cron `--strict` + needs_review FULL 裁定 + revision 历史（可选层） | YUK-601 |

## 11. 裁决合规自查（2026-06-07/08 红线）

全局一图 ✓ · 科目=effective_domain 派生视角 ✓（scope_mode=subject_live 正是把「派生」做成读时真派生而非写时快照，比 v1 更贴裁决）· 实体无 subject 列 ✓ · 跨科=mesh 边 ✓ · AI 合同 subjectId-scoped ✓ · synthetic root=工程便利 ✓（源头排除让它彻底退出内容语义，只剩结构锚）。Pre-AI 确定性路径只降级不删除 ✓（placement 三层兜底、explicit goal、手选 KC 全保留）。

## 附：材料

v2 六席稿（B1 scope-freeze / B2 classifier / B3 startup / B4 write-surface / B5 sets-alias-client / B6 versioning-backup）在 session scratchpad `yuk597v2-B*.md`，要点已全量收编本稿；v1 面板六稿 + draft 见 Linear YUK-597 评论。owner review 原文（4 阻断 + 8 缺口）见 Linear YUK-597 2026-07-10 评论串。
