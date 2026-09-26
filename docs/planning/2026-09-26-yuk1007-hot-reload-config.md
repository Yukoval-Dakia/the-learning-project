# YUK-1007 热加载配置架构 + 迁移 grounding（hot-reload config architecture）

- 日期：2026-09-26
- 票据：YUK-1007（统一配置面板）· owner directive：「全部做到 hot reload，硬编码改成加载配置，降低硬编码率」
- 性质：grounding 文档（迁移 lane 的执行依据）。每条断言回溯到 census 或源码 file:line；lane 执行时**不再重新普查**。
- 输入：
  - 普查：`docs/planning/2026-09-26-yuk1007-config-surface-census.md`（基线 `6d87cebb9`；110 env keys / 52 TaskSpec / 80+ hardcoded）
  - preflight：`docs/design/2026-09-26-yuk1007-settings-panel-preflight.md` §4.2/§5/§10.3（写项生效时机标注、mutation path、后端 seam）
  - 现状管线：`src/server/env.ts`、`src/core/env-flags.ts`、`src/server/ai/providers.ts`（`resolveTaskProvider` :508-608）、`src/ai/task-catalog.ts`
- 范围裁决：**真实运行时配置系统**，不是只读面板。DB 是 app（Hono）+ worker（pg-boss）两进程的共享媒介（无 IPC、无 Redis——AGENTS.md runtime 边界）；secret 留 env；TaskSpec 保持 `Object.freeze`，经 `resolveTaskProvider` 既有链加 DB 层。

---

## §1 Config store 设计

### 1.1 表形态裁决：per-key 行（非单行 JSONB）

**裁决：`system_config` per-key 行 + `system_config_journal` 审计 + `system_config_epoch` 无效化轴。**

两形态对比（针对 ~150 项：~40 运行时 env 旋钮 + 52×2 task override + ~10 scoped lane + ~20 migratable 阈值/旋钮，census §2）：

| 维度 | per-key 行（选） | 单行 JSONB blob |
|---|---|---|
| per-key zod schema / clamp | key → schema 直查，写时逐 key 验证 | 先解整 blob 再逐字段，schema 挂在子路径 |
| journal（admin-trait-journal 先例） | `(key, revision)` PK 天然对齐 `subject_trait_journal` 形态 | journal 只能记整 blob diff，行内溯源弱 |
| 来源溯源（preflight §6.2 `db`/`env`/`compose`/`code-default`） | 每行自带 `updated_at`/`updated_by`/`revision` | 需另建 per-key meta 表，等于回到 per-key |
| 并发写 | `ON CONFLICT (key)` 行级，两进程同 key 写=最后一次赢 | 整 blob `UPDATE`，多 key 写互相覆盖风险 |
| 部分失效（坏行） | hydrate 逐行 skip+WARN（subject precedent `hydrate.ts:266-285`） | 一个坏字段可让整 blob 验证失败 |
| 多 key 原子写 | 单 tx 内多行 upsert + epoch +1（够用） | 天然原子 |

单行 JSONB 的唯一真实优势是跨 key 原子写；面板写项全是单条目（preflight §5 每类 mutation 都是单 key PATCH），tx 内多行 upsert 已覆盖。**per-key 行胜**。

### 1.2 Schema 草案（非最终 DDL；drizzle migration 由实施 lane 落）

```text
system_config
  key          text        PK            — registry 登记的 canonical key（§1.5）
  value        jsonb       not null      — boolean | number | string | {provider?,model?,budget?}
  revision     integer     not null      — 每次写 +1
  source_note  text        null          — 自由备注（「谁为什么设」）
  updated_by   text        not null      — 'panel:admin' | 'migrate' | 'cli'
  created_at / updated_at  timestamptz   — 生效溯源 + 读面 `db` 徽标

system_config_journal      — admin-trait-journal 先例（subject_trait_journal，
                             src/db/schema.ts:3412-3441）
  key          text        not null
  revision     integer     not null      — PK(key, revision)
  payload      jsonb       not null      — {prev, next, note}
  action       text enum                 — 'set' | 'clear' | 'seed'
  actor        text                      — 'owner' | 'migrate'（沿用 enum 先例）
  change_seq   bigint                    — 独立 seq config_change_seq（不复用
                                           subject_change_seq，两域独立）
  created_at   timestamptz

system_config_epoch        — 单行无效化轴
  id           text        PK 恒 'global'
  epoch        bigint      not null      — 每次写 +1（config_change_seq 同序列）
  updated_at   timestamptz
```

### 1.3 读路径：同步快照 + 周期 refresh（subject profile 先例）

**硬约束**：`resolveTaskProvider` 在 `AiRunLifecycle` **构造函数**里同步调用（`src/server/ai/run-lifecycle.ts:181-201`），`judgeDurableEnabled()` 等 flag reader 全是同步函数——**读值不能 await**。因此采用 subject profile 的承重先例：`src/server/subjects/hydrate.ts`（boot `hydrateSubjectRegistryFromDb` :161 + worker `startSubjectRefresh` :314，60s 间隔，never-throws，last-good 保留）。

```
内存快照  ConfigSnapshot = ReadonlyMap<key, {value, revision, updated_at}>
            └ 模块级单例；hydrate 成功后**整引用替换**（atomic swap，
              = replaceSubjectTraitResolutions 先例 hydrate.ts:303）
写后即时  写路径 commit → await hydrateConfigFromDb(db)（app 侧，= trait-write.ts
            先例：每个写函数 commit 后由 route 壳触发 hydrate）
周期刷新  startConfigRefresh(db, intervalMs)：app + worker 都挂；setInterval unref，
            never-throws。间隔建议 15s（subject 是 60s；配置面期望值「下次调用
            生效」，15s 是诚实可标注的有界窗口——见 §6 stale windows）
epoch 轴  hydrate 先 SELECT epoch：与快照 epoch 相同 → skip 全量 select（一行
            探测 ≈ 0 成本）；worker 与 app 靠它自然收敛，无 IPC
兜底     hydrate 失败（42P01 表未建 / DB down）→ WARN + 保留 last-good /
            env-only 地板（= hydrate.ts:305-309 先例）
```

### 1.4 写 API + zod 校验

```ts
// src/server/config/store.ts（NEW）
setConfig(key, value: unknown, opts: {actor, note?}) =>
  tx: journal(+epoch) + row upsert，同一 tx
  → zod schema[key].parse(value) 失败 → tx 回滚 + ApiError 422
  → commit 后 await hydrateConfigFromDb(db)（写进程即时生效）
clearConfig(key, opts) — 删除行（=「恢复默认」按钮的落点），journal action='clear'
```

**每 key zod schema 登记处**：`src/server/config/registry.ts`（NEW）——key → `{schema, codeDefault, envName?, envPinned?, tier, owner, risk}`。clamp/enum 直接取 census §1：

- `WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD`: `z.number().min(0).max(1)`（现 clamp [0,1]，workflow-judge-config.ts:102-108）
- `JUDGE_CALIBRATION_BATCH_MAX`: `z.number().int().min(1).max(50)`（census §1.A line 34）
- `JUDGE_CALIBRATION_WINDOW_DAYS`: `z.number().int().min(1).max(90)`（同上）
- `KC_DEDUP_*`: `z.number().positive()` / `z.number().int().min(1)`（dedup-flags.ts:67-82 的「≤0 = 静默禁用」规则必须进 schema，不能只靠 fallback）
- `BACKUP_IMPORT_MAX_BYTES`: `z.number().int().min(1_000_000)`（backup-import.ts:30-39 floor 1MB；注意 census 路径写的是 `server/backup-import.ts`，实际文件已挪到 `api/backup-import.ts`——lane 以此为准）
- `EXTRACT_OCR_ENGINE`: `z.enum(['glm','tencent'])`（env.ts:47 schema 同源）
- flag 组: `z.boolean()`（DB 层真值即 boolean；`parseFlag` 文法只用于 env fallback 层）
- `task.<kind>.*` / `lane.<lane>.*`: provider 字段 `z.enum([...8 Provider])` + 写时跑 `isProviderImplemented`/`providerRequiresExplicitModel` 谓词（providers.ts:382,402——DB 写入端复用 solve-lane 的 fail-open 预检语义，非法组合直接 422 而不是入库后降级）
- `MEMORY_RECONCILE_HANDOFF_MODE`: `z.enum(['observe','write','recover','drain'])`（memory-reconcile-handoff.ts:21；现为 throw-on-invalid——DB 化后 422 at write time 更优）
- `SELECTION_POLICY`: `z.enum(['legacy','softmax_mfi'])`（stream-store.ts:518-521）
- `locale`: 首版 `z.enum(['zh-CN','en'])`（§3 locale 行）

### 1.5 Key 命名空间

| 前缀 | 例 | 说明 |
|---|---|---|
| 裸 env 名 | `CONFUSABLE_CONTRAST_ENABLED` | env-migratable 项沿用 env 名（读面/文档零翻译成本） |
| `task.<kind>.provider` / `.model` / `.budget` | `task.QuizGenTask.model` | per-task override；`.budget` 值 = `{maxIterations?,maxCost?,transientRetries?,timeout?}` 部分对象 |
| `lane.<lane>.provider` / `.model` | `lane.verify_solve.provider` | 4 条 scoped lane + `lane.global.*`（`AI_PROVIDER_OVERRIDE` 的 DB 位） |
| `locale.learner` | `locale.learner='zh-CN'` | per-learner locale 落点（单用户期 = 单行） |
| 新 config key | `kc.matcher.cosine_max_distance` | C2 hardcoded → config 迁移项（§3 tier B 第三批） |

**不建 key 的项**：secret（provider keys/INTERNAL_TOKEN/DATABASE_URL/R2_*/TENCENT_*/MEM0 credentials）、env schema 自身、VITEST/NODE_ENV、script-only envs（census §3「不上面板」清单不变）。

---

## §2 Reader 迁移模式

### 2.1 规范读 API

```ts
// src/server/config/read.ts（NEW）— 同步读点；DB > env > code-default
export function getConfig<K extends ConfigKey>(key: K): ResolvedValue<K>           // 泛型按 registry schema 推类型
export function getConfigFlag(key: FlagKey): boolean                               // flag 专用糖（bool 断言）
export function getConfigSource(key): 'db' | 'env' | 'code-default' | 'compose-forced' // 读面溯源列直供
export function getTaskOverride(kind: TaskKind): {provider?, model?, budget?} | undefined // task.* 三键合取
export function getLaneOverride(lane: LaneId): {provider?, model?} | undefined
```

**分层裁决（每个 env-migratable key）**：

```
DB 行存在且经 schema → 用 DB 值（updated_at 进读面）
  else envName 对应 process.env 在场 → env 值（沿用该 reader 现 parser）
  else code-default（registry 声明值）
```

例外 `envPinned`：registry 标 `envPinned: true` 的 key（首批 = 三条 compose 强制项 `PLACEMENT_PROBE_ENABLED` / `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` / `MISCONCEPTION_PROMOTE_ENABLED`，census §4.1 + preflight §4.2 compose 特殊处理）**跳过 DB 层**，直读 `env > code-default`；写端对这些 key 返回 409 + 「compose 固定」文案。这样保留 preflight 的「compose 强制 → 写控件禁用」诚实语义——面板写 DB 永远不会静默输给 deploy pin。

`parseFlag` 文法（`src/core/env-flags.ts:14-22`，`true/1` 开、`false/0` 关、其余取默认）**只作用于 env fallback 层**；DB 层 flag 值是 `z.boolean()` 真值。迁移期若 DB 行出现非 bool（手工注入），schema parse 失败 → 该 key 本轮落到 env/default + WARN（never-throws 对齐 hydrate 先例）。

### 2.2 调用点改造模式（三种形态）

**形态 A — per-call env reader（零结构改动）**：函数体内已是每次读 env。

```ts
// 今：rate-limit.ts:29-34
const { max, windowMs } = { max: readPositiveInt(process.env.AI_RATE_LIMIT_MAX, 30), ... }
// 后：
const { max, windowMs } = getConfigMany(['AI_RATE_LIMIT_MAX', 'AI_RATE_LIMIT_WINDOW_MS'])
```

**形态 B — module-load 快照（export const）**：`export const X = parse(process.env.X)` 在 import 期冻结。改法二选一：

1. **reader 函数化**（首选）：删 const，导出 `export function placementProbeEnabled(): boolean { return getConfigFlag('PLACEMENT_PROBE_ENABLED') }`。消费点改调用。`PLACEMENT_PROBE_ENABLED` 现有 4 个真实消费点（`src/server/session/placement.ts:42` 声明 → `src/capabilities/practice/api/placement-start.ts:29,37`、`src/capabilities/practice/server/placement-starter-recovery.ts:90,175,441`、`src/kernel/placement.ts:15` re-export→`question_supply_nightly.db.test`），外加 getter-mock 测试面（`placement-coldstart-e2e.db.test.ts:29`、`placement-api.db.test.ts:21` 用 `get PLACEMENT_PROBE_ENABLED()` mock——**迁成函数后 mock seam 改为 mock 该函数或注入 config snapshot**，见 §6 test store）。
2. **保留 const 名 + 改 Proxy/getter 导出**：`export const MATCH_THRESHOLD` 是值快照无法自愈；必须换成 `export function matchThreshold()` 或 `export const MATCH_THRESHOLD` → namespace getter。**不接受**「模块里留一个每 15s 自更新的 mutable let」——多读者间值漂移不可观测，违背单一快照语义。

**形态 C — 编译期 freeze 项接 DB 层（TaskSpec / LEARNER_LOCALE_PIN）**：对象本身不动，在**消费函数**里加 DB 覆盖层：

- `resolveTaskProvider`（providers.ts:508-608）插入第四级。**Ordering decision（需 owner 裁决或按推荐执行）**：
  `arg override > env global switch (AI_PROVIDER_OVERRIDE) > DB per-task override > registry default`。
  推荐理由：全局 env pin 语义是「operator 钉死全进程」（providers.ts:485-496 `hasGlobalProviderOverride` 注释确认 pinned routing 是显式 operator decision），若 DB 单 task 覆盖能穿它，面板一行动静会破坏 pin；且 `crossoverModelForProvider`（providers.ts:421-428）已假设 env-switch 在 DB 之上。此层为**同步快照读**（`getTaskOverride(kind)`），构造器内安全。
- `model` 字段同样分层：`override.model ?? envOverride.model ?? dbOverride.model ?? subDefaultModel`（:547）。`providerRequiresExplicitModel` 全局切换 guard（:531-541）对 DB 来源同样成立——`cameFromDbSwitch && requiresExplicit && !model` 时应**在写端 422 拦下**（§1.4），读端保持 throw 兜底。
- budget：`runner.ts` 已有 `ctx.budgetOverride?: {maxIterations?, timeoutMs?}`（:242, :469, :806, :1077）+ `run-lifecycle.ts:691` 读 `tasks[kind].budget.transientRetries`。插入 `getTaskOverride(kind).budget` 于 `ctx.budgetOverride` 与 `def.budget` 之间（`maxTurns`/`timeoutMs`/`transientRetries`/`maxCost` 四处：`runner.ts:469,806,1077`、`run-lifecycle.ts:691`；`maxCost` 当前 grep 无直接消费点 → 列为 budget 字段补接线或明确不接线）。
- `LEARNER_LOCALE_PIN`（task-prompts.ts:30-46）：`getTaskSystemPrompt` 已每次调用执行（preflight §5 locale 行确认），改 `+ buildLocalePin(getConfig('locale.learner'))`。pin 文本按 locale 生成（zh 现文案原样保留为 zh-CN 分支；en 分支新增英文 pin）；无 DB 行时默认 `zh-CN` —— 默认不变 = 回归锚 byte-identical。

### 2.3 迁移期双读与 removal

- 迁移窗口内 env→DB：**一次 seeding**（migrate 或 CLI）把「env 显式设过且非 default」的 key 灌进 DB（journal action='seed', actor='migrate'），之后 env 只作 fallback。AGENTS.md compose 教训（census §4.1）：真 env > .env 三级，seeding 必须读**进程 env**（`createServerEnv`/`process.env`），不读 .env 文件。
- env 名永久保留作 fallback 层（operator 逃生通道：DB 挂了 env 仍兜住）；**不删 env schema 条目**（env.ts ~110 keys 原样，迁移项的 schema 行不动——schema 是 boot 验证层不是真相层）。

---

## §3 迁移分级（tier A / B / C）

判级标准：**tier A** = reader 已是 per-call（含 `env` 形参注入），换读 `getConfig*` 即通电，工作量以「行」计；**tier B** = module-load 快照或编译期常量，需把读点迁成函数/消费点分层，工作量以「消费点个数」计；**tier C** = 结构上不可热（boot 对象、DB schema、编译期常量、学术常数），保留硬编码并写明理由。

### Tier A — per-call readers（~26 项，逐条 file:line 已核对）

| 项 | reader 位置 | 备注 |
|---|---|---|
| `JUDGE_DURABLE_ENABLED` | `judge-durable-config.ts:28-30` | parseFlag |
| `JUDGE_FALLBACK_PROVIDER` | `judge-durable-config.ts:51-81` | 含三道闸降级——DB 化后保留降级（坏行 warn） |
| `MISCONCEPTION_HARD_CONFIRM_ENABLED` | `agency/server/misconception-promote.ts:91` | parseFlag |
| `QUESTION_SUPPLY_REFILL_ENABLED` | `practice/server/question-supply/refill.ts:75-78` | parseFlag |
| `CONFUSABLE_CONTRAST_ENABLED` | `practice/server/question-supply/confusable-contrast-discovery.ts:51` | parseFlag |
| `RESEARCH_MEETING_AGENT_ENABLED` | `agency/jobs/research_meeting_agent_nightly.ts:50,335` | parseFlag |
| `JUDGE_CALIBRATION_SAMPLING_ENABLED` | `practice/jobs/judge_calibration_sample.ts:70` | parseFlag + env echo |
| `JUDGE_CALIBRATION_REJUDGE_PROVIDER/MODEL/BATCH_MAX/WINDOW_DAYS` | `practice/jobs/judge-calibration-config.ts:39-40` 等 | lane override 对象 |
| `WORKFLOW_JUDGE_OBSERVE_ENABLED` / `STUDENT_ANSWER_GRADING_ENABLED` / `AUTO_ENROLL_THRESHOLD` | `ingestion/server/workflow-judge-config.ts:102-133` | env 形参，阈值 clamp [0,1] |
| `WAVE6_TRIGGER_*_ENABLED` ×4 | `notes/server/note-refine-triggers.ts:15-19` | per-kind env map；verify 是 opt-in |
| `NOTES_MASTERY_SUBSCRIPTION_ENABLED` | `notes/server/mastery-progress-subscription.ts:17` | env 形参 |
| `AUTO_INTERVENTION_EXPANSION_ENABLED` + `INTERVENTION_DISABLED_METHOD_IDS` | `agency/server/intervention/snapshot.ts:27,71-92` | env 形参；CSV→zod array |
| `COPILOT_SUBAGENT_ENABLED` | `copilot/server/subagents.ts:23,130` | env 形参，opt-out 默认 on |
| `COPILOT_NUDGE_*` ×5 | `copilot/server/nudge-config.ts:30-37` | `loadNudgeConfig(env)` 一把抓 |
| `SELECTION_POLICY` | `practice/server/stream-store.ts:518-521` | enum legacy/softmax_mfi |
| `HUB_SYNC_MODE` | `notes/server/hub-sync-reconciliation.ts:684` | enum；**P2 风险**——architecture.md:764 记录 off 不是完整 kill switch（触发器照常记账），面板文案必须带这句 |
| `MEMORY_RECONCILE_HANDOFF_MODE` | `server/memory/memory-reconcile-handoff.ts:31-46` | enum，现 throw-on-invalid → 写端 422 |
| `PROJECTION_IS_WRITER_ITEM_CALIBRATION` | `server/projections/sot-flag.ts:3-21` | '1' 字面量；**P2** 写所有权 |
| `AI_PROVIDER_SESSION/ATTEMPT_ADMISSION_MODE` + `*_POLICIES_JSON` | `server/ai/provider-session-admission.ts:86-87,226-232`、`provider-attempt-admission-config.ts:44-56` | env 形参 + zod PoliciesSchema 现成——schema 直接搬 registry；**P2** enforce 断流 |
| `AI_RATE_LIMIT_MAX` / `WINDOW_MS` | `server/http/rate-limit.ts:29-34` | resolveConfig() |
| `CLAUDE_CODE_MAX_RETRIES` | `server/ai/pi-agent-adapter.ts:103` | |
| `VERIFY_SOLVE_*` | `practice/server/quiz/solve-lane.ts:57-105` | lane override；fail-open 预检沿用 |
| `VISION_JUDGE_PROVIDER/MODEL` | `server/ai/vision-judge-config.ts:100-117` | env 形参，degrade-to-undefined 语义保留 |
| `AI_PROVIDER_OVERRIDE` / `AI_PROVIDER_MODEL` | `server/ai/providers.ts:472-483` `readEnvOverride()` | 全局 pin；DB 化映射到 `lane.global.*`（**P2**，见 §4 顺序决策） |
| `JYEOO_*`（binary/spawn/backfill/stdout/stderr/budget） | `practice/server/question-supply/jyeoo-supply-config.ts:23-73` + `jyeoo-budget.ts:21-23` | 调用时读 |
| `MEM0_*`（llm/embedding model、base_url、dims、collection、hnsw、telemetry、history path） | `server/memory/client.ts:16-25,154-163` + `server/ai/embed.ts:29,151` | env 形参；**dims 改=重建 collection**，schema 允许但面板高风险确认（P2） |
| `EXTRACT_OCR_ENGINE` | `capabilities/ingestion/jobs/tencent_ocr_extract.ts:248` | enum；census 路径旧（`server/`→`jobs/`），以此为准 |
| `DOCX_CONVERT_ENGINE` | `ingestion/server/docx/convert.ts:63-68` | 'docker' 探针 |
| `BACKUP_IMPORT_MAX_BYTES` | `observability/api/backup-import.ts:24-39` | floor 1MB；census 路径旧（`server/`→`api/`） |
| `SKIP_BOSS_INGEST` | boss ingest 入口（env.ts:124 schema） | non-empty=truthy |
| `ANTHROPIC_SUB_DEFAULT_MODEL` / `OPENAI_ASTRA_MODEL_ID` | `providers.ts:271,275` | 编译期常量但**每次调用读**——P2 候选 config key，改动即生效无需重启 |

工作量：每项 ≈ reader 替换 + 测试 mock seam 改 `setTestConfig`（§6）。tier A 全组估 **S/M 级**（最大头是 admission policies + mem0 组）。

### Tier B — 需结构改造（~8 组）

| 组 | 位置 | 改造 |
|---|---|---|
| `PLACEMENT_PROBE_ENABLED` | `server/session/placement.ts:42` → 4 消费点（§2.2 形态 B 列表） | const→函数；envPinned（compose 强制）；mock seam 换 config snapshot |
| `MATCH_THRESHOLD` + `RETRIEVAL_TOP_K` | `knowledge/server/tagging-flags.ts:52,63` | export const → `matchThreshold()`；YUK-677 calibration 脚本读同函数（文件注释 :60-61 已有此约定——迁后仍成立） |
| `KC_DEDUP_*` ×3 | `knowledge/server/dedup-flags.ts:84-97` | 同上；「≤0=静默禁用」规则进 zod min(1)/positive，不再只靠 fallback |
| TaskSpec provider/model/budget ×52 | `ai/task-catalog.ts:104-117` + `resolveTaskProvider` + runner 4 处 budget 读点 | §2.2 形态 C；catalog 保持 freeze（它是默认档），DB 层只在 resolve 链上 |
| `LEARNER_LOCALE_PIN` → `locale.learner` | `ai/task-prompts.ts:30-46` | §2.2 形态 C；buildLocalePin 分支化 |
| `temperature: 0.1` ×2 | `server/memory/reconcile-llm.ts:401`、`knowledge/server/edge-reconcile.ts:435` | hardcoded→config key（`llm.reconcile.temperature`，P2） |
| `SKIP_BOSS_INGEST` / `sot-flag`/`warnFlipOrder` 读面 | `server/projections/sot-flag.ts` | `projectionIsWriter` per-call 已成立，仅换读 API |
| UI `zh-CN` ×4 + `Asia/Shanghai` | `web/…DraftReviewPage.tsx:163` 等 / 全 cron | **tier B 但选不做**——locale 消费在浏览器渲染端，无 i18n 框架（census §1.D）；`zh-CN` 四处读一个 `web` 常量可行但与 DB 无关；归入「不热化」清单 §3.C.4 批注 |

工作量：reader 函数化 = 小；TaskSpec override 链 = M（新层 + 测试）；locale = S。

### Tier C — 不可热 / 不热（写明理由，达成「降低而非归零」）

1. **drizzle schema / migrations**：表结构本身=build artifact；改列要 migration，无热路径。
2. **queue tier 常量**（`boss/queue-config.ts:40-63`：`EXPIRE_*`/`RETENTION_7D`/`JOB_RETRY_*`）：createQueue 在 worker boot 注册时落 pg-boss 行；改值需重跑 queue reconcile——技术上可热（updateQueue）但语义是部署级，判 tier C boot-bound（理由：queue 参数变更应跟发布节奏走，面板旋钮无 owner 场景）。
3. **orchestration 常量**（`orchestration/constants.ts`：anchor 02:30 / catchup 5h / tick / NODE_TIMEOUT / LAYER_STAGGER）：DAG 语义参数；cron 注册发生在 boot + pg-boss schedule，热改要重建 schedule——同 2，boot-bound。
4. **cron schedules ×15 + `Asia/Shanghai` tz**：manifest 静态声明 + pg-boss cron 表；热改=schedule 管理功能（远期 P2 per-job 启停，census §3 P2），首批不做。
5. **const flags ×11**（ledger B2：SRT_*/THETA_GRID/POLY_SIGMOID…）：学术实验开关，改动=代码决策（census §1.B2 明确 P0 view-only）；**不算「硬编码率」负担**——它们是研究常量不是配置。
6. **学习模型常数**（theta.ts DIFFICULTY_PROXY_WEIGHT/ELO_K_GLOBAL、pfa.ts GAMMA/RHO、selection-constants CANDIDATE_CAP、MATCHER_COSINE_MAX_DISTANCE、SOLVE_CHECK_SEMANTIC_THRESHOLD 等 C2 组）：同 5——科学常数热改会破坏 run 间可比性与 calibration 语义（YUK-677 校准 replay 依赖固定锚）。列「可迁移但默认不迁」清单，owner 显式点名才进 config key。
7. **compiled contract**：Provider union（task-spec.ts:4-12）、PROVIDERS 注册表 wiring（providers.ts:79-248，baseUrl/authMode/env 名）、`IMPLEMENTED_KEY_PROVIDERS`（:330-336）——provider 增删=wire shape 代码工作（YUK-608/921/1027 注释），不是配置。
8. **secrets / boot 输入**：`*_API_KEY`、`INTERNAL_TOKEN`、`DATABASE_URL`、`API_PORT`、db pool max（`db/client.ts`）、`VITEST`/`NODE_ENV`、R2/TENCENT/MEM0 credentials、`JYEOO_RS_BINARY` 外的 script-only 组——永留 env（census §3 storage-3 + §2.7）。
9. **design tokens / UI 文案 / i18n**：`globals.css`、内联中文——编译期；UI i18n 是另一个量级工程（census §1.D）。
10. **`VITE_*`**：零消费方（README:76 / census §1.E）。

**tier 统计**：A ≈ 26 组（覆盖 ~40 运行时旋钮的绝大多数）· B ≈ 8 组（含 TaskSpec/locale 两大目标面）· C 10 类。**净效果**：census §2「~40 运行时旋钮」中除 3 条 compose-pinned 外全部可热；52 task 的 model/provider/budget 全部可热；80+ hardcoded 中属「配置性质」的 ~10 项（temperature×2、MATCH_THRESHOLD、RETRIEVAL_TOP_K、misc caps）可迁移，其余属研究/部署常数不动——硬编码率下降落在「运营旋钮」域。

---

## §4 面板含义（对 preflight §4.2 的修订）

preflight §4.2 按「env+restart」现状设计了「重启生效（启动期快照）」徽标 + 写控件禁用规则。hot-reload 落地后逐项重判：

| preflight 写项类 | 原标注 | hot-reload 后 |
|---|---|---|
| per-task provider/model override | 「下次调用生效」 | **不变**——但条件从「待插 DB 层」变为既有链 + `getTaskOverride`；写控件从第一天可启用 |
| per-task budget override | 「依赖 budget 读路径改造，未改造前禁用」 | 改造落点改为 runner 既有 `ctx.budgetOverride` seam + `run-lifecycle.ts:691` transientRetries 一处（§2.2 C）——比原估的「读路径改造」小一档；仍列为 tier B |
| scoped lane override ×4 | 「迁移后下次调用生效」 | 同 per-task：lane reader 全 tier A，首批即可写 |
| env flag 组 | 「按 reader 类型逐条标注；module-load 快照标重启」 | **「启动期快照（重启生效）」徽标整批消失**——tier B 快照项迁成函数后归 tier A 语义。唯一保留「不可写」的是 3 条 compose-pinned（`PLACEMENT_PROBE_ENABLED`、`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`、`MISCONCEPTION_PROMOTE_ENABLED`），但理由是 `envPinned` 而非快照 |
| 阈值组 | 同上 | `WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD`/`COPILOT_NUDGE_*` 全 tier A → 「下次调用生效」（含 ≤15s 窗口注记，§6） |
| AI 输出语言 | 「getTaskSystemPrompt 改读 locale 前禁用」 | tier B locale 落地后 → 「下次 prompt 构建生效」（每次调用，无窗口——config snapshot 已在内存） |
| UI 语言 | 「本批不可写，disabled + future tag」 | **不变**——无 i18n 框架属 tier C.9 |

**徽标映射修订**（preflight §6.1）：`重启生效`/`启动期快照` 两个 tone 的**有效行数趋零**（只剩 tier C 的 rebuild-only `neutral` 与 compose-forced `again`）；`DB-live` 徽标语义从「subject profile 60s」泛化为「config ≤15s」。`生效时机` 列新增 `≤15s（config refresh）` 枚举值替换 `per-call`——更诚实，因为读的是快照不是 DB。

**读面 `source` 列**（preflight §10.2 `'process-env'|'compose-forced'|'code-default'|'db'|'unset'`）原样适用——`getConfigSource(key)` 直供。

## §5 Rollout / bootstrap

### 5.1 启动顺序（app 与 worker 共用）

```
1. loadEnv（server/env.ts）→ 填 process.env —— env fallback 层就位
2. createServerEnv() 校验（env.ts:152-166）—— boot 验证不变
3. db client 建立（DATABASE_URL 仍 env）
4. hydrateConfigFromDb(db) —— 首批 config snapshot 入内存
     · never-throws：表未建（migration 未跑）→ WARN + 空快照（= 纯 env 行为，
       与今天 byte-identical —— 这就是 rollback 故事）
5. startConfigRefresh(db, 15_000) —— interval unref
6. app: serve / worker: startBossWorker（其内部 hydrateSubjectRegistryFromDb
   + startSubjectRefresh 保持原位，两体系互不依赖）
```

worker 挂载点：`src/server/boss/start-worker.ts:22-27`（`startBossWorker` 头部，`hydrateSubjectRegistryFromDb` 旁——同一模式两处先例并排）。app 挂载点：`server/index.ts:37-43` `hydrateSubjectsBeforeServe` 同 seam（函数改名/加 config 一步）。

### 5.2 env→DB 迁移窗口

- **seeding**：一次性 migrate 脚本（或首个 migration SQL）对 registry 内每个 env-migratable key 读 `process.env`；显式值 ≠ code default → 写 DB 行（journal action='seed', actor='migrate'）。**读进程 env 不读文件**（census §4.1 红线在 seeding 同样成立——compose `environment:` 也要被采进去）。
- compose-pinned 三键**不 seed**：registry `envPinned=true` 跳过。
- **回滚**：`clearConfig`（或 SQL `TRUNCATE system_config`）→ 全 key 回落 env/default，行为退到迁移前。config 表是叠加层，不是迁移不可回退。
- **顺序安全**：worker/app 任一侧先升级都无妨——未升级侧继续读 env（值仍有效，因为 seeding 不改 env）；升级侧 DB 行为空时也读 env。双进程窗口期内语义一致 = env 值。

### 5.3 与 subject profile refresh 的关系

两套 hydrate/refresh 体系并存（subject：60s 周期 + 写后即时；config：15s 周期 + 写后即时）。**不合并**：subject 是六表装配（hydrate.ts:167-172 四表 join + trait 解析），config 是单表 map——成本、失效语义、never-throws 地板都不同（subject 地板=代码种子；config 地板=env+code default）。

---

## §6 风险与对策

### 6.1 热路径读（per-attempt scoring / judge 判定）

判分/选题路径每次调用都会读 flag/阈值（如 `judgeDurableEnabled()` 在 submit 分流、selection policy 在每次选题、`resolveTaskProvider` 在每次 dispatch）。**内存快照读 = Map.get，零 DB 成本**——这是选「同步快照+周期 refresh」而非「每读一次查 DB」的直接原因。成本只发生在 15s 一次的 epoch 探测 + 全量 reload（~150 行），与 subject hydrate（6 表装配，60s）相比轻一个量级。风险残留：**refresh 定时器本身若 hang**（DB 慢查询），快照继续用 last-good——不阻塞业务，只推迟生效，符合 never-throws 先例（hydrate.ts:305-309）。

### 6.2 Stale window（≤15s）

- 语义标注：UI 写操作成功后文案 = 「≤15s 内全进程生效（本进程即时）」；读面 `effect` 枚举 `config-refresh`。
- **panel 写后 self-read**：写路径 commit 后即时 hydrate（§1.4），写者所在进程 0 延迟；对面板「写入后立即回读显示生效值」无坑。
- **worker 滞后窗**：worker 无写路径，纯靠 15s refresh——窗口内 worker 还在用旧值。对 flag 类（kill switch）15s 滞后可接受（kill switch 翻 ON 的语义是「渐开」）；对 `MEMORY_RECONCILE_HANDOFF_MODE`/`HUB_SYNC_MODE` 这类模式机，15s 内 app/worker 可能短暂异模——这两个本来就在 P2 风险组，面板文案需带「双进程收敛窗 ≤15s」。
- **替代方案**（记录不选）：pg `LISTEN/NOTIFY`——pg-boss 已持连接但 LISTEN 需要常驻独立连接 + 重连逻辑，引入第一处持久订阅管道，与「无 IPC/无 Redis」最小充分原则冲突；epoch+15s 已够。

### 6.3 并发写（app/worker 双进程）

- 行级 upsert + journal + epoch bump 同 tx——两进程同 key 写 = 最后一次赢，journal 双方都在（revision 各自递增，PK(key,revision) 无碰撞）。
- **无乐观锁**：单用户 admin 面（TokenGate/internal-token gate），并发编辑同 key 不是真实场景；若要做，`expected revision` 可选参数一行 SQL 即可（`WHERE revision = $exp`），列入后续增强不阻塞。
- **写端 schema 校验先于 tx**（§1.4）——非法值连 journal 都不留。

### 6.4 测试注入

- 单例快照不能 `vi.stubEnv` 式点射——提供 `setTestConfig({key: value...})` / `resetTestConfig()`（写进内存快照，不进 DB），单测语义与 `vi.stubEnv` 对齐（describe 内 set / afterEach reset）。
- 现有 getter-mock 面（`PLACEMENT_PROBE_ENABLED` 两处、`EARLY_KLP` 模式先例、kc-dedup `vi.spyOn`）在 tier B 迁移时统一换成 `setTestConfig`——**迁移 diff 必须同步更新这些测试**，不得保留对旧 const 的 getter mock（mock 一个不存在的 export = 假绿）。
- db 测试：真写 `system_config` 行 + `hydrateConfigFromDb(db)` 断言生效 —— 对应 `trait-write.db.test.ts` 的「写后 hydrate」先例。
- `tests/helpers/db.ts:237` 清表清单 + `src/server/export/constants.ts:74` 备份表序：新增两表需登记（journal 紧随主表，`subject_trait` → `subject_trait_journal` 的先例 constants.test.ts:93-144 已断言表序——新表进同组检查）。

### 6.5 其余已识别风险（摘要）

| 风险 | 对策 |
|---|---|
| DB 行手工注入坏值 | hydrate 逐行 schema parse，坏行 skip+WARN+落 env/default（never-throws） |
| config 表未建（migration 未跑）升级代码 | hydrate 42P01 → 空快照 → 纯 env 行为，rollback 天然成立（§5.2） |
| MEM0 dims 热改 | schema 放行但 P2 高风险确认 + 文案「需重建 collection」（census §3 P2 原判） |
| admission `enforce` 断流 | P2 组，高风险确认条（preflight §5 已分级） |
| `lane.global.*`（DB 版 AI_PROVIDER_OVERRIDE） | P2；且须与 env pin 的优先级对齐 §2.2 ordering decision，避免两级互相穿透 |
| cron/schedule 热改诱惑 | tier C.4 明确不做；远期 per-job 启停走 pg-boss 自己的 schedule API，不进本 config 表 |

---

## 报告摘要（给 orchestrator）

- **文件**：`docs/planning/2026-09-26-yuk1007-hot-reload-config.md`（本文）
- **tier 统计**：A ≈ 26 组（~40 运行时旋钮绝大多数）· B ≈ 8 组（含 TaskSpec override 链 + locale）· C 10 类（schema/queue/orchestration/cron/const flags/学习常数/contract/secrets/UI tokens/VITE_*）
- **判为不可热清单**：drizzle schema、queue tier（boot reconcile）、orchestration 常量、15+ cron schedule、11 const flag（学术开关）、学习模型常数（calibration 锚）、Provider union/wiring、secrets/boot 输入、design tokens/i18n、VITE_*——理由：build artifact / boot 对象 / 研究常数 / 契约常量，「降低硬编码率」落在运营旋钮域而非归零。
- **Store API 草案**：`getConfig(key)` / `getConfigFlag(key)` / `getConfigSource(key)` / `getTaskOverride(kind)` / `getLaneOverride(lane)` + `setConfig/clearConfig`（journal+epoch tx）+ `hydrateConfigFromDb` / `startConfigRefresh(15s)` + `setTestConfig`。
- **Bootstrap 顺序**：loadEnv → env schema → db → hydrateConfigFromDb → startConfigRefresh → serve/worker；seeding 读进程 env；空表=纯 env 行为=天然 rollback。
- **未决 ordering decision**（§2.2）：DB per-task override vs env global pin 的优先级——推荐 `arg > env global > DB task > registry`，若 owner 认为面板写的 per-task 应穿全局 pin 则翻转两层。
- **census 勘误**（ lane 以此为准）：`EXTRACT_OCR_ENGINE` 实际在 `capabilities/ingestion/jobs/tencent_ocr_extract.ts:248`（非 `server/`）；`BACKUP_IMPORT_MAX_BYTES` 实际在 `capabilities/observability/api/backup-import.ts:24-39`（非 `server/`）。
