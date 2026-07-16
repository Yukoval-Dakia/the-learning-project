> **归档说明(2026-07-16 驾驶舱 re-grounding)**:本稿为 owner 2026-07-10「Subject Control Plane」proposal(v2)原文,从未入库,唯一副本压在 `git stash@{0}`(未跟踪文件),本次抢救归档,原文保真(下方正文未动)。该 proposal 已经 9 席对抗面板(`wf_2c38ce81-8c2`)审理,判词=「方向正确、不按原样实施、分层采纳」,产物 = v3 trait 合同(`docs/design/2026-07-10-yuk597-v3-trait-subjects.md`,owner 批准 v3.2 = 实施权威,YUK-597 批已于 07-11 全交付上线)。本稿仅作历史决策输入留档,不再是待批设计。

# Subject Control Plane：用户自治科目、版本化资产与全链 Hot Reload

2026-07-10 · proposal v2

> 状态：**待 owner 审批的替代/扩展设计**。本稿在获批前不取代
> `docs/design/2026-07-10-yuk597-custom-subjects.md`；YUK-603 的
> `scope_mode` 修复独立成立、继续先行。本稿收编 2026-07-10 围绕「现有学科设计是否合理」
> 「自定义科目能否与内置科目平权」「Skill 是否 DB 化」「任意科目 CRUD + 全部 hot reload」
> 的讨论结论。

---

## 0. 一页裁决

### 0.1 目标定义

项目里的「科目」升级为一个**用户可自治、版本化发布、运行时热加载的控制面聚合**：

- 用户可以创建、改名、配置、发布、退休、恢复任意科目；
- builtin 与 custom 只保留来源差异，运行时地位一致；
- Profile 与 Subject Assets 都有 draft → validate → publish → rollback 生命周期；
- 发布提交后，app / worker / browser 自动加载新 revision，无需重启或重新部署；
- 已开始的请求/job 固定使用启动时捕获的不可变快照，新请求使用新 revision；
- 默认「删除」是可恢复退休；永久清除是带影响报告的高级维护流；
- 用户可配置系统已注册的能力，但不能通过科目配置注入可执行代码。

### 0.2 核心判断

当前 YUK-597 v2 解决的是「SubjectProfile DB 化 + 自定义科目注册」，方向正确，但不足以满足
本稿目标，原因有三：

1. 单行 `PUT` 原地覆盖没有 draft/publish/历史 revision，不能给高影响配置一个稳定发布边界；
2. app 即时 + worker ≤60 秒轮询只是最终一致，不是完整 hot reload 控制面；
3. SKILL.md、rubric、题源目录与课程材料尚未进入统一资产控制面；其中 Skill 仍是部署期磁盘
   资产，runner 首次使用后 memoize 单一配置目录，不能热换版本。

因此保留 YUK-597 的身份、知识图、三集合、事务写门与失败降级设计；重写版本模型、热更新传播与
Subject Assets 层。

### 0.3 决策表

| 编号 | 决策 |
|---|---|
| D1 | DB 是科目身份、生命周期、active revision 与资产绑定的运行时真相源 |
| D2 | 配置编辑不直接影响运行时；只有 publish 原子切换 active revision 并触发 hot reload |
| D3 | builtin/custom 运行时平权；`origin` 只服务 bootstrap、reconcile、审计与 UI 来源说明 |
| D4 | 普通删除 = retire；高级 purge 必须先出影响报告，默认保留最小 tombstone |
| D5 | Subject Asset Registry、版本与发布状态 DB 化；bundle bytes 由 bundled filesystem 或 R2/S3 provider 保存 |
| D6 | Profile、Subject Assets、render、taxonomy、prompt、policy 可 hot reload；新 judge/scheduler/tool 代码不可 |
| D7 | 每次请求/job 捕获不可变 `SubjectRuntimeSnapshot`；运行中不换挡 |
| D8 | PG NOTIFY 提供低延迟提醒，outbox/DB revision 提供可恢复真相，周期 reconcile 防漏 |
| D9 | 全局仍是一张知识图；科目仍是 effective-domain 派生视角，subject root 只是结构投影 |
| D10 | general 可编辑，但系统任意时刻必须恰有一个 default fallback；换 fallback 与停用当前 fallback 同事务 |

---

## 1. 范围与非目标

### 1.1 In scope

- 任意科目创建、改名、配置、发布、回滚、退休、恢复；
- builtin 科目同样可被用户修改、退休和重置；
- SubjectProfile 全字段版本化；
- Subject Assets 版本化：MethodPack、RubricPack、SourceCatalog、CurriculumPack；
- app、worker、browser 全链 hot reload；
- alias/canonical claim、唯一命名空间；
- seed root、知识图、Goal、AI 分类、nightly 与 active subject catalog 联动；
- backup/restore、审计、可观测性；
- 安全发布、CAS、防半配置、失败保留 last-good；
- 高级 purge 的影响报告与执行语义。

### 1.2 Out of scope

- 用户上传或热加载 JS/Python/shell/native executable；
- 用户通过配置创建新的 judge/scheduler/tool/capability 实现；
- 一科一库、一科一图或给所有业务实体增加 `subject_id`；
- 编辑器每次击键即时影响生产；
- 删除或弱化现有确定性练习、复习、题库与 placement 路径；
- 第一版提供多人权限/RBAC；系统仍是 single-user internal-token 模型；
- 第一版把 fixtures/goldens 变成产品运行时资产。

---

## 2. 当前状态（2026-07-10 code-ground）

### 2.1 Profile：代码是真相

当前四份 Profile：

- `src/subjects/general/profile.ts`
- `src/subjects/yuwen/profile.ts`
- `src/subjects/math/profile.ts`
- `src/subjects/physics/profile.ts`

`src/subjects/profile.ts` 在模块初始化时显式注册四份 profile 与 aliases；
`KNOWN_SUBJECT_IDS = ['yuwen','math','physics']` 仍是多处运行时枚举源。
`subjectProfiles` / `defaultSubjectProfile` 是 import-time 冻结快照，前端也直接 import，
所以完整 profile 会进入 SPA bundle。当前 DB 没有 `subject_profile` /
`subject_name_claim` 表。

科目 accent/tone 仍由 Mistakes/Questions 页面各自维护 `SUBJECT_TONE` map，未知 id
恒退 neutral；它不属于 Profile/registry，所以当前自定义科目即使能注册，也无法热配置视觉 tone。

`scripts/compile-profile.ts --write` 只能把 draft 写成
`src/subjects/<id>/profile.ts`；新文件还需手工注册、重建和部署才生效。
`/api/admin/subjects` 与 `/admin/subjects` 当前均为只读。

### 2.2 Skill：磁盘是真相

当前有 8 个方法论包：

- shared：`copilot`、`quiz-gen`；
- Note：`note-yuwen`、`note-math`、`note-physics`；
- Quiz：`quiz-gen-translation`、`quiz-gen-reading-comprehension`、
  `quiz-gen-calculation`。

当前链路：

```text
src/subjects/<id>/skills/*
  → runner 扫描磁盘
  → 扁平复制到单一 CLAUDE_CONFIG_DIR/skills/*
  → handler 传 ctx.skills 白名单
```

缺包时 never-throws，退回 Profile `promptFragments`。

已确认两个结构问题：

1. Dockerfile 只 COPY yuwen/math/physics skills，没有 COPY
   `src/subjects/_shared/skills`；本地能加载 shared 包，生产镜像会降级；
2. runner 将所有包扁平放入全局 skill namespace。Note 名称带 subject 后缀，但
   `quiz-gen-calculation` 等不带 subject；两个学科拥有同题型包时会撞名覆盖。

此外 `getIsolatedClaudeConfigDir()` 是进程级 memoized singleton，只在首次创建时
`populateIsolatedSkills`，所以当前结构不能热更新 Skill。

### 2.3 curriculum / fixtures / runtime content

- 正式 migrate 只给 yuwen/math/physics 各建一个 `seed:<subjectId>:root`；
- `src/subjects/yuwen/curriculum.json` 有 7 个 seed，但已退出正式生产 seed 链，
  主要服务 fixture 一致性；
- yuwen/math/physics fixtures 与 `scripts/judge-golden/*` 是开发/审计资产；
- 真正动态生长的 KC、题目、Note、材料、event、mastery、FSRS、Goal 在 Postgres/R2；
- 内容通过 knowledge `effective_domain` 找到静态 SubjectProfile。

因此今天不是一个统一资产仓，而是：

```text
运行策略：TypeScript Profile
专业方法论：磁盘 SKILL.md
学习内容：Postgres + R2
验证资产：repo fixtures / goldens
可执行能力：TypeScript capability registry
```

---

## 3. 长期领域模型

### 3.1 科目不是 plugin，也不是数据孤岛

科目定义为：

> 一个拥有稳定身份、版本化学习策略、版本化呈现方式、类型化资产和知识图入口的运行时学习域。

不改变既有红线：

- 全局只有一张知识图；
- 科目由 effective domain 派生；
- 跨科关系走 mesh edge；
- question/note/artifact 等实体不新增强制 subject 列；
- subject root 是工程结构锚，不是内容 KC；
- Profile 声明需要的能力，capability registry 决定系统实际会什么。

### 3.2 四个逻辑边界

当前 SubjectProfile 过胖；本稿不要求第一步拆四张表，但 schema、编辑器、版本 diff 和消费接口必须按
四个逻辑 section 组织：

```text
SubjectDefinition
├── identity
│   └── id / stableKey / displayName / aliases / lifecycle / origin(read-only provenance)
├── learningPolicy
│   └── questionKinds / judgePolicy / causeCategories / scheduling / grounding /
│       sourceWhitelist / sourcingRoutePreference / curriculumSeedPolicy
├── presentation
│   └── languageStyle / renderConfig / uiTheme / noteTemplate / promptFragments
└── assetBindings
    ├── MethodPack
    ├── RubricPack
    ├── SourceCatalog
    └── CurriculumPack
```

服务端可继续把它解析成现有 `SubjectProfile` 聚合，避免一次性重写全部 caller；但发布、
版本和 UI diff 不再把所有字段当成无边界 blob。

这里的 `identity` 是逻辑消费视图，不要求把稳定字段重复写进 revision JSON：`id`、`origin` 和
当前 lifecycle 仍由 `subject` 控制行拥有，hydrate 时与 revision 内可版本化的 display name/aliases
组合成完整 Identity。

边界判定遵循「机器执行规则归 LearningPolicy，可版本化内容归 Assets」：

- `sourceWhitelist`、题源选择条件与 sourcing 路由次序属于 LearningPolicy；具体站点目录、题库、
  教材和参考资源集合属于 SourceCatalog；
- judge capability、route、阈值与权重属于 LearningPolicy；长篇评分规范、反例和 few-shot 属于
  RubricPack；
- 课程结构、KC seed 与课程材料属于 CurriculumPack；是否 seed、何时 seed、如何挂接知识图属于
  LearningPolicy 或显式 control-plane action；
- `promptFragments` 只承载短小呈现/教学风格配置；可独立审阅、复用或较大的领域方法论进入
  MethodPack。

### 3.3 三集合保留

| 集合 | 成员 | 用途 |
|---|---|---|
| resolvable-all | default fallback + 全部 builtin/custom + retired + purge tombstone | 稳定身份、历史名称、审计；purge tombstone 只保证 identity resolve |
| active-selectable | 未退休、已发布、`is_selectable=true` 的 subject | UI、分类、Goal、nightly |
| BOOTSTRAP_IDS | 代码自带 general/yuwen/math/physics | 迁移种子、断网兜底、fixture |

`BOOTSTRAP_IDS` 取代 `KNOWN_SUBJECT_IDS` 的语义；运行时业务枚举不得使用它。
需要完整行为 Profile 的 caller 使用 `resolveSubjectRuntimeSnapshot`：retired 仍返回最后发布
revision；purged tombstone 明确返回 unavailable，历史 UI 使用 tombstone label，若必须渲染正文则显式采用
default fallback 并携带 `resolutionReason='purged'`，不伪装成原科目 Profile。

---

## 4. 状态与数据模型

### 4.1 `subject`：稳定身份与当前控制面

```ts
subject:
  id                        text PK
  origin                    enum('bundled','user') notnull
  display_name              text notnull
  display_name_norm         text notnull
  active_revision           integer null           // 仅 purged tombstone 允许为空
  lock_revision             integer notnull default 0
  is_selectable             boolean notnull default true
  is_default_fallback       boolean notnull default false
  persona_state             enum('fallback_clone','customized') notnull
  user_modified             boolean notnull default false
  retired_at                timestamptz null
  purged_at                 timestamptz null
  bootstrap_suppressed_at   timestamptz null
  created_at / updated_at   timestamptz notnull
```

约束：

- id 不可变；user subject 使用 `subj_<cuid2>`；
- display name 是当前人读权威投影，rename 产生新 revision；
- 部分唯一索引保证至多一行 `is_default_fallback=true`，发布/迁移事务保证始终恰有一行；
- default fallback 必须非 retired、非 purged，且拥有可运行的 active revision；
- 非 purged subject 的 `active_revision` 必须非空并指向 published revision；
- live display name 以 `display_name_norm` 部分唯一索引防重；retired 名称是否可复用由
  create/restore 写门显式处理；
- `origin` 不得成为运行时功能 gate；
- bundled 被用户退休/purge 后写 `bootstrap_suppressed_at`，migrate 不得擅自复活；
- `lock_revision` 是控制行 CAS，与配置 revision 分离。

### 4.2 `subject_revision`：不可变配置版本

```ts
subject_revision:
  subject_id                 text FK -> subject.id
  revision                   integer
  state                      enum('draft','published','abandoned') notnull
  definition_schema_version integer notnull
  profile_version            text notnull
  definition                 jsonb<SubjectDefinition> notnull
  judge_capabilities         jsonb notnull
  scheduling_policy          text notnull
  validation_result          jsonb notnull
  content_hash               text notnull
  created_by                 text notnull
  created_at                 timestamptz notnull
  published_at               timestamptz null
  supersedes_revision        integer null

  PK(subject_id, revision)
```

不变量：

- published revision 永不原地修改；
- `subject.active_revision` 只能指向校验通过的 published revision；
- draft 不进入 runtime registry；
- rollback 不是把旧行改回来，而是重新把 active pointer 切向已发布旧 revision，并产生新 catalog event；
- 每次 publish 同事务更新 display_name/current projections、active revision、catalog revision 与 outbox。

版本三轴继续区分：

- `definition_schema_version`：Zod 形状代际；
- `profile_version`：内容语义版本，不承担 CAS；
- `revision/lock_revision`：机器发布与并发计数。

旧 schema revision 在 hydrate 时只通过纯函数
`upgradeSubjectDefinition(fromVersion, toCurrent)` 生成内存 effective definition，
不改写历史 published row；下一次用户 publish 或 bundled reconcile 才落当前 schema 的新 revision。
upgrade/validate 失败时保留 previous last-good 并阻止该 revision 激活。

### 4.3 `subject_name_claim`：统一命名空间

沿用 YUK-597 v2：

```ts
subject_name_claim:
  name_norm   text PK
  subject_id  text FK -> subject.id
  kind        enum('canonical','alias') notnull
```

- normalize 统一使用 `normalize('NFC').trim().toLowerCase()`；
- canonical stable key、alias 与 builtin legacy id 共用一个 namespace；
- display name 的 live 唯一性另由 `subject.display_name_norm` 部分唯一索引保护；
- rename 不回写历史 payload；是否保留旧 display name 为 alias 是显式用户选择，不自动发生。

### 4.4 `subject_asset` / revision：统一科目资产控制面

```ts
subject_asset:
  id                 text PK              // ast_<cuid2>
  scope_kind         enum('global','subject') notnull
  subject_id         text null FK -> subject.id
  asset_kind         enum(
                       'method_pack',
                       'rubric_pack',
                       'source_catalog',
                       'curriculum_pack'
                     ) notnull
  consumer           enum(
                       'copilot',
                       'note',
                       'quiz_gen',
                       'judge',
                       'sourcing',
                       'knowledge_seed'
                     ) notnull
  delivery_kind      enum(
                       'agent_skill',
                       'structured_data',
                       'reference_bundle'
                     ) notnull
  variant_key        text null            // calculation / translation / primary-school / ...
  origin             enum('bundled','user') notnull
  active_revision    integer null           // 新建 draft 尚未首次 publish 时为空
  lock_revision      integer notnull default 0
  retired_at         timestamptz null
  created_at / updated_at

subject_asset_revision:
  asset_id           text FK -> subject_asset.id
  revision           integer
  state              enum('draft','published','abandoned') notnull
  runtime_name       text null             // agent_skill 时系统生成且全局唯一
  manifest_schema_version integer notnull
  manifest           jsonb notnull
  content_hash       text notnull
  storage_kind       enum('bundled','blob') notnull
  storage_locator    text notnull          // bundled://... 或 r2://...
  validation_result  jsonb notnull
  created_at / published_at

  PK(asset_id, revision)
```

Subject Assets「DB 化」的准确含义：

- DB 管身份、版本、发布状态、active binding、hash、审计；
- bytes 不强塞 definition JSONB；
- builtin bundle 可来自 read-only bundled provider；
- user bundle 存 R2/S3；
- runtime 只通过统一 `SubjectAssetResolver` 读取 typed active revision；当前 SKILL.md 映射为
  `asset_kind='method_pack' + delivery_kind='agent_skill'`。

约束：

- `scope_kind='global'` 时 `subject_id IS NULL`；
- `scope_kind='subject'` 时 `subject_id IS NOT NULL`；
- 新 asset 在首次 publish 前 `active_revision IS NULL`；
- `delivery_kind='agent_skill'` 时 `runtime_name` 必填且全局唯一；其它 delivery 可为空；
- 同 `scope_kind + subject_id + asset_kind + consumer + variant_key` 同一时刻至多一个 active
  binding，索引使用 `NULLS NOT DISTINCT` 或等价规范化避免 NULL 绕过唯一性；
- resolver 按 `asset_kind` 返回 discriminated union；非 Skill 资产不得伪装为 SDK Skill 目录。

### 4.5 catalog revision 与 outbox

```ts
subject_catalog:
  singleton_id       text PK default 'global'
  epoch              text notnull           // restore/灾备切换后换 epoch
  revision           bigint notnull
  updated_at         timestamptz notnull

subject_change_outbox:
  seq                bigserial PK
  catalog_revision   bigint notnull
  change_kind        text notnull
  subject_id         text null
  subject_revision   integer null
  asset_id           text null
  asset_revision     integer null
  created_at         timestamptz notnull

subject_control_log:
  id                 bigserial PK
  actor_kind         text notnull
  actor_ref          text notnull
  action             text notnull          // create/publish/rollback/retire/restore/purge/*
  subject_id         text notnull
  from_revision      integer null
  to_revision        integer null
  asset_revisions    jsonb notnull
  catalog_epoch      text notnull
  catalog_revision   bigint notnull
  diff_summary       jsonb null
  reason             text null
  created_at         timestamptz notnull
```

每次 create/publish/rollback/retire/restore/purge-complete/asset-publish：

1. 同事务 bump catalog revision；
2. INSERT outbox；
3. INSERT append-only control log；
4. `pg_notify('subject_catalog_changed', payload)`；
5. commit 后通知才对 listener 可见。

NOTIFY 只是 wake-up；任何进程都必须能用 DB revision/outbox/full hydrate 自愈。
payload 只携带 epoch/revision/id 等小字段，不携带 definition 或 bundle bytes。
第一版不把控制面动作硬塞进学习者 `event` union：当前
`SubjectKind` 没有 subject/subject_asset，且科目发布不是学习动作。root genesis 仍写
`event`；控制面审计由不可变 revision + `subject_control_log` 承担。

---

## 5. 创建、编辑、发布与回滚

### 5.1 创建科目

```http
POST /api/admin/subjects
{ "displayName": "化学" }

→ 201 {
  "id": "subj_ab12...",
  "displayName": "化学",
  "activeRevision": 1,
  "configurationMode": "fallback_clone",
  "seedRootId": "seed:subj_ab12...:root",
  "catalogEpoch": "cat_...",
  "catalogRevision": "42"
}
```

单事务：

1. mint opaque id；
2. clone 当前 default fallback 的 active definition；
3. 写 subject；
4. 写 published subject_revision 1；
5. 写 canonical name claim；
6. `ensureSubjectRoot`：root + genesis event + materialized anchor；
7. bump catalog + outbox + notify；
8. commit 后 app 原子换 registry snapshot。

创建重试继续使用 YUK-597 的 display-name 幂等语义：同名 live user subject 返回 200 回放，
不产生第二行、第二 revision 或第二 root。

### 5.2 编辑与 publish

编辑分两步：

```http
POST /api/admin/subjects/:id/revisions
{
  "expectedLockRevision": 7,
  "definition": { ... }
}
→ 201 draft revision 8

POST /api/admin/subjects/:id/revisions/8/publish
{
  "expectedLockRevision": 7
}
→ 200 active revision 8, lockRevision 8, catalogRevision 43
```

发布门：

- SubjectDefinition Zod parse；
- `validateProfile`；
- judge/scheduler capability registry 对账；
- alias/display-name namespace；
- asset binding 指向存在、已发布、scope 合法的 revision；
- high-impact diff 摘要；
- 可选 AI critic 只能 proposal，不可代替确定性校验；
- transaction CAS，冲突返回 409 current lock revision。

只有 publish 触发 hot reload。保存 draft、运行 critic、预览 diff 均不影响 active runtime。

### 5.3 rename

rename 属于新 subject revision 的 identity section 变更。publish 同事务：

- 更新 `subject.display_name/display_name_norm`；
- active revision 切换；
- 更新 `seed:<id>:root.name`；
- bump catalog/outbox；
- 历史 event/cost/tool log/displayName snapshot 不回写。

### 5.4 rollback

```http
POST /api/admin/subjects/:id/rollback
{ "targetRevision": 5, "expectedLockRevision": 8 }
```

rollback 重新验证目标 revision 在当前 capability registry 下仍可运行；通过后切 active pointer。
若目标依赖已 retired/deprecated/removed capability，拒绝并返回 issues，不静默降级。

### 5.5 builtin reconcile

代码自带 Profile/Subject Assets 是 bootstrap provider，不是永恒运行时权威：

- DB 无 bundled subject → migrate 插入 revision 1；
- bundled seed 版本更新且 `user_modified=false` → 发布新的 bundled revision；
- `user_modified=true` → 保留用户 active revision，记录 available bundled update；
- reset-to-bundled 发布一个指向当前 bundled 内容的新 revision；
- `bootstrap_suppressed_at != null` 的 builtin 不得被 reconcile 复活。

---

## 6. 删除语义

### 6.1 普通删除 = retire

```http
POST /api/admin/subjects/:id/retire
{ "expectedLockRevision": 8 }
```

效果：

- 从 active-selectable、创建器、AI 分类词表、Goal 候选、nightly 候选移除；
- resolvable-all 保留，历史 question/note/event/goal 继续显示正确名称与 Profile；
- 已开始 job 持有旧 snapshot，允许完成；
- 新 job 不再选择该 subject；
- 可通过 restore 热恢复；
- bundled subject 同样允许 retire，migrate 不自动复活。

```http
POST /api/admin/subjects/:id/restore
{ "expectedLockRevision": 9 }
```

restore 重新校验 active revision、名称唯一性、asset bindings 与 default-fallback 约束；通过后
清 `retired_at`、bump catalog 并 hot reload。名称已被新科目占用时返回 409，不暗中改名。

### 6.2 default fallback 约束

当前 default fallback 可以编辑。要退休/替换它，必须同一事务指定另一个已发布、可解析 subject：

```http
POST /api/admin/subjects/:id/retire
{
  "expectedLockRevision": 8,
  "replacementFallbackSubjectId": "subj_xyz..."
}
```

事务完成后仍恰有一个 fallback。DB 不可达时，代码 bundled `general` 仍是进程启动兜底，
但不覆盖 DB 中 owner 选择。

### 6.3 高级永久清除 = purge

purge 不作为普通按钮的同义词。流程：

1. subject 必须先 retired；
2. 生成影响报告：KC、question、note、artifact、goal、event、cost、memory、asset 数量；
3. 用户选择内容处理策略：
   - migrate：迁到另一个 subject/effective-domain root；
   - detach：保留内容但去除 active subject 归属，回落 fallback；
   - cascade：删除可删除的 materialized 内容；
4. 强确认 + backup；
5. durable maintenance job 执行；
6. 完成后 hot unload。

API 分两步，避免一个请求既预览又执行：

```http
POST /api/admin/subjects/:id/purge-impact
→ { impactId, counts, allowedPolicies, backupRequired }

POST /api/admin/subjects/:id/purge
{
  "impactId": "...",
  "policy": "migrate|detach|cascade",
  "targetSubjectId": "...",
  "confirmation": "..."
}
→ 202 { jobId }
```

默认 purge 仍保留最小 tombstone：

```ts
{ id, lastDisplayName, origin, purgedAt }
```

用途是历史 append-only payload、旧 backup 与审计可读，并阻止 bundled seed 被重新插入。
若未来需要隐私级 audit erasure，另立设计，不与普通科目删除混用。

---

## 7. Hot Reload 一致性模型

### 7.1 可见性 SLA

发布成功的定义不是「DB 行写完」，而是：

| 消费面 | SLA |
|---|---|
| 发起 mutation 的 app 进程 | commit 后立即原子切换 |
| 其它 app/worker 进程 | PG notify 正常时秒级；断线时周期 reconcile ≤60s |
| 当前 browser tab | mutation success 后立即 invalidate/refetch |
| 其它 browser tab/window | SSE/BroadcastChannel 秒级；断线时 ETag/refetch ≤60s |
| 已开始 request/job | 不切换，继续使用捕获 revision |

「全部 hot reload」因此指**新工作单元自动使用新 active revision**，不是运行中途修改同一次 AI 调用。

### 7.2 进程内 registry

```ts
interface SubjectRuntimeSnapshot {
  catalogEpoch: string;
  catalogRevision: bigint;
  subjectId: string;
  subjectRevision: number;
  definition: SubjectDefinition;
  profile: SubjectProfile;
  aliases: readonly string[];
  lifecycle: {
    selectable: boolean;
    retiredAt: Date | null;
    purgedAt: Date | null;
    isDefaultFallback: boolean;
  };
  assets: readonly ResolvedSubjectAsset[];
  snapshotHash: string;
}
```

registry 更新规则：

- hydrate/build 新的 immutable Map；
- 全部校验成功后一次性替换 Map 引用；
- 不在 live Map 上逐字段 mutation；
- request/job 入口捕获 snapshot；
- trace/cost log 记录 subject id + subject revision + asset revisions + snapshot hash。

### 7.3 app 启动与写后即时切换

- serve 前 hydrate 全部 resolvable subject 与 active revisions；
- 表缺失/单行坏数据沿 YUK-597 never-throws 规则保留 bundled last-good；
- 本 app 完成 publish transaction 后，用 transaction 返回的完整 revision 构造新 snapshot；
- 必须 post-commit swap，防回滚留下内存幻影。

### 7.4 worker 监听

worker 启动：

1. hydrate before `boss.start/register jobs`；
2. 建专用 PG LISTEN connection；
3. 收到 notify 后读取 DB catalog revision/outbox，加载受影响 subject/assets；
4. atomic swap；
5. connection 重连或 revision 跳号时 full reconcile；
6. 保留 `setInterval(..., 60_000).unref()` 作为漏通知修复，而非主传播机制；
7. shutdown 清 listener、timer 和缓存引用。

本稿改变 YUK-597 v2 对 LISTEN/NOTIFY 的否决：原否决建立在「单用户低频、不需要即时」前提；
owner 现在明确要求全部 hot reload，live consumer 已成立。

### 7.5 browser

新增：

- `GET /api/subjects`：active-selectable safe projection + catalogRevision/ETag；
- `GET /api/subjects/events`：SSE catalog change stream；
- mutation 当前 tab：invalidate `['subjects']` 与对应 detail query；
- SSE 收到更高 revision：invalidate；
- BroadcastChannel 把当前 tab mutation 传播到同源其他 tab；
- 断线 fallback：条件 GET/ETag，最长 60 秒修复。

浏览器永不接收 server-only prompt/grounding/source whitelist/完整 asset bundle；编辑 admin route
按 internal-token gate 获取需要的字段。

普通 `GET /api/subjects` safe projection 至少包含：

```ts
{
  id,
  displayName,
  subjectRevision,
  renderConfig,
  uiTheme,
  causeCategories: [{ id, label }],
  questionKinds,
  configurationMode,
  maturity,
  catalogEpoch,
  catalogRevision
}
```

`uiTheme` 只允许 schema 化 palette token/受限 accent 参数，不允许任意 CSS 字符串。
未配置 subject 使用 deterministic neutral fallback，页面不得再维护按 subject id 的本地 tone map。

---

## 8. Subject Assets 热加载

### 8.1 资产分类

| `asset_kind` | 内容 | 典型 `consumer` |
|---|---|---|
| `method_pack` | SKILL.md、领域方法论、解题/教学工作流 | `copilot` / `note` / `quiz_gen` |
| `rubric_pack` | 评分规范、反例、few-shot、验收样例 | `judge` / `quiz_gen` / `note` |
| `source_catalog` | 可信题源、教材、参考资源集合及其元数据 | `sourcing` |
| `curriculum_pack` | 课程结构、KC seed、课程材料 | `knowledge_seed` |

`asset_kind` 表达「它是什么」，`consumer` 表达「谁使用它」，`delivery_kind` 表达「runtime
如何交付它」。三者不得重新合并成一个含混字段。

### 8.2 发布管线

```text
编辑 draft bundle
  → 确定性 validate
  → 规范化 manifest；agent_skill 额外规范化 frontmatter/runtime_name
  → 写 bundled provider 或上传 R2 blob
  → content hash
  → publish asset revision
  → subject asset binding publish
  → catalog event
```

建议 API：

```http
POST /api/admin/subjects/:subjectId/assets
→ 创建 asset identity

POST /api/admin/subject-assets/:assetId/revisions
→ 保存 draft manifest/bundle

POST /api/admin/subject-assets/:assetId/revisions/:revision/publish
→ validate + persist bytes + 切 active revision + hot reload

POST /api/admin/subject-assets/:assetId/rollback
POST /api/admin/subject-assets/:assetId/retire
```

允许的 user bundle：

- Markdown；
- JSON；
- 图片；
- 受限文本 reference/few-shot。

默认拒绝：

- JS/TS/Python/shell/native executable；
- symlink/hardlink；
- 绝对路径、`..` path traversal、隐藏配置；
- 超限文件数、单文件大小、总 bundle 大小；
- frontmatter 自带未授权 runtime name；
- 与 capability/tool allowlist 冲突的声明。

### 8.3 Resolver、runtime name 与内容寻址物化

`SubjectAssetResolver` 先按 snapshot 中的 binding 解析 typed asset：

- `agent_skill` 物化为 Claude Agent SDK 可消费的 Skill 目录；
- `structured_data` 解析并缓存 schema 化 JSON/Markdown 数据；
- `reference_bundle` 提供只读内容句柄/索引，不强制生成 Skill 目录。

runtime name 只属于 `delivery_kind='agent_skill'`。不再让 `quiz-gen-calculation` 直接成为全局身份。
用户可见 label 与 runtime key 分离：

```text
display label: 化学计算题规范
asset id:      ast_ab12...
runtime name:  loom_skill_ast_ab12_r3
```

发布器重写/生成 SDK 所需 frontmatter name，目录名与白名单使用 runtime name，从根消灭跨科撞名。

当前 process-global singleton 改为按 snapshot 的内容寻址 asset cache/materializer。agent skill 的
物化形状为：

```text
/tmp/loom-skills/<asset-set-hash>/
  skills/
    loom_skill_ast_ab12_r3/
      SKILL.md
      assets/
      references/
```

- asset set hash 由本 job 所需 active asset revisions 决定；
- 新 revision 写新目录，绝不覆盖旧目录；
- 运行中 job 继续读旧快照；
- 新 job 使用新目录；
- cache 建成后只读；
- TTL + 引用计数/last-used 回收；
- structured data/reference bundle 使用同一 hash/cache 生命周期，但由 resolver 直接解析或提供句柄，
  不创建伪 Skill 目录；
- fetch/materialize 失败时保留 previous last-good；若无 last-good，按 consumer 明确降级或拒绝，
  `method_pack` 可回落 Profile prompt，judge/source/curriculum 不得静默假装已加载，并统一告警。

### 8.4 bundled assets

现有 repo skills、rubric、题源目录与 curriculum 继续作为：

- 受 git review 的首批方法论；
- bootstrap/reconcile 源；
- DB/R2 故障时的 bundled fallback；
- fixture/golden 对应的已知版本。

Docker 不再手写三条 COPY；构建产物必须携带统一 bundled asset manifest，并包含 `_shared`。
构建/audit 必须验证：

- manifest 列出的 bundle 都存在；
- content hash 一致；
- agent skill runtime name 全局唯一；
- 没有同 `asset_kind/consumer/variant_key` 的不明确多 active binding；
- 四种 `asset_kind` 均能通过统一 resolver 校验并解析。

---

## 9. Capability 边界

用户可以热配置：

- question kinds；
- judge route 偏好；
- 已注册 judge capability 选择；
- scheduling policy 选择；
- cause taxonomy；
- render、language style、note template；
- prompt fragments、grounding、source policy；
- MethodPack、RubricPack、SourceCatalog、CurriculumPack 及其 bindings；

用户不能热创建：

- 新 judge runner；
- 新 scheduler implementation；
- 新 Hono route/job/tool/effect；
- 新代码执行器；
- 任意脚本能力。

`validateProfile` 与 publish validator 必须保证所有 capability id 在当前 registry 存在，
并拒绝 incompatible activity kinds。科目是 data-driven policy，不是动态 plugin host。

---

## 10. 知识图、Goal、AI 与 nightly

### 10.1 subject root

继续使用 `seed:<subjectId>:root` 作为结构锚，但科目存在由 `subject` 行决定，
root 只是 projection。

- 创建科目同事务确保 root + genesis + anchor；
- rename 同事务更新 root.name；
- retire 不删除 root；
- purge 按内容策略处理 root；
- `resolveSubjectKnowledgeIds` 继续源头排除 synthetic root；
- 长期可增加显式 `node_kind='subject_root'`，取代 id-pattern；不是本稿第一阶段阻断。

### 10.2 Goal

YUK-603 `scope_mode` 原样保留：

- `explicit`：frozen KC 集权威；
- `subject_live`：每次读从 subject/effective-domain 派生；
- subject retire 后不再创建新的 subject_live Goal；
- 既有 Goal 的历史 subject 可解析；是否自动 dormant 由用户确认，不暗中改状态。

### 10.3 AI 分类

继续采用：

```ts
known_subjects: [{
  id,
  display_name,
  aliases?
}]
```

- 只来自 active-selectable runtime registry；
- display name/alias 提供语义，opaque id 原样回传；
- 输出闭集校验；
- `is_selectable=false` 的 fallback（默认 general）不进分类候选；fallback 角色本身不排除一个仍
  selectable 的真实科目；
- publish/retire 后新 job 秒级看到新词表；
- job trace 记录分类时使用的 catalog revision。

### 10.4 nightly

- 候选源统一 `getSelectableSubjectIds(snapshot)`；
- 禁止 runtime 遍历 `BOOTSTRAP_IDS`；
- 保留 ≥5 个内容 KC gate，不计 synthetic root；
- retired/purged subject 不进入新提案；
- 运行开始捕获 catalog revision，整批按同一 snapshot，避免 batch 中途换科目集合。

---

## 11. UI/交互合同

### 11.1 用户心智

科目有明确成熟度，不假装「输入一个名字就具备完整专业知识」：

| 状态 | 含义 |
|---|---|
| 沿用默认配置 | clone 当前 default fallback，尚无科目专属资产 |
| 已配置 | Profile 已由用户发布修改 |
| 专业化 | 至少一个 subject-specific typed asset active |
| 已退休 | 不再供新工作选择，历史仍可读 |

`persona_state='fallback_clone'` 继续承担默认配置模式的稳定映射；UI 同时显示被 clone 的
fallback display name。专业化由任一 subject-specific MethodPack、RubricPack、SourceCatalog 或
CurriculumPack 的 active binding 派生，不手写布尔。

### 11.2 页面/组件类型声明（UI Design Compliance）

本稿若获 owner 批准，可作为以下 UI 的行为设计前置；视觉细节继续复用现有 design-system primitives：

- route page：`/admin/subjects` 科目目录；
- route page：`/admin/subjects/:id` 科目详情、revision、Profile 与 Asset 编辑；
- modal：publish diff/validation 确认；
- modal：retire 确认；
- modal：purge impact report + 强确认；
- inline form：`/welcome` 新建科目；
- badge：沿用默认配置 / 已配置 / 专业化 / retired / update available。

预计 UI touch 面（实施前仍需按最终 route/manifest 复核）：

- Modify：`src/capabilities/observability/ui/subjects.tsx`；
- Create：`src/capabilities/observability/ui/subject-detail.tsx`；
- Modify：`src/capabilities/observability/manifest.ts`；
- Modify：`web/src/router.tsx`（仅当 capability page 聚合不足以自动挂载 detail route）；
- Modify：`web/src/routes/WelcomePage.tsx`；
- Modify：`src/ui/lib/subject.ts`；
- Create：subject query/editor hooks（落位在 observability 或 shared UI，实施设计再定）。

红线：

- client 不 mint subject/asset id；
- client 不构造 seed root/name claim；
- UI 不本地模拟幂等；
- 未 publish draft 明示「未生效」；
- destructive purge 不使用普通确认按钮；
- server-only prompt/asset bundle 不进入普通 `GET /api/subjects`。

---

## 12. 失败矩阵

| 场景 | 行为 |
|---|---|
| draft 校验失败 | 拒绝 publish；active revision 不变 |
| CAS 冲突 | 409 current lock revision；不覆盖 |
| app post-commit swap 失败 | DB 已是真相；立即按 catalog revision reload，返回成功但记录 HIGH 告警 |
| NOTIFY 丢失 | 60s reconcile/outbox revision gap 修复 |
| worker LISTEN 断线 | 保留 last-good；重连后比较 catalog revision，必要时 full hydrate |
| blob 上传失败 | 不写 published asset revision，不切 binding |
| blob 运行期不可达 | 使用本机 content-hash cache/last-good；无缓存则按 consumer 显式降级或失败，禁止静默换内容 |
| 单个 subject revision 坏行 | skip 新 revision，保留该 subject previous last-good；不得把整个 registry 清空 |
| migration/table 缺失 | subject hydrate WARN；bundled 四 profile fallback；DB 主业务仍按既有启动策略 |
| retire 时有 in-flight job | job 用捕获 snapshot 完成；新 job 不再选择 |
| rollback 目标 capability 已消失 | 拒绝 rollback，回显 issues |
| purge 中断 | durable job checkpoint；subject 保持 retired/purging，不恢复 selectable |
| restore 后 catalog revision 回退 | 启动 full hydrate，生成新的 monotonic catalog epoch/revision |

---

## 13. Backup / Restore

必须纳入 archive：

- subject；
- subject_revision；
- subject_name_claim；
- subject_asset；
- subject_asset_revision；
- subject_control_log；
- active pointers、tombstone、bootstrap suppression；
- user asset blobs 或可验证的 bundle export。

可排除：

- subject_change_outbox（瞬态传播日志）；
- 本机 content-addressed asset cache；
- SSE/worker listener cursor。

restore 顺序：

1. identity/control rows；
2. revisions；
3. name claims；
4. assets/revisions；
5. blob integrity verify；
6. active pointer integrity；
7. full registry hydrate；
8. bump 新 catalog epoch/revision，通知全部进程。

bundled reconcile 必须尊重 restored `user_modified` /
`bootstrap_suppressed_at`，不得覆盖 owner 选择。

---

## 14. 可观测性与审计

每次发布/回滚/退休/恢复/purge 记录：

- actor；
- subject id；
- old/new subject revision；
- old/new asset revisions；
- catalog revision；
- diff summary；
- validation result；
- trace/evidence refs；
- reason/comment（可选）。

新增 admin 观测：

- DB catalog revision；
- app loaded revision；
- worker loaded revision；
- reload lag；
- LISTEN connection state；
- last successful hydrate；
- last reload error；
- asset materialization cache hit/miss；
- process 当前 last-good snapshot hash。

新增审计：

- `audit:profile --db --strict`：全部 published revisions；
- `audit:subject-catalog`：active pointers、fallback 唯一性、selectable/resolvable 不变量；
- `audit:subject-assets`：四种 `asset_kind` 的 binding、consumer、delivery、hash、storage、
  runtime name、文件类型与 namespace；
- stale-const audit：运行时代码禁止新增 `KNOWN_SUBJECT_IDS` /
  `subjectProfiles` snapshot 枚举；
- UI tone audit：禁止页面新增 `SUBJECT_TONE` subject-id map；
- Docker/build audit：bundled manifest 与实际文件逐 hash 对齐，`_shared` 不得漏包。

---

## 15. 安全模型

- 所有写面位于 `/api/admin/*`，继承 `x-internal-token`；
- publish 使用确定性 schema + capability registry 校验；
- prompt/Subject Assets 修改虽然是 data，不等于低风险：必须保留 diff、revision、rollback、审计；
- runtime name、文件路径、blob key 均由服务端生成；
- user bundle 解包在隔离临时目录，先验证后原子移动；
- 禁止 executable 与 symlink；
- asset size/file-count/content-type 有硬上限；
- AI critic 只能提出建议，不能 publish；
- 破坏性 purge 必须由用户显式接受影响报告，AI 只能 propose；
- 历史 event append-only，不因 rename/edit 自动回写。

### 15.1 否决的替代方案

| 方案 | 否决原因 |
|---|---|
| 继续只用代码 Profile | 无法让用户自治创建/修改，也不具备运行时发布 |
| 创建科目时自动生成源码目录 | 仍需 build/deploy，并把产品操作变成自修改代码 |
| 把整个 asset bundle 塞进一个 JSONB | 混淆控制面与 bytes，附件/图片/校验/缓存/导出都变差 |
| 只做 60 秒 polling | 能最终一致，但不满足明确的全链 hot reload 要求 |
| 只做 LISTEN/NOTIFY | 通知会丢、断线无重放，不能充当真相源 |
| 原地覆盖 active definition | 没有安全 draft、稳定 in-flight snapshot、历史 diff 与可靠 rollback |
| 普通删除直接物理级联 | 会破坏历史 evidence、Goal、event 与 backup 解析 |
| 允许资产带脚本 | 把内容配置升级成动态代码执行入口，越过 capability registry |

---

## 16. 迁移与实施切分

### Phase 0 — 独立前置

- YUK-603 `scope_mode` 修复继续完成，不受本稿阻塞；
- 修 Docker `_shared` skills 漏复制；
- 对当前扁平 skill namespace 加 collision audit，禁止新增撞名包。

### Phase 1 — Versioned Subject Core

- 落 `subject` / `subject_revision` / claims / catalog / outbox；
- bootstrap 四 Profile 为 revision 1；
- registry 改 immutable snapshot；
- boot hydrate before serve/work；
- 保持无 user subject 时行为逐位一致。

### Phase 2 — Dynamic read + browser provider

- `GET /api/subjects` safe projection；
- 移除浏览器全血 Profile import 与 module-level frozen snapshot；
- runtime 枚举从 `KNOWN_SUBJECT_IDS` 迁到 active-selectable；
- ETag/catalog revision。

### Phase 3 — CRUD + publish + hot reload

- thin-create；
- draft/publish/rollback；
- rename/reset；
- retire/restore；
- app post-commit swap；
- worker LISTEN/NOTIFY + periodic reconcile；
- browser SSE/BroadcastChannel。

### Phase 4 — Versioned Subject Assets

- asset/revision schema；
- bundled asset manifest/provider；
- R2 user bundle；
- publish validation；
- MethodPack、RubricPack、SourceCatalog、CurriculumPack 迁入统一 registry；
- typed resolver + content-addressed cache/materializer；
- runner 从 singleton config dir 改 snapshot cache；
- Note/Quiz/Copilot/Judge/Sourcing/KnowledgeSeed 统一到 `SubjectAssetResolver`。

### Phase 5 — UI

- admin catalog/detail/editor；
- publish diff；
- asset editor/upload；
- onboarding create；
- maturity/status badges；
- retire/restore；
- purge impact UI。

### Phase 6 — Purge / backup / audits

- impact report；
- durable purge policies；
- tombstone；
- archive blob export；
- catalog/asset audits；
- process revision observability。

---

## 17. 对 YUK-597 实施单的影响

本稿若获批，现有 issue 不应按原描述直接开工：

| Issue | 处理 |
|---|---|
| YUK-603 | 不变，继续先行 |
| YUK-598 | 保留三集合/provider；补 catalog revision、ETag、SSE、uiTheme，移除 5min-only 新鲜度与页面 tone map |
| YUK-599 | 单表 definition 改 versioned subject core；60s 主刷新改 LISTEN 主通道 + reconcile 兜底 |
| YUK-600 | thin-create 保留，但写 revision 1 + catalog/outbox；goal/knownSubjects/nightly 合同保留 |
| YUK-601 | 直接 PUT/CAS 改 draft/publish/rollback；纳入四类 typed asset revisions、bindings 与 hot reload 观测 |
| YUK-602 | onboarding 手填保留；`isGeneralFallback` 改为稳定的 `configurationMode='fallback_clone'`；badge 扩为默认配置/已配置/专业化/退休状态 |

建议在 owner 批准本稿后：

1. 更新 YUK-597 为「Subject Control Plane」总契约；
2. 重写 YUK-598~602 描述和依赖图；
3. 为 Phase 4 Subject Asset Registry/Resolver/Materializer 单独拆 issue，不塞进 Profile PR；
4. 为 purge 单独 issue，第一批 CRUD 不捆绑永久清除。

---

## 18. 验收矩阵

### A. Create / identity

1. 创建「化学」→ subject + revision 1 + claim + root/genesis/anchor + catalog event 同事务；
2. 并发/重试创建同名 → 同 id 回放，恰一行一根；
3. create 后 app 新请求立即解析；worker 不重启秒级解析；断 LISTEN 后 ≤60s 自愈；
4. opaque id AI 分类使用 display name，闭集校验存活。

### B. Publish / snapshot

5. 保存 draft 不改变任何 live request；
6. publish 后新 request 使用新 revision；
7. publish 前已启动 AI call 继续使用旧 revision，trace 记录旧 snapshot hash；
8. CAS 两写只有先者成功；
9. rollback 切回旧 revision，新请求生效，历史 revision 不修改；
10. 畸形 Profile/不存在 capability/坏 asset binding 无法 publish；
11. 发布 uiTheme/renderConfig 后当前与其他 browser tab 自动更新，页面无 subject-id tone 特判。

### C. Subject Asset hot reload

12. 发布化学 Note pack → 新 Note job 使用新 runtime name/revision；
13. 旧 Note job 在 publish 后仍完成且只见旧 bundle；
14. 数学/物理同时各有 calculation pack，无目录/name collision；
15. 生产镜像能解析 `_shared`；
16. R2 临时失败使用 hash cache；无 cache 走明确 Profile fallback；
17. executable/symlink/path traversal/超限 bundle 被拒；
18. 发布 RubricPack 后，新 judge/verify 使用新 revision，已开始的判分仍使用旧 revision；
19. 发布 SourceCatalog 后，新 sourcing 使用新目录，题源路由顺序仍由 LearningPolicy 决定；
20. 发布 CurriculumPack 不自动 seed；只有显式 `knowledge_seed` policy/action 才执行挂图；
21. MethodPack、RubricPack、SourceCatalog、CurriculumPack 均可独立 rollback，且 typed resolver
    不把非 agent skill 资产物化成 Skill 目录。

### D. Retire / restore / purge

22. retire 后 chips/classifier/nightly 即时移除，历史页面仍正确渲染；
23. in-flight job 完成，新 job 不选择 retired subject；
24. restore 后无需重启重新进入 active-selectable；
25. default fallback 无 replacement 时禁止 retire；
26. bundled subject retire 后 migrate 不复活；
27. purge 前必须有影响报告；中断可续；完成后 tombstone 可解析旧 event。

### E. Browser / process recovery

28. 同 tab publish 立即更新；
29. 另一 tab 经 SSE/BroadcastChannel 更新；
30. SSE 断线后 ETag/refetch 修复；
31. worker notify 丢失后 revision gap/full reconcile 修复；
32. 单个坏 revision 不清空 registry，不影响其他科目；
33. app/worker loaded catalog revision 可在 admin 观测。

### F. Graph / Goal / backup

34. subject_live Goal 持续读新增 KC，synthetic root 不进入内容集；
35. retire 不破坏既有 Goal/history；
36. dump→wipe→restore 后 active revisions、assets、control log、tombstone、suppression 全保真；
37. restore 后发布新 catalog epoch，全部进程重新 hydrate；
38. 每次 create/publish/rollback/retire/restore/purge 都有 append-only control log；
39. 全仓无 runtime consumer 新增 BOOTSTRAP_IDS/subjectProfiles 枚举。

---

## 19. 最终架构图

```text
                    ┌─────────────────────────────┐
                    │        Admin / Welcome       │
                    │ create · draft · publish     │
                    │ rollback · retire · restore  │
                    └──────────────┬──────────────┘
                                   │
                         transaction + CAS
                                   │
                    ┌──────────────▼──────────────┐
                    │          Postgres            │
                    │ subject / revisions / claims │
                    │ assets / catalog / outbox    │
                    └───────┬───────────┬─────────┘
                            │           │
                       PG NOTIFY     R2 / bundled
                            │        asset providers
             ┌──────────────┼──────────────┐
             │              │              │
        ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
        │ App Map │    │Worker Map│    │ Browser │
        │snapshot │    │ snapshot │    │ provider│
        └────┬────┘    └────┬────┘    └─────────┘
             │              │
             │       typed asset resolver +
             │       content-addressed cache/materializer
             │              │
             └──────┬───────┘
                    │
          request/job captures immutable
             SubjectRuntimeSnapshot
                    │
       Profile + capabilities + typed subject assets
```

最终形态不是「把所有东西塞进 DB」，而是：

> DB 管控制面与版本真相；文件/R2 管 bundle bytes；capability registry 管可执行能力；
> Postgres/R2 学习数据管内容；所有运行时消费者只认同一个已发布 SubjectRuntimeSnapshot。
