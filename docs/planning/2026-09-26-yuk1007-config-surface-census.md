# YUK-1007 配置面普查（system-config grounding census）

- 日期：2026-09-26
- 票据：YUK-1007（统一配置面板：per-task AI 模型、系统偏好、语言）
- 性质：普查文档（census），不含 UI 设计、不含 schema 提案（仅 §3 末尾
  简述 storage options）。所有条目均带真实 file:line。
- 基线：`git HEAD = 6d87cebb9`

---

## §1 配置面总览表

表列：`名称 | 当前值/默认 | 声明处 | 读取时机 | 消费方 | 运行时可改? | 面板分区 | 风险`

`运行时可改` 语义：**env+restart** = 改 env 文件后重启生效；**boot-const** =
进程启动期快照，改 env 也不会热更新；**rebuild** = 编译期常量，需改代码；
**DB-live** = 数据库值，读路径每次/短周期刷新。

### A. AI 模型 / provider / per-task 配置（YUK-1007 核心目标面）

| 名称 | 当前值/默认 | 声明处 | 读取时机 | 消费方 | 运行时可改? | 面板分区 | 风险 |
|---|---|---|---|---|---|---|---|
| TaskSpec × 52 | provider 全部 `xiaomi`；41× `mimo-v2.5-pro` + 11× `mimo-v2.5` | `src/ai/task-catalog.ts:104-117`（期望数 52）；各 `src/ai/tasks/*.ts`（33 个文件） | 模块加载 freeze | 全部 AI task dispatch | rebuild | P1 writable（per-task model/provider/budget） | 高：核心能力面，改错影响所有任务 |
| DEFAULT_TASK_BUDGET | maxIterations 6, maxCost 0.5, retries 0, timeout 60s | `src/ai/task-spec.ts:35-60` | 模块加载 | 无 per-task 覆盖时的兜底 | rebuild | P1 | 中 |
| per-task budget 覆盖 | maxIterations 1–8, timeout 60k–180k, transientRetries 1（两个 vision judge） | 各 task spec 文件 | 模块加载 | 对应 task | rebuild | P1 | 中 |
| `AI_PROVIDER_OVERRIDE` / `AI_PROVIDER_MODEL` | unset | `src/server/ai/providers.ts:508-608` `resolveTaskProvider` | 每次调用 | 全部 task（全局 override） | env+restart | P2 advanced | 高：覆盖优先级高于 registry |
| provider 注册表 | 8 provider；openrouter/gateway 保留未实现 | `src/server/ai/providers.ts:79-248` PROVIDERS | 模块加载 | resolveTaskProvider | rebuild | P0 view | 中 |
| `providerRequiresExplicitModel` / `crossoverModelForProvider` | — | `src/server/ai/providers.ts:402,421` | 调用时 | crossover 路由 | rebuild | P2 | 中 |
| `ANTHROPIC_SUB_DEFAULT_MODEL` | `claude-opus-4-8` | `src/server/ai/providers.ts:271` | 调用时 | anthropic-sub | env+restart | P2 | 中 |
| `OPENAI_ASTRA_MODEL_ID` | — | `src/server/ai/providers.ts:275` | 调用时 | astra provider | env+restart | P2 | 中 |
| `VERIFY_SOLVE_PROVIDER_OVERRIDE` / `VERIFY_SOLVE_MODEL_OVERRIDE` | unset | `src/capabilities/practice/server/solve-lane.ts:39-61` | 调用时 | verify solve lane | env+restart | P1 | 中 |
| `VISION_JUDGE_PROVIDER` / `VISION_JUDGE_MODEL` | unset | `src/capabilities/practice/server/vision-judge-config.ts` | 调用时 | vision judges | env+restart | P1 | 中 |
| `JUDGE_FALLBACK_PROVIDER`（默认 anthropic-sub）+ `JUDGE_DURABLE_ENABLED` | unset | `src/capabilities/practice/server/judge-durable-config.ts` | 调用时 | judge fallback | env+restart | P1 | 中 |
| `JUDGE_CALIBRATION_REJUDGE_PROVIDER/MODEL/BATCH_MAX(≤50,def20)/WINDOW_DAYS(1-90,def7)` | unset | `src/capabilities/practice/jobs/judge-calibration-config.ts` | 调用时 | calibration rejudge | env+restart | P2 | 低 |
| `AI_PROVIDER_SESSION/ATTEMPT_ADMISSION_MODE` + `*_POLICIES_JSON` | off/observe/enforce | `src/server/ai/provider-session-admission.ts`, `provider-attempt-admission-config.ts` | 调用时 | provider admission | env+restart | P2 | 高：enforce 可断流 |
| `CLAUDE_CODE_MAX_RETRIES` | 2 | `src/server/ai/pi-agent-adapter.ts:103` | 调用时 | claude-code adapter | env+restart | P2 | 低 |
| `AI_RATE_LIMIT_MAX` / `AI_RATE_LIMIT_WINDOW_MS` | 30 / 10s | `src/server/http/rate-limit.ts:19-33` | 调用时 | /api AI routes | env+restart | P2 | 中 |
| `MIMO_VISION_BASE_URL` / `MIMO_VISION_MODEL` | unset | `scripts/preflight-vision.ts:37-39` | 脚本启动 | preflight 脚本 | script-only | 不上面板 | 低 |
| provider API keys（XIAOMI/ANTHROPIC/OPENAI/…） | .env | `src/server/env.ts` server schema | boot | providers.ts | env+restart | 不上面板（secret） | 高：绝不进 UI |
| LLM `temperature: 0.1` 硬编码 | 0.1 | `src/server/memory/reconcile-llm.ts:401`, `src/capabilities/knowledge/server/edge-reconcile.ts:435` | 调用时 | reconcile LLM | rebuild | P2 | 低 |

### B. 功能开关（flags）— 双轨制

权威台账 `scripts/audit-flags-ledger.json`（245 行）= 27 flags：16 env flag +
11 compile-time const。扫描器 `scripts/audit-flags.ts`。解析文法
`src/core/env-flags.ts` `parseFlag`（`true/1` 开、`false/0` 关、其他取默认）。

#### B.1 env flags（ledger 内，16）

| 名称 | 默认 | 面板分区 | 风险 |
|---|---|---|---|
| CONFUSABLE_CONTRAST | on | P1 | 中 |
| MISCONCEPTION_PROMOTE / MISCONCEPTION_HARD_CONFIRM | on / — | P1 | 高：compose mac 强制 true（见 §4） |
| AUTO_INTERVENTION_EXPANSION | on | P1 | 中 |
| RESEARCH_MEETING_AGENT | on | P1 | 中 |
| PLACEMENT_PROBE | on（boot-const，见 §4） | P1 | 中 |
| QUESTION_SUPPLY_REFILL | on | P1 | 中 |
| NOTES_MASTERY_SUBSCRIPTION | opt-out（默认 on） | P1 | 中 |
| WORKFLOW_JUDGE_AUTO_ENROLL / OBSERVE / STUDENT_ANSWER_GRADING | 各异 | P1 | 高：compose mac 强制 true |
| WAVE6_TRIGGER_MARK_WRONG / MASTERY / DREAMING | opt-out 默认 on | P1 | 中 |
| WAVE6_TRIGGER_VERIFY | opt-in 默认 off | P1 | 中 |
| COPILOT_NUDGE | on | P1 | 低 |
| COPILOT_SUBAGENT | opt-out 默认 on | P1 | 中 |
| JUDGE_CALIBRATION_SAMPLING / JUDGE_DURABLE | on | P1 | 低 |

#### B.2 const flags（ledger 内，11，rebuild-only）

ON：`SRT_ENABLED`, `SRT_HIERARCHICAL_ELO`, `SRT_EARLY_KLP`,
`SRT_RECOMPUTE_BADGE`。OFF：`DAY_ONE_PRIOR`, `GRAPH_LAPLACIAN`,
`MISCONCEPTION_RECURRENCE`, `POLY_SIGMOID`, `PREREQ_RISK_EMIT`,
`PREREQ_THETA_PROPAGATION`, `SRT_FISHER_WEIGHT`, `THETA_GRID`。
面板定位：**P0 view-only**（学术实验开关，改动=代码决策，不适合 UI 写）。

#### B.3 台账外的 env/mode 开关（~10，散落在 ledger 之外）

| 名称 | 值域/默认 | 声明处 | 面板分区 | 风险 |
|---|---|---|---|---|
| `PROJECTION_IS_WRITER_ITEM_CALIBRATION` | `'1'` 字面量；其余 7 实体走 canonical | `src/server/projections/sot-flag.ts:3-21` | P2 | 高：写所有权切换，误开=数据双写 |
| `HUB_SYNC_MODE` | off/apply | `src/capabilities/notes/server/hub-sync-reconciliation.ts:684` | P1 | 高：apply 模式写 hub |
| `SELECTION_POLICY` | legacy vs `softmax_mfi`（默认） | `src/capabilities/practice/server/stream-store.ts:522` | P2 | 高：选题策略切换 |
| `MEMORY_RECONCILE_HANDOFF_MODE` | observe/write/recover/drain | `src/server/memory/memory-reconcile-handoff.ts:32` | P2 | 高：写模式状态机 |
| `INTERVENTION_DISABLED_METHOD_IDS` | CSV of method ids | `src/capabilities/agency/server/snapshot.ts:72` | P1 | 中 |
| `EXTRACT_OCR_ENGINE` | glm \| tencent | `src/capabilities/ingestion/server/tencent_ocr_extract.ts:248` | P1 | 中 |
| `DOCX_CONVERT_ENGINE` | docker-only | `src/capabilities/ingestion/server/docx/convert.ts:67` | P2 | 低 |
| `SKIP_BOSS_INGEST` | non-empty=truthy | boss ingest 入口 | P2 | 中 |
| `VITEST` / `NODE_ENV` test gates | — | `src/server/runtime-env.ts:31`, `src/server/boss/client.ts:93` | 不上面板 | — |

### C. 数值阈值 / budget / 旋钮

#### C.1 env-tunable（改 env+restart 生效；部分 boot-const 见 §4）

| 名称 | 默认 | 声明处 | 面板分区 |
|---|---|---|---|
| `TAGGING_MATCH_THRESHOLD` | 0.55 | `src/capabilities/knowledge/server/tagging-flags.ts:43-52` | P2 |
| `KC_DEDUP_DISTANCE_MAX/WINDOW_DAYS/MAX_PAIRS` | 0.1 / 7 / 50 | `src/capabilities/knowledge/server/dedup-flags.ts:40-97` | P2 |
| `WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD` | 0.85 clamp [0,1] | `src/capabilities/ingestion/server/workflow-judge-config.ts:58,102` | P1 |
| `JYEOO_*` spawn/budget 一组 | — | `src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts`, `jyeoo-budget.ts:22` | P2 |
| `BACKUP_IMPORT_MAX_BYTES` | ~1GB，floor 1MB | `src/capabilities/observability/server/backup-import.ts:24-43` | P2 |
| `COPILOT_NUDGE_*` | 5 个旋钮 | `src/capabilities/copilot/server/nudge-config.ts:30-37` | P1 |
| `MEM0_*`（model `glm-5.2`、embedding `text-embedding-v4`、1024 dims、collection `learning_project_memories`） | 全可 env 覆盖 | `src/server/memory/client.ts` | P2 |

#### C.2 hardcoded const（rebuild-only；P0 view 或不上面板）

| 名称 | 值 | 声明处 |
|---|---|---|
| queue tiers | EXPIRE_FAST/LLM 3600s, EXPIRE_AGENT 7200s, RETENTION_7D 604800, JOB_RETRY_LIMIT 2, JOB_RETRY_DELAY 30s | `src/server/boss/queue-config.ts` |
| orchestration | anchor 02:30 Asia/Shanghai, catchup 5h, TICK 60s, NODE_TIMEOUT 7h, LAYER_STAGGER 120s/15m | `src/server/orchestration/constants.ts` |
| context budgets | COPILOT_HISTORY / LEARNER_STATE_HEADER / PROPOSAL_FEEDBACK / BRIEF_REFRESH / LONG_TERM_FRESHNESS 等 | `src/kernel/tools/budgets.ts` |
| 学习模型参数 | DIFFICULTY_PROXY_WEIGHT .3, ELO_K_GLOBAL .048, SRT_* 一组, eloK defaults | `src/core/.../theta.ts` |
| PFA | PFA_GAMMA .5, PFA_RHO −.25, LOW_CONFIDENCE_SE 1.0 | `src/core/.../pfa.ts` |
| selection | DEFAULT_TEMPERATURE 0.25, MEM0_PRIOR caps, CANDIDATE_CAP 24 | `src/capabilities/practice/server/selection-constants.ts` |
| matcher | MATCHER_COSINE_MAX_DISTANCE 0.35 | `matcher.ts` |
| verify | SOLVE_CHECK_SEMANTIC_THRESHOLD 0.8 | `verify-framework.ts` |
| embed | EMBED_MODEL / EMBED_DIMS / EMBED_MAX_BATCH | `src/server/memory/embed.ts` |
| db pool | max 10 | `src/server/db/client.ts` |
| 杂项 caps | FAMILY_MIN_EVIDENCE, RECALIBRATION_MIN_LABELS 12, DEFAULT_P_T/P_S/P_G, VERDICT_* rate limits, DEDUP_OVERLAP_THRESHOLD 0.7, FATIGUE_REPETITION_LIMIT 2, PLACEMENT_DEFAULT_CAP 8, IDLE_MS 5min, STUCK_RUN_THRESHOLD_MS 1h, EDITING_* timeouts, AUTO_ENROLL_SINGLETON_SECONDS 60 / MAX_BLOCKS_PER_RUN 10, NOTE_REFINE_TRIGGER_DEBOUNCE_MS 1h | 各文件（详见普查原始记录） |

### D. 语言 / 地区（YUK-1007 语言目标面）

| 名称 | 当前值 | 声明处 | 读取时机 | 运行时可改? | 面板分区 | 风险 |
|---|---|---|---|---|---|---|
| `LEARNER_LOCALE_PIN` | 硬编码简体中文后缀，附加到**每个** task prompt | `src/ai/task-prompts.ts:30-46` | 每次 prompt 构建 | rebuild | P1 writable（= per-user locale 落点） | 高：全局语言行为 |
| `subjectProfile.languageStyle` | e.g. '中文讲解…' per-subject | `src/capabilities/subjects/server/profile-schema.ts:63` | profile resolve | DB-live（60s refresh） | P1 | 中 |
| UI 日期 locale | `zh-CN` 硬编码 ×4 | `web/.../DraftReviewPage.tsx:163`, `AutoEnrolledPanel.tsx:440`, `KnowledgeDetailPage.tsx:77`, `CopilotDock.tsx:1536` | render | rebuild | P1 | 低 |
| cron tz | 全部 `Asia/Shanghai` | 各 manifest + `orchestration/register.ts:245` | 调度注册 | rebuild | P0 view | 低 |
| i18n 框架 | **无**，UI 字符串全为内联中文 | — | — | — | —（YUK-1007 范围外的大工程） | — |

### E. 运行形态 / 运维面

| 名称 | 默认 | 声明处 | 面板分区 |
|---|---|---|---|
| `API_PORT` | 8787 | `server/index.ts` | 不上面板 |
| env schema | ~110 keys（`server` 对象 `src/server/env.ts:6-148`）；`SERVER_ENV_KEYS` :150；`createServerEnv`/`getServerEnv` :152-166；`requireApiInternalToken` :168 | `src/server/env.ts` | 不上面板（schema 本身） |
| env loader | .env.local → .env 优先级，只填 unset，真实 env 优先 | `server/env.ts` `loadEnv` | — |
| script-only envs | `LLASA_*`, `PRIOR_REPS_*`, `AUDIT_READ_DATABASE_URL`, `B3_GATE_CONFIRM_CLONE`, `SEED_SYNTHETIC_OK`, `PROFILE_CRITIC_OK`, `EXA_API_KEY`（`.env.local.example`） | scripts/* | 不上面板（标记 ops-only） |
| `INTERNAL_TOKEN` | 客户端 `TokenGate.tsx` 本地存储 | `web/.../TokenGate.tsx` | 已有局部 surface |
| `VITE_*` | **零消费方**（README:76） | — | — |

### F. 调度面（cron / job 普查摘要）

30+ job / 15+ cron schedule，全部 `Asia/Shanghai`。来源：

- 单锚编排器：`nightly_orchestrator` cron `30 2 * * *`（`src/server/orchestration/register.ts:245`），驱动 dreaming / coach / research-meeting / frontier-fill / knowledge-maintenance / kc-dedup 等 nightly DAG。
- capability manifests：agency（`dreaming_nightly`, `coach_daily`,
  `coach_weekly` 30 4 * * 0, `intervention_prepare_recovery` 1-59/2min,
  `goal_scope_propose_nightly`, `research_meeting_(agent_)nightly`）、
  copilot（`copilot_run` agent, `copilot_run_reconcile` 0-58/2min）、
  ingestion（`ingestion_operation`, `tencent_ocr_extract` 0.5s poll,
  `auto_enroll`）、knowledge（`knowledge_edge_propose_nightly`,
  `frontier_fill_nightly`, `knowledge_maintenance_nightly`, `kc_dedup_nightly`,
  `merge_attribution_sweep` 0 4 * * 1, `projection_oracle_sweep` 30 4 * * 1,
  `kg_borrow_shadow_sweep` 0 5 * * 1）、notes（`hub_auto_sync_nightly`
  45 2 * * *, `hub_sync_recovery` * * * * *, `hub_sync_mutation_wake`,
  `note_refine/generate/verify`）、observability（`subject_profile_audit_nightly`
  25 4, `ai_task_run_reconcile_nightly` 40 6）、practice（supply_execute /
  quiz_gen / quiz_verify / source_verify agent；variant_verify /
  attribution_followup / variant_gen / rejudge / judge_run / session_summary /
  item_prior_backfill / practice_stream_compose_nightly /
  question_supply_nightly / recalibration_nightly / embed_backfill /
  answer_class_backfill llm；`judge_pending_reconcile` 50 * * * *,
  `jyeoo_staged_asset_reap` 40 3, `supply_planner` 50 5,
  `confusable_contrast_nightly` 20 6, `reference_answer_backfill` 20 5,
  `kt_estimate_nightly` 10 5, `axis_state_nightly` 40 5,
  `judge_calibration_sample` 10 6）。
- infra crons：`prune_job_events` 0 4, `prune_orphan_review_sessions` 15 4,
  `prune_orphan_conversation_sessions` 25 4,
  `prune_orphan_placement_sessions` 35 4, `promote_conversation_idle`
  * * * * *, `verify_dispatch_recover` 10 4, echo queue
  （`src/server/boss/handlers.ts`）。
- memory queues：`memory_event_ingest/brief_regen/brief_sweep/ingest_outbox_poll/recover`（`src/server/memory/triggers.ts:76-83`）。

面板定位：P0 view（schedule 展示）+ 远期 P2（per-job enable/disable 走
pg-boss，不在 YUK-1007 首批范围）。

---

## §2 缺口统计

### 数量

| 类别 | 数量 | 备注 |
|---|---|---|
| env schema keys | ~110 | `src/server/env.ts:6-148` |
| 运行时 env 旋钮（flag+mode+threshold+override） | ~40 | §1.B1+B3+C1+scoped model overrides |
| ledger flags | 27（16 env / 11 const） | `scripts/audit-flags-ledger.json` |
| 台账外 env/mode 开关 | ~10 | §1.B3 —— 台账不覆盖 |
| TaskSpec | 52 | provider 全 xiaomi；41 pro / 11 base |
| hardcoded const 旋钮 | 80+ | §1.C2（非穷举，主要域已覆盖） |
| job / cron | 30+ job / 15+ schedule | §1.F |
| 语言/locale 面 | 4 类 | §1.D |

### 结构性缺口

1. **没有 "what is running now" 读面。** flag 向量只在 boot 时经
   `warnFlipOrder` 打日志；无任何 route/endpoint 暴露当前生效的
   flag/threshold/model 解析结果。面板要 view-only 也得先建这个读面。
2. **env vs const vs TaskSpec 三轨无统一抽象。** env flag（restart 生效）、
   const flag（rebuild）、TaskSpec（freeze catalog）各有独立读写路径；
   ledger 是手工维护的 JSON，~10 个开关根本不在台账里。
3. **module-load 快照 ≠ 运行时可改。** 多个 env reader 在模块加载时求值：
   `PLACEMENT_PROBE_ENABLED`（`placement.ts:42`）、`MATCH_THRESHOLD`、
   `KC_DEDUP_*`、boss client pool 等。面板写这些值只是"下次重启生效"，
   UI 必须如实标注，否则是假开关。
4. **app vs worker 进程间一致性无机制。** 同一 flag 被 app 和 worker 各读
   一次；compose 里要双份 `environment:`。DB-backed 配置（subject
   profile 模式，见 §4）天然解决此问题，env 不行。
5. **per-task model/provider 当前是编译期 freeze。** TaskCatalog
   `Object.freeze`；52 个 task 的 model/budget 改动=发版。YUK-1007 的核心
   需求（面板改 per-task 模型）需要一条 override 读路径插进
   `resolveTaskProvider`（`providers.ts:508-608`），该函数已有
   `override arg > env > registry default` 三级链，加第四级（DB）是
   最小侵入点。
6. **语言面是伪配置。** `LEARNER_LOCALE_PIN` 注释自己承认 per-user locale
   是 YUK-1007 scope；UI 无 i18n 框架，内联中文+`zh-CN` 硬编码×4+
   全局 `Asia/Shanghai` —— "语言偏好"第一期只能覆盖 prompt pin 与
   subject `languageStyle`，UI i18n 是另一个量级。
7. **secret 与非 secret 混在一个 schema。** ~110 key 里 provider key、
   `INTERNAL_TOKEN`、DB URL 与功能 flag 同表。面板数据模型必须在
   schema 层区分，不能靠"前端不渲染"。

---

## §3 面板候选集

### P0 — view-only（只读展示，第一批就能上）

- 当前生效 flag 向量（27 ledger + ~10 台账外，标注 env/const/opt-in-out）
- per-task model/provider/budget 解析结果（52 行表，= resolveTaskProvider
  输出物化）
- provider 注册表状态（8 provider，哪些有 key、哪些 reserved）
- cron schedule 总表（§1.F）
- 运行形态（port、db pool、queue tier 常量）
- const flags（学术开关，写明 rebuild-only）

前置依赖：新建 "current config read model"（缺口 §2.1）。

### P1 — writable（有明确 owner 场景，配 env→DB 迁移或 override 层）

- **per-task model/provider/budget override**（YUK-1007 核心；落在
  `resolveTaskProvider` 新增 DB 级 override）
- scoped model override 组：VERIFY_SOLVE、VISION_JUDGE、JUDGE_FALLBACK、
  JUDGE_CALIBRATION_REJUDGE（现为 env，迁移成本高于 per-task）
- **语言**：`LEARNER_LOCALE_PIN` → per-user/per-learner locale 字段 +
  `subjectProfile.languageStyle`（DB-live，已有先例）
- env flag 组（B1 全部 + `HUB_SYNC_MODE`、`INTERVENTION_DISABLED_METHOD_IDS`、
  `EXTRACT_OCR_ENGINE`）——标注 restart-required
- 阈值组：`WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD`、`COPILOT_NUDGE_*`

### P2 — advanced（高风险或低频，后续批次）

- `PROJECTION_IS_WRITER_*`（写所有权，风险高）
- `SELECTION_POLICY`、`MEMORY_RECONCILE_HANDOFF_MODE`（模式机）
- admission modes + POLICIES_JSON（enforce 可断流）
- `AI_PROVIDER_OVERRIDE`/`AI_PROVIDER_MODEL` 全局覆盖
- rate limits、`BACKUP_IMPORT_MAX_BYTES`、KC_DEDUP_*、TAGGING_MATCH_*
- `MEM0_*` 模型/dims（改 dims=重建 collection，需警告）
- per-job enable/disable + cron 修改（远期）

### 不上面板

- 全部 secret（provider keys、INTERNAL_TOKEN、DATABASE_URL）
- script-only envs（LLASA_*、PRIOR_REPS_*、AUDIT_READ_*、*_OK 确认阀、
  EXA_API_KEY）——标 ops-only
- `VITEST`/`NODE_ENV`、`API_PORT`、env schema 自身

### storage options（简述，非提案）

1. **env 保持 + 面板生成 .env diff**：最轻，但 module-load 快照和双进程
   问题原样保留，且面板写宿主机文件在 docker 部署下不成立。
2. **DB config 表 + 读面物化**（subject profile 先例：6 表、boot 水合、
   60s refresh）：解决双进程一致性 + 天然"current config"读面；需要把
   env reader 逐个改成 config reader，是真实迁移工作量。
3. **混合**：secret/启动依赖留 env；功能 flag、per-task override、locale、
   threshold 进 DB。推荐方向，与 §2 缺口一一对应。

---

## §4 冲突 / 注意事项

1. **compose `environment:` 静默压过 .env。** `docker-compose.mac.yml` 对
   app+worker 硬设 `PLACEMENT_PROBE_ENABLED`/`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`/
   `MISCONCEPTION_PROMOTE_ENABLED="true"`；`docker-compose.yml` 强制
   `MEM0_TELEMETRY=false` + per-service `MEM0_HISTORY_DB_PATH`（app `/tmp`
   vs worker `/var/lib/mem0` volume）。真实 env 优先于 .env 文件
   （`server/env.ts` loader 只填 unset）——面板上显示的 ".env 值" 可能
   根本不是生效值。**读面必须读进程 env，不能读文件。**
2. **boot-const 假开关风险。** module-load 期求值的 reader
   （`PLACEMENT_PROBE_ENABLED` at `placement.ts:42`、`MATCH_THRESHOLD`、
   `KC_DEDUP_*`、boss pool 等）在面板里若标成"可切换"是误导：写入后
   当前进程行为不变。每条目需带 `生效时机` 元数据。
3. **app/worker 双进程 parity。** flag 两进程各读；只改 app env 不改
   worker（或反之）会产生半生效状态。DB-backed 方案（§3 storage-3）
   是唯一一劳永逸解。
4. **已有 partial config surfaces（可复用先例）：**
   - subject profile：DB-backed 六表（`subject`/`subject_trait*`），
     boot 水合 + 60s refresh —— 最接近"settings"的现存范式。
   - `TokenGate.tsx`：客户端存 INTERNAL_TOKEN —— 反例（secret 进
     localStorage），不要照抄。
   - `.env.example:142-143` 已文档化 flag 文法；`.env.example` 是
     env 文档基线，面板 help text 可与其对齐。
5. **ledger 漂移。** `audit-flags-ledger.json` 手工维护；B3 的 ~10 个
   开关已在台账外。面板若以 ledger 为数据源，需先把台账外开关并入或
   换用自动扫描源。
6. **YUK-1033（学段纠正入口）** 明确 parked 等待本面板 —— 面板信息
   架构需预留"学段/纠正"入口位。
7. **真 env > .env.local > .env** 三级 + compose 第四级覆盖：生效值
   溯源（"这个值是谁设的"）本身就是面板的有用功能，但意味着读面要
   记录来源层级。

---

*普查方法：`ykv-code-index` 语义检索 + `codegraph` 调用面 + grep 字面量
交叉验证；TaskSpec 穷尽性经 52=`kind:`+`defaultModel:` 配对计数核实；
flag 穷尽性经 ledger 27 + 台账外逐项 grep 核实。*
