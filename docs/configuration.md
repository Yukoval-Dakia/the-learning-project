# 运行配置

## 加载方式

API（`server/index.ts`）与独立 worker（`scripts/worker.ts`）都先调用 `server/env.ts` 的 `loadEnv()`：按 `.env.local` → `.env` 顺序逐行读取，只填 `process.env` 中尚未设置的键，真实环境/compose 注入的值优先，引号值与行尾注释会被剥离（`loader:1-4,31-38`）。之后 `src/server/env.ts` 用 `@t3-oss/env-core` + `zod` 校验 server schema，`runtimeEnv` 即 `process.env`，空串按未设置处理；`DATABASE_URL` 是 schema 唯一必填项，`INTERNAL_TOKEN` 由 API 在监听前单独校验（`env:41,165-174,213-219`）。

compose 的 `migrate` / `app` / `worker` 都从 `.env` 取环境，`cloudflared` 只接收 `TUNNEL_TOKEN`（`docker-compose.yml:15-16,34-35,108-109,183-185`）。本机 `pnpm dev:local` 也先加载 `.env.local` / `.env` 再传给三个子进程，并用 `POSTGRES_*`（缺省 `loom`）拼出 `postgres://…@127.0.0.1:5433/…`（`scripts/dev-local.ts:14-15,25-30`；`scripts/local-db-env.ts:13-25`）。`.env.example` 只覆盖 schema 130 个键中的 52 个；仓库里唯一的 `VITE_*` 是 `src/vite-env.d.ts` 的 `VITE_API_BASE` 类型声明、没有消费点，因此不设 client schema；Vitest 下 `skipValidation` 跳过启动校验（`src/vite-env.d.ts:4-6`；`src/server/env.ts:6-161,167-174`）。

出处简写：`loader:N` = `server/env.ts:N`，`env:N` = `src/server/env.ts:N`，`registry:N` = `src/core/config/registry.ts:N`（指向该 key 的注册块，默认值/`envMode` 在同块相邻行）。`NODE_ENV` 与 `VITEST` 只影响运行时判断（测试下跳过校验、不向 pg-boss 入队），不进下表；`HOME` / `PATH` / `TMPDIR` 作为 jyeoo 子进程环境透传，列入 OCR/录入组（`src/server/runtime-env.ts:31`；`env:167`；`src/capabilities/practice/server/question-supply/jyeoo-spawn.ts:85-91`）。

## 环境变量

### 数据库与进程

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `DATABASE_URL` | app、worker、脚本 | 必填；缺失时 `src/db/client.ts` 启动即抛错 | `env:41`；`src/db/client.ts:11` |
| `API_PORT` | app | `8787`；非正整数抛错 | `env:186-193` |
| `RW_WORKER` | app | `1` 时同进程启动 pg-boss worker | `server/index.ts:189` |
| `RW_STATIC_DIR` | app | 未设时不启用 Start 前门 | `server/index.ts:156` |
| `RW_BOSS_AUTOMATION` | app、worker | `enabled`；`disabled` 关闭 pg-boss 自带 automation | `env:204-211`；`src/server/boss/client.ts:114` |
| `POSTGRES_USER` | 脚本（dev 连接串、备份） | `loom` | `scripts/local-db-env.ts:13` |
| `POSTGRES_PASSWORD` | 脚本（dev 连接串、备份） | `loom` | `scripts/local-db-env.ts:14` |
| `POSTGRES_DB` | 脚本（dev 连接串、备份） | `loom` | `scripts/local-db-env.ts:15` |
| `LOCAL_POSTGRES_HOST` | 脚本（`dev:local`） | `127.0.0.1` | `scripts/local-db-env.ts:16` |
| `LOCAL_POSTGRES_PORT` | 脚本（`dev:local`） | `5433` | `scripts/local-db-env.ts:17` |
| `LOCAL_NEXT_PORT` | 脚本（`dev:local`） | `3001`，仅用于拼 `NEXT_PUBLIC_BASE_URL` | `scripts/local-db-env.ts:30-35` |
| `LOOM_PG_IMAGE` | 脚本（cutover 备份） | `pgvector/pgvector:0.8.2-pg16-bookworm` | `scripts/cutover-backup.ts:2237` |

### 鉴权与密钥

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `INTERNAL_TOKEN` | app（`/api/*`） | 必填非空，否则 API 启动失败；`/api/health`、`/api/ready` 豁免 | `env:213-219`；`server/app.ts:143-145` |
| `JUDGE_PROVENANCE_SECRET` | app、worker | 未设、短于 32 字符或等于 `INTERNAL_TOKEN` 时 provenance 签发/校验关闭 | `src/capabilities/practice/server/judge/preview-provenance-token.ts:26-52` |
| `BANK_GAP_EVIDENCE_SECRET` | app、worker | 未设时 `file_bank_gap` 整体 fail closed | `src/capabilities/practice/server/tools/file-bank-gap.ts:5-8`；`bank-search.ts:154` |

### AI provider 与模型选择

全局 pin（`AI_PROVIDER_OVERRIDE` + `AI_PROVIDER_MODEL`）作用于所有非 typed 任务和 Mem0 提取/调和；`MEM0_LLM_*` 只在没有全局 pin 时生效（`src/server/ai/providers.ts:604-611`；`src/server/memory/llm-config.ts:20-40`）。`.env.example` 当前把这对值写成 `opencode-go` / `mimo-v2.6-pro`（`.env.example:9-13`）。Mem0 在 app（读）与 worker（写）进程内运行，compose 没有独立 mem0 服务；embedding 维度必须与 pgvector 列一致（`docker-compose.yml:37-42,110-117`；`src/server/memory/client.ts:185-194`）。typed 判分有专用 `openrouter` lane（只对 typed 任务开放）；OCR 由 `EXTRACT_OCR_ENGINE` 在 `glm`/`tencent` 两套实现间选择（`providers.ts:471-485`；`registry:570-577`；`src/capabilities/ingestion/server/tencent_mark.ts:1-40`）。

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `AI_PROVIDER_OVERRIDE` | app、worker | 走 task registry 默认 provider；未知 provider 抛错 | `providers.ts:620-632`；`registry:739` |
| `AI_PROVIDER_MODEL` | app、worker | 用 task 默认 model | `providers.ts:628` |
| `ANTHROPIC_API_KEY` | app、worker | 选中 `anthropic` 时必需，缺失抛错 | `providers.ts:85,925-931` |
| `CLAUDE_CODE_OAUTH_TOKEN` | app、worker | 选中 `anthropic-sub` 时必需 | `providers.ts:263,908-912` |
| `CLAUDE_CODE_MAX_RETRIES` | app、worker | `2` | `registry:472` |
| `OPENCODE_API_KEY` | app、worker | 选中 `opencode-go` 时必需 | `providers.ts:241` |
| `OPENAI_API_KEY` | app、worker | 仅显式绑定 `openai` lane 时必需 | `providers.ts:181-187` |
| `OPENROUTER_API_KEY` | app、worker（typed 判分） | 选中 `openrouter` 时必需；该 lane 只用于 typed 执行 | `providers.ts:149-152,471-485` |
| `XIAOMI_API_KEY` | app、worker | 选中 `xiaomi` 时必需 | `providers.ts:96` |
| `XIAOMI_TOKEN_PLAN_API_KEY` | app、worker | 选中 `xiaomi-token-plan` 时必需 | `providers.ts:115` |
| `XIAOMI_TOKEN_PLAN_BASE_URL` | app、worker | 按 region 拼 `https://token-plan-<region>.xiaomimimo.com/v1`；不得指向 `api.xiaomimimo.com` | `src/server/ai/xiaomi-token-plan.ts:12-24` |
| `XIAOMI_TOKEN_PLAN_REGION` | app、worker | `cn`；只接受 `cn`/`sgp`/`ams` | `src/server/ai/xiaomi-token-plan.ts:19-23` |
| `ZAI_CODING_CN_API_KEY` | app、worker | 选中 `zhipuai-coding-plan` 时必需 | `providers.ts:131` |
| `ZHIPU_API_KEY` | app、worker | 无全局 pin 时 Mem0 提取必需；GLM OCR 也读它 | `src/server/memory/llm-config.ts:23-31`；`src/capabilities/ingestion/server/glm_ocr.ts:175` |
| `VERCEL_AI_GATEWAY_TOKEN` | app、worker | `gateway` lane 目前未使用，仅显式选择才读 | `providers.ts:177-179` |
| `VERIFY_SOLVE_PROVIDER_OVERRIDE` | app、worker | 不启用 solve lane override，走常规解析链 | `registry:708-714`；`src/capabilities/practice/server/quiz/solve-lane.ts:61-63` |
| `VERIFY_SOLVE_MODEL_OVERRIDE` | app、worker | 用 provider 默认 model | `registry:715-721`；`src/capabilities/practice/server/quiz/solve-lane.ts:61-63` |
| `VISION_JUDGE_PROVIDER` | app、worker | 不启用 vision lane override，走常规解析链 | `registry:722-728`；`src/server/ai/vision-judge-config.ts:92-106` |
| `VISION_JUDGE_MODEL` | app、worker | 用 provider/lane 默认 model | `registry:729-735`；`src/server/ai/vision-judge-config.ts:92-106` |
| `MIMO_VISION_BASE_URL` | 脚本（vision/ingestion preflight） | `https://api.xiaomimimo.com/anthropic`；Token Plan pin 下由 lane URL 推导 | `scripts/preflight-vision.ts:44`；`src/server/ai/xiaomi-token-plan.ts:31-40` |
| `MIMO_VISION_MODEL` | 脚本（vision/ingestion preflight） | 用解析后的 vision-judge 默认模型 | `scripts/preflight-vision.ts:60` |

### provider 准入

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `AI_PROVIDER_ATTEMPT_ADMISSION_MODE` | app、worker | `off`；只接受 `off`/`observe`/`enforce` | `registry:637-645` |
| `AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON` | app、worker | 无 per-lane 并发/启动速率策略 | `registry:662-668` |
| `AI_PROVIDER_SESSION_ADMISSION_MODE` | app、worker | `off`；只接受 `off`/`observe`/`enforce` | `registry:670-678` |
| `AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON` | app、worker | 无 session 策略；写入要求至少一个 provider lane | `registry:700-706` |

### 记忆

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | app、worker | 记忆写入与 embedding 必需，缺失抛错；`memory_event_ingest` 在 worker 内跑 | `src/server/memory/client.ts:183`；`src/server/ai/embed.ts:155`；`src/server/memory/triggers.ts:1149-1159` |
| `MEM0_EMBEDDING_MODEL` | app、worker | `text-embedding-v4` | `src/server/memory/client.ts:201`；`src/server/ai/providers.ts:308` |
| `MEM0_EMBEDDING_BASE_URL` | app、worker | `https://dashscope.aliyuncs.com/compatible-mode/v1`；`embed.ts` 也读同一个键 | `src/server/memory/client.ts:21,202`；`src/server/ai/embed.ts:31` |
| `MEM0_EMBEDDING_DIMS` | app、worker | `1024`；非正整数抛错 | `src/server/memory/client.ts:22,188-194` |
| `MEM0_PGVECTOR_COLLECTION` | app、worker | `learning_project_memories` | `src/server/export/constants.ts:513` |
| `MEM0_PGVECTOR_HNSW` | app、worker | `false`；只有字面 `true` 开启 | `src/server/memory/client.ts:216` |
| `MEM0_PGVECTOR_DISKANN` | app、worker | `false`；只有字面 `true` 开启 | `src/server/memory/client.ts:217` |
| `MEM0_HISTORY_DB_PATH` | app、worker | `/var/lib/mem0/history.db`；compose 覆盖 app 为 `/tmp/mem0/history.db`、worker 为 `/var/lib/mem0/history.db` | `src/server/memory/client.ts:23,244`；`docker-compose.yml:40-42,112-116` |
| `MEM0_LLM_MODEL` | app、worker | 无全局 pin 时 `glm-5.2` | `src/server/memory/llm-config.ts:28`；`providers.ts:306` |
| `MEM0_LLM_BASE_URL` | app、worker | 无全局 pin 时 `https://open.bigmodel.cn/api/coding/paas/v4` | `src/server/memory/llm-config.ts:29` |
| `MEMORY_RECONCILE_HANDOFF_MODE` | app、worker | `observe`；非法值在 reader 内抛错 | `registry:427-433` |

### OCR、录入与外部检索

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `EXTRACT_OCR_ENGINE` | worker（`tencent_ocr_extract`） | `glm`；只接受 `glm`/`tencent` | `registry:571-577` |
| `TENCENT_SECRET_ID` | worker（OCR） | 腾讯 OCR 客户端必需，缺失抛错 | `src/capabilities/ingestion/server/tencent_mark.ts:23-30` |
| `TENCENT_SECRET_KEY` | worker（OCR） | 同上 | `src/capabilities/ingestion/server/tencent_mark.ts:23-30` |
| `TENCENT_OCR_REGION` | worker（OCR） | `ap-shanghai` | `src/capabilities/ingestion/server/tencent_mark.ts:37` |
| `DOCX_CONVERT_ENGINE` | worker（DOCX 转换） | 仅字面 `docker` 生效，其余按自动解析 | `registry:580-586`；`src/capabilities/ingestion/server/docx/convert.ts` |
| `R2_ENDPOINT` | app、worker | 四项任一缺失时 `getR2()` 抛错 | `src/server/r2.ts:52-59` |
| `R2_ACCESS_KEY_ID` | app、worker | 同上 | `src/server/r2.ts:52-59` |
| `R2_SECRET_ACCESS_KEY` | app、worker | 同上 | `src/server/r2.ts:52-59` |
| `R2_BUCKET` | app、worker | 同上 | `src/server/r2.ts:52-59` |
| `EXA_API_KEY` | app、worker | 空或未设时 Exa MCP 返回 `null`，不注册 | `src/server/ai/mcp/exa.ts:58-60` |
| `JYEOO_RS_BINARY` | app、worker | `~/yukoval-projects/jyeoo-rs/target/release/jyeoo-rs` | `src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts:23-30` |
| `JYEOO_SPAWN_TIMEOUT_MS` | app、worker | `120000` | `registry:527` |
| `JYEOO_BACKFILL_TIMEOUT_MS` | 脚本（`jyeoo:backfill`） | `session_max × 90000` ms | `src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts:70-84` |
| `JYEOO_SPAWN_MAX_STDOUT_BYTES` | app、worker | `8388608` | `registry:548` |
| `JYEOO_SPAWN_MAX_STDERR_BYTES` | app、worker | `1048576` | `registry:555` |
| `JYEOO_DAILY_FETCH_BUDGET` | app、worker | `40`；`0` 表示当日禁抓 | `registry:563-569` |
| `HOME` | app、worker（jyeoo 子进程） | 原样透传 | `src/capabilities/practice/server/question-supply/jyeoo-spawn.ts:85-91` |
| `PATH` | app、worker（jyeoo 子进程） | 原样透传 | 同上 |
| `TMPDIR` | app、worker（jyeoo 子进程） | 原样透传 | 同上 |
| `WORKSHEET_RENDER_APP_ORIGIN` | worker（`worksheet_render`） | `http://localhost:5173`；compose worker 设 `http://app:8787` | `src/capabilities/practice/jobs/worksheet_render.ts:1607-1612`；`docker-compose.yml:117` |

### 功能开关

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `JUDGE_DURABLE_ENABLED` | app、worker | `false` | `registry:225` |
| `JUDGE_FALLBACK_PROVIDER` | app、worker | `anthropic-sub`；空串 = 显式关闭兜底 | `registry:234-240` |
| `MISCONCEPTION_PROMOTE_ENABLED` | app、worker | `false`；compose 强制项，DB 写入返回 409 | `registry:241-245`；`src/server/config/write.ts:86-92` |
| `MISCONCEPTION_HARD_CONFIRM_ENABLED` | app、worker | `false` | `registry:250` |
| `QUESTION_SUPPLY_REFILL_ENABLED` | app、worker | `false` | `registry:257` |
| `CONFUSABLE_CONTRAST_ENABLED` | worker（夜间发现） | `false` | `registry:264`；`src/capabilities/practice/jobs/confusable_contrast_nightly.ts` |
| `RESEARCH_MEETING_AGENT_ENABLED` | worker（夜间任务） | `false` | `registry:271`；`src/capabilities/agency/jobs/research_meeting_agent_nightly.ts` |
| `JUDGE_CALIBRATION_SAMPLING_ENABLED` | worker | `false` | `registry:278` |
| `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` | worker | `false`；compose 强制项，DB 写入返回 409 | `registry:285-288`；`src/server/config/write.ts:86-92` |
| `WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD` | worker | `0.85` | `registry:300` |
| `WORKFLOW_JUDGE_OBSERVE_ENABLED` | worker | `false` | `registry:293` |
| `WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED` | worker | `false` | `registry:309` |
| `WAVE6_TRIGGER_MARK_WRONG_ENABLED` | app、worker | `true` | `registry:316` |
| `WAVE6_TRIGGER_MASTERY_ENABLED` | app、worker | `true` | `registry:323` |
| `WAVE6_TRIGGER_DREAMING_ENABLED` | app、worker | `true` | `registry:330` |
| `WAVE6_TRIGGER_VERIFY_ENABLED` | app、worker | `false` | `registry:337` |
| `AUTO_INTERVENTION_EXPANSION_ENABLED` | app、worker | `false` | `registry:351` |
| `INTERVENTION_DISABLED_METHOD_IDS` | app、worker | `[]`；CSV 解析为数组 | `registry:358` |
| `COPILOT_SUBAGENT_ENABLED` | app、worker | `true` | `registry:365` |
| `COPILOT_NUDGE_ENABLED` | app、worker | `false` | `registry:372` |
| `COPILOT_NUDGE_DAILY_MAX` | app、worker | `3` | `registry:379` |
| `COPILOT_NUDGE_EXPIRES_HOURS` | app、worker | `24` | `registry:386` |
| `COPILOT_NUDGE_STREAK_N` | app、worker | `3` | `registry:393` |
| `COPILOT_NUDGE_KC_COOLDOWN_HOURS` | app、worker | `24` | `registry:400` |
| `PLACEMENT_PROBE_ENABLED` | app、worker | `false`；compose 强制项，DB 写入返回 409 | `registry:448-451`；`src/server/config/write.ts:86-92` |
| `PROJECTION_IS_WRITER_ITEM_CALIBRATION` | app、worker | `false`；env 只认字面 `1` 为 true | `registry:436-443` |
| `SELECTION_POLICY` | app、worker | `softmax_mfi`；只接受 `legacy`/`softmax_mfi` | `registry:407-414` |
| `HUB_SYNC_MODE` | worker（夜间同步） | `off`；只接受 `off`/`shadow`/`apply` | `registry:416-423` |

### 调参

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `AI_RATE_LIMIT_MAX` | app | `30` | `registry:457`；`src/server/http/rate-limit.ts` |
| `AI_RATE_LIMIT_WINDOW_MS` | app | `10000` | `registry:465`；`src/server/http/rate-limit.ts` |
| `JUDGE_CALIBRATION_BATCH_MAX` | worker | `20`；范围 1–50 | `registry:484-490` |
| `JUDGE_CALIBRATION_WINDOW_DAYS` | worker | `7`；范围 1–90 | `registry:492-498` |
| `JUDGE_CALIBRATION_REJUDGE_PROVIDER` | worker | `anthropic-sub` | `registry:499-505` |
| `JUDGE_CALIBRATION_REJUDGE_MODEL` | worker | `claude-opus-4-8` | `registry:506-512` |
| `KC_DEDUP_DISTANCE_MAX` | worker（夜间去重） | `0.1` | `registry:588-594` |
| `KC_DEDUP_WINDOW_DAYS` | worker（夜间去重） | `7` | `registry:596-602` |
| `KC_DEDUP_MAX_PAIRS` | worker（夜间去重） | `50` | `registry:604-610` |
| `TAGGING_MATCH_THRESHOLD` | app、worker | `0.55` | `registry:611-618` |
| `BACKUP_IMPORT_MAX_BYTES` | app（导入 API） | `1000000000`；低于 1 MB 时告警并回退默认 | `registry:620-630`；`src/capabilities/observability/api/backup-import.ts:25-43` |

### 可观测

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `LMNR_PROJECT_API_KEY` | app、worker | 空或未设时跳过 Laminar SDK 与导出 | `src/server/ai/laminar-tracing.ts:147` |
| `LMNR_DEV_TRANSCRIPTS` | app、worker | 只有字面 `1` 且 `NODE_ENV=development` 时开启 | `src/server/ai/laminar-transcript.ts:20` |
| `LMNR_DEBUG` | app、worker | 只要设置就拒绝初始化 tracing | `src/server/ai/laminar-tracing.ts:137` |
| `LMNR_TRACE_METADATA` | app、worker | 只要设置就拒绝初始化 tracing | `src/server/ai/laminar-tracing.ts:137` |
| `LMNR_SPAN_CONTEXT` | app、worker | 只要设置就拒绝初始化 tracing | `src/server/ai/laminar-tracing.ts:137` |

### 脚本、运维与测试

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `API_SMOKE_BASE_URL` | 脚本（`api:smoke`） | `http://localhost:3001` | `scripts/api-smoke.ts:43` |
| `AUDIT_READ_DATABASE_URL` | 脚本（audit） | 回落到 `DATABASE_URL`；session 固定只读 | `scripts/audit-threshold-calibration.ts:687-688`；`env:21-25` |
| `B3_GATE_CONFIRM_CLONE` | 脚本（`b3:gate`） | 不等于 `1` 时拒绝运行 | `scripts/b3-gate.ts:260` |
| `DELIVERY_API_PORT` | 脚本（`delivery:evidence`） | `8787` | `scripts/delivery-evidence.ts:256` |
| `DELIVERY_API_BASE` | 脚本（`delivery:evidence`） | `http://127.0.0.1:<DELIVERY_API_PORT>` | `scripts/delivery-evidence.ts:257` |
| `DOCKER_HOST` | 脚本（grounding/rehearsal） | 自动尝试 OrbStack / Docker Desktop socket | `scripts/grounding-gate.ts:192-199` |
| `PROFILE_CRITIC_OK` | 脚本（`compile:profile`） | 非 `1` 时拒绝非 loopback `DATABASE_URL` | `scripts/compile-profile.ts:173-187` |
| `SEED_SYNTHETIC_OK` | 脚本（`seed:synthetic`） | 必须为 `1`，否则拒绝执行 | `scripts/seed-synthetic.ts:80-84` |
| `TUNNEL_TOKEN` | 运维（compose/预检） | 空时 `compose:up` 预检失败 | `scripts/cloudflared-preflight.ts:12-18`；`docker-compose.yml:185` |
| `TUNNEL_PROTOCOL` | 运维（compose/预检） | `auto`；只接受 `auto`/`http2`/`quic` | `scripts/cloudflared-preflight.ts:20-24` |

### schema 中声明、未见读取

`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`MEM0_TELEMETRY`（`env:16-17,97`）。

## DB 配置层 `system_config`

`system_config` 按 registry 登记的 key 存 jsonb 值，并带 `revision`、`source_note`、`updated_by` 与时间戳；`system_config_journal` 是 append-only 账本（`(key, revision)` 主键，`action` 为 `set`/`clear`/`seed`，payload 记 `prev`/`next`/`note`）；`system_config_epoch` 只有 `id='global'` 一行（`src/db/schema.ts:4297-4340`）。key 空间是 registry 的静态键、动态 `task.<kind>.{provider,model,budget,reasoning,override_global_pin}`，以及已登记的 `lane.{verify_solve,vision_judge,global}.{provider,model}`；secret、boot 输入和 env schema 自身不在表内（`registry:1-21,706-751,761-806`）。

app 与 worker 启动时各 hydrate 一次，之后每 `15_000` ms 刷新；刷新先探测 epoch，同号则跳过全量 SELECT，新快照整块替换内存快照；表缺失、DB 不可用或坏行时保留 last-good 或退回 env + code default（`src/server/config/hydrate.ts:113-203,211-221`；`server/index.ts:57-61`；`src/server/boss/start-worker.ts:52,144`）。`pinned` 键的 DB 行会被跳过并告警（`hydrate.ts:143-150`）。

写面是 `PATCH /api/admin/config` 与 `POST /api/admin/config/reset`，页面为 `/admin/config`；同一事务内 upsert/删除行、追加 journal、bump epoch，提交后本进程立即 hydrate，响应分别报告提交 epoch 与本进程快照 epoch（`src/capabilities/observability/manifest.ts:479-511`；`src/server/config/write.ts:587-654`；`src/server/config/admin-config-write.ts:8-21`；`src/kernel/ui-surfaces.ts:234`）。

生效优先级按 key 的 `envMode`：默认 `fallback` = DB > env > code default；`priority` = env 显式 > DB > code default；`pinned` = 只看 env（DB 写入 409）。当前 `pinned` 是 `MISCONCEPTION_PROMOTE_ENABLED`、`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`、`PLACEMENT_PROBE_ENABLED`（`src/core/config/store.ts:13-16,136-160`；`registry:241-245,285-288,448-451`）。
