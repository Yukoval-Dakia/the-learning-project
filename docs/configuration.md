# 运行配置

## 加载方式

API（`server/index.ts`）与独立 worker（`scripts/worker.ts`）都先调用 `server/env.ts` 的 `loadEnv()`：按 `.env.local` → `.env` 顺序逐行读取，只填 `process.env` 中尚未设置的键，真实环境/compose 注入的值优先，引号值与行尾注释会被剥离（`server/env.ts`）。之后 `src/server/env.ts` 用 `@t3-oss/env-core` + `zod` 校验 server schema，`runtimeEnv` 即 `process.env`，空串按未设置处理；`DATABASE_URL` 是 schema 唯一必填项，`INTERNAL_TOKEN` 由 API 在监听前单独校验（`src/server/env.ts`）。

compose 的 `migrate` / `app` / `worker` 都从 `.env` 取环境，`cloudflared` 只接收 `TUNNEL_TOKEN`（`docker-compose.yml`）。本机 `pnpm dev:local` 也先加载 `.env.local` / `.env` 再传给三个子进程，并用 `POSTGRES_*`（缺省 `loom`）拼出 `postgres://…@127.0.0.1:5433/…`（`scripts/dev-local.ts`；`scripts/local-db-env.ts`）。`.env.example` 只覆盖 schema 130 个键中的 41 个；仓库里唯一的 `VITE_*` 是 `src/vite-env.d.ts` 的 `VITE_API_BASE` 类型声明、没有消费点，因此不设 client schema；Vitest 下 `skipValidation` 跳过启动校验（`src/vite-env.d.ts`；`src/server/env.ts`）。

## 环境变量

表中出处写 `registry` 的键都登记在 `src/core/config/registry.ts`，默认值即该键的 `codeDefault`，并且可被 `system_config` 覆盖（优先级见下文）。`NODE_ENV` 与 `VITEST` 只影响运行时判断（测试下跳过校验、不向 pg-boss 入队），不进下表；`HOME` / `PATH` / `TMPDIR` 作为 jyeoo 子进程环境透传，列入 OCR/录入组（`src/kernel/background-job-enqueue.ts`；`src/server/env.ts`；`src/capabilities/practice/server/question-supply/jyeoo-spawn.ts`）。

### 数据库与进程

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `DATABASE_URL` | app、worker、脚本 | 必填；缺失时 `src/db/client.ts` 启动即抛错 | `src/server/env.ts`；`src/db/client.ts` |
| `API_PORT` | app | `8787`；非正整数抛错 | `src/server/env.ts` |
| `RW_WORKER` | app | `1` 时同进程启动 pg-boss worker | `server/index.ts` |
| `RW_STATIC_DIR` | app | 未设时不启用 Start 前门 | `server/index.ts` |
| `RW_BOSS_AUTOMATION` | app、worker | `enabled`；`disabled` 关闭 pg-boss 自带 automation | `src/server/env.ts`；`src/server/boss/client.ts` |
| `POSTGRES_USER` | 脚本（dev 连接串、备份） | `loom` | `scripts/local-db-env.ts` |
| `POSTGRES_PASSWORD` | 脚本（dev 连接串、备份） | `loom` | `scripts/local-db-env.ts` |
| `POSTGRES_DB` | 脚本（dev 连接串、备份） | `loom` | `scripts/local-db-env.ts` |
| `LOCAL_POSTGRES_HOST` | 脚本（`dev:local`） | `127.0.0.1` | `scripts/local-db-env.ts` |
| `LOCAL_POSTGRES_PORT` | 脚本（`dev:local`） | `5433` | `scripts/local-db-env.ts` |
| `LOCAL_NEXT_PORT` | 脚本（`dev:local`） | `3001`，仅用于拼 `NEXT_PUBLIC_BASE_URL` | `scripts/local-db-env.ts` |
| `LOOM_PG_IMAGE` | 脚本（cutover 备份） | `pgvector/pgvector:0.8.2-pg16-bookworm` | `scripts/cutover-backup.ts` |

### 鉴权与密钥

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `INTERNAL_TOKEN` | app（`/api/*`） | 必填非空，否则 API 启动失败；`/api/health`、`/api/ready` 豁免 | `src/server/env.ts`；`server/app.ts` |
| `JUDGE_PROVENANCE_SECRET` | app | 未设、短于 32 字符或等于 `INTERNAL_TOKEN` 时 provenance 签发/校验关闭；worker 不读 | `src/capabilities/practice/server/judge/preview-provenance-token.ts`；`.env.example` |
| `BANK_GAP_EVIDENCE_SECRET` | app、worker | 未设、短于 32 字符或等于 `INTERNAL_TOKEN` 时一律视为未设：`search_bank` 不签 MAC，`file_bank_gap` 拒绝 filing | `src/capabilities/practice/server/tools/bank-search.ts`；`src/capabilities/practice/server/tools/file-bank-gap.ts` |

### AI provider 与模型选择

全局 pin（`AI_PROVIDER_OVERRIDE` + `AI_PROVIDER_MODEL`）作用于非 typed 任务和 Mem0 提取/调和，但若某任务在 `system_config` 设了 `task.<kind>.override_global_pin=true` 且 provider/model 成对合法，则该任务走 task pair、压过全局 pin（`src/server/ai/providers.ts`）。模型端点 `base_url` 受 models.dev 目录端点 host allowlist 约束：内置 lane 的显式端点覆盖与 `custom_provider.base_url` 只能指向目录声明过的 host（另含代码声明的 anthropic/openai 直连根、Xiaomi Token Plan 三区、DashScope embedding 双端点与北京 workspace MaaS host `ws-tcvd1h9009b55vr0.cn-beijing.maas.aliyuncs.com`），在保存与执行解析边界报错；非默认端口必须由目录端点自身声明，否则拒绝；运维 env 端点（`MEM0_LLM_BASE_URL`、`MEM0_EMBEDDING_BASE_URL`、`MIMO_VISION_BASE_URL`、`XIAOMI_TOKEN_PLAN_BASE_URL`）同过该校验，不在白名单即拒绝发送；`custom_provider.api_key_env` 还与 provider 绑定——内置 provider 的凭据 env 只能发给自家端点，内置端点也只收自家凭据 env（跨 provider 配置被拒，YUK-1654）。Mem0 全局 pin 的端点同过该校验；该约束只作用于模型端点，不影响 agent 的网页浏览 / fetch 工具（`src/core/config/model-endpoint-allowlist.ts`；`src/server/ai/model-catalog.ts`）。`MEM0_LLM_*` 只在没有全局 pin 时生效（`src/server/memory/llm-config.ts`）。`.env.example` 当前把这对值写成 `opencode-go` / `mimo-v2.6-pro`（`.env.example`）。Mem0 在 app（读）与 worker（写）进程内运行，compose 没有独立 mem0 服务；embedding 维度必须与 pgvector 列一致（`docker-compose.yml`；`src/server/memory/client.ts`）。typed 判分有专用 `openrouter` lane（只对 typed 任务开放）；OCR 由 `EXTRACT_OCR_ENGINE` 在 `glm`/`tencent` 两套实现间选择（`src/server/ai/providers.ts`；`registry`；`src/capabilities/ingestion/server/tencent_mark.ts`）。

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `AI_PROVIDER_OVERRIDE` | app、worker | 走 task registry 默认 provider；未知 provider 抛错 | `src/server/ai/providers.ts`；`registry` |
| `AI_PROVIDER_MODEL` | app、worker | 与 `AI_PROVIDER_OVERRIDE` 一起用：多数非 mimo lane（如 `opencode-go`/`openai`/`anthropic`）必须显式设可服务的 model，否则拒绝（task 默认常是 mimo id）；`xiaomi` 可复用默认；`anthropic-sub` 有自带 Opus 默认 | `src/server/ai/providers.ts` |
| `ANTHROPIC_API_KEY` | app、worker | 选中 `anthropic` 时必需，缺失抛错 | `src/server/ai/providers.ts` |
| `CLAUDE_CODE_OAUTH_TOKEN` | app、worker | 选中 `anthropic-sub` 时必需 | `src/server/ai/providers.ts` |
| `CLAUDE_CODE_MAX_RETRIES` | app、worker | `2` | `registry` |
| `OPENCODE_API_KEY` | app、worker | 选中 `opencode-go` 时必需 | `src/server/ai/providers.ts` |
| `OPENAI_API_KEY` | app、worker | 仅显式绑定 `openai` lane 时必需 | `src/server/ai/providers.ts` |
| `OPENROUTER_API_KEY` | app、worker（typed 判分） | 选中 `openrouter` 时必需；该 lane 只用于 typed 执行 | `src/server/ai/providers.ts` |
| `XIAOMI_API_KEY` | app、worker | 选中 `xiaomi` 时必需 | `src/server/ai/providers.ts` |
| `XIAOMI_TOKEN_PLAN_API_KEY` | app、worker | 选中 `xiaomi-token-plan` 时必需 | `src/server/ai/providers.ts` |
| `XIAOMI_TOKEN_PLAN_BASE_URL` | app、worker | 按 region 拼 `https://token-plan-<region>.xiaomimimo.com/v1`；显式值只接受 `token-plan-<region>.xiaomimimo.com`（不得指向 `api.xiaomimimo.com` 或其他 host） | `src/server/ai/xiaomi-token-plan.ts` |
| `XIAOMI_TOKEN_PLAN_REGION` | app、worker | `cn`；只接受 `cn`/`sgp`/`ams` | `src/server/ai/xiaomi-token-plan.ts` |
| `ZAI_CODING_CN_API_KEY` | app、worker | 选中 `zhipuai-coding-plan` 时必需 | `src/server/ai/providers.ts` |
| `ZHIPU_API_KEY` | worker（默认 OCR）；app、worker（Mem0） | 默认 OCR 引擎 `glm` 与无全局 pin 时的 Mem0 提取都必需，缺失时抛错 | `src/capabilities/ingestion/server/glm_ocr.ts`；`src/server/memory/llm-config.ts` |
| `VERCEL_AI_GATEWAY_TOKEN` | app、worker | `gateway` lane 目前未使用，仅显式选择才读 | `src/server/ai/providers.ts` |
| `VERIFY_SOLVE_PROVIDER_OVERRIDE` | app、worker | 不启用 solve lane override，走常规解析链 | `registry`；`src/capabilities/practice/server/quiz/solve-lane.ts` |
| `VERIFY_SOLVE_MODEL_OVERRIDE` | app、worker | 用 provider 默认 model | `registry`；`src/capabilities/practice/server/quiz/solve-lane.ts` |
| `VISION_JUDGE_PROVIDER` | app、worker | 不启用 vision lane override，走常规解析链 | `registry`；`src/server/ai/vision-judge-config.ts` |
| `VISION_JUDGE_MODEL` | app、worker | 用 provider/lane 默认 model | `registry`；`src/server/ai/vision-judge-config.ts` |
| `MIMO_VISION_BASE_URL` | 脚本（vision/ingestion preflight） | `https://api.xiaomimimo.com/anthropic`（host 须过模型端点 allowlist）；Token Plan pin 下由 lane URL 推导，显式值只接受 `token-plan-<region>.xiaomimimo.com` | `scripts/preflight-vision.ts`；`src/server/ai/xiaomi-token-plan.ts` |
| `MIMO_VISION_MODEL` | 脚本（vision/ingestion preflight） | 用解析后的 vision-judge 默认模型 | `scripts/preflight-vision.ts` |

### provider 准入

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `AI_PROVIDER_ATTEMPT_ADMISSION_MODE` | app、worker | `off`；只接受 `off`/`observe`/`enforce` | `registry` |
| `AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON` | app、worker | 无 per-lane 并发/启动速率策略 | `registry` |
| `AI_PROVIDER_SESSION_ADMISSION_MODE` | app、worker | `off`；只接受 `off`/`observe`/`enforce` | `registry` |
| `AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON` | app、worker | 无 session 策略；写入要求至少一个 provider lane | `registry` |

### 记忆

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | app、worker | 记忆写入与 embedding 必需，缺失抛错；`memory_event_ingest` 在 worker 内跑 | `src/server/memory/client.ts`；`src/server/ai/embed.ts`；`src/server/memory/triggers.ts` |
| `MEM0_EMBEDDING_MODEL` | app、worker | `text-embedding-v4` | `src/server/memory/client.ts`；`src/server/ai/providers.ts` |
| `MEM0_EMBEDDING_BASE_URL` | app、worker | `https://dashscope.aliyuncs.com/compatible-mode/v1`；`embed.ts` 也读同一个键；host 须过模型端点 allowlist（含代码声明的 DashScope 双端点，以及北京 workspace MaaS `ws-tcvd1h9009b55vr0.cn-beijing.maas.aliyuncs.com`） | `src/server/memory/client.ts`；`src/server/ai/embed.ts` |
| `MEM0_EMBEDDING_DIMS` | app、worker | `1024`；非正整数抛错 | `src/server/memory/client.ts` |
| `MEM0_PGVECTOR_COLLECTION` | app、worker | `learning_project_memories` | `src/server/export/constants.ts` |
| `MEM0_PGVECTOR_HNSW` | app、worker | `false`；只有字面 `true` 开启 | `src/server/memory/client.ts` |
| `MEM0_PGVECTOR_DISKANN` | app、worker | `false`；只有字面 `true` 开启 | `src/server/memory/client.ts` |
| `MEM0_HISTORY_DB_PATH` | app、worker | `/var/lib/mem0/history.db`；compose 覆盖 app 为 `/tmp/mem0/history.db`、worker 为 `/var/lib/mem0/history.db` | `src/server/memory/client.ts`；`docker-compose.yml` |
| `MEM0_LLM_MODEL` | app、worker | 无全局 pin 时 `glm-5.2` | `src/server/memory/llm-config.ts`；`src/server/ai/providers.ts` |
| `MEM0_LLM_BASE_URL` | app、worker | 无全局 pin 时 `https://open.bigmodel.cn/api/coding/paas/v4`；host 须过模型端点 allowlist | `src/server/memory/llm-config.ts` |
| `MEMORY_RECONCILE_HANDOFF_MODE` | app、worker | `observe`；非法值在 reader 内抛错 | `registry` |
| `MEM0_TELEMETRY` | app、worker（`mem0ai` SDK） | SDK 默认可向外报 PostHog；compose 强制 `false`；非 compose 部署也应显式 `false` | `docker-compose.yml`；`src/server/env.ts` |

### OCR、录入与外部检索

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `EXTRACT_OCR_ENGINE` | worker（`tencent_ocr_extract`） | `glm`；只接受 `glm`/`tencent` | `registry` |
| `TENCENT_SECRET_ID` | worker（OCR） | 仅 `EXTRACT_OCR_ENGINE=tencent` 时必需；默认 `glm` 路径不读 | `src/capabilities/ingestion/server/tencent_mark.ts` |
| `TENCENT_SECRET_KEY` | worker（OCR） | 仅 `EXTRACT_OCR_ENGINE=tencent` 时必需；默认 `glm` 路径不读 | `src/capabilities/ingestion/server/tencent_mark.ts` |
| `TENCENT_OCR_REGION` | worker（OCR） | 仅 tencent 路径读取；默认 `ap-shanghai` | `src/capabilities/ingestion/server/tencent_mark.ts` |
| `DOCX_CONVERT_ENGINE` | worker（DOCX 转换） | 仅字面 `docker` 生效，其余按自动解析 | `registry`；`src/capabilities/ingestion/server/docx/convert.ts` |
| `R2_ENDPOINT` | app、worker | 四项任一缺失时 `getR2()` 抛错 | `src/kernel/object-storage.ts` |
| `R2_ACCESS_KEY_ID` | app、worker | 同上 | `src/kernel/object-storage.ts` |
| `R2_SECRET_ACCESS_KEY` | app、worker | 同上 | `src/kernel/object-storage.ts` |
| `R2_BUCKET` | app、worker | 同上 | `src/kernel/object-storage.ts` |
| `EXA_API_KEY` | app、worker | 空或未设时 Exa MCP 返回 `null`，不注册 | `src/ai/exa-mcp.ts` |
| `JYEOO_RS_BINARY` | app、worker | `~/yukoval-projects/jyeoo-rs/target/release/jyeoo-rs` | `src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts` |
| `JYEOO_SPAWN_TIMEOUT_MS` | app、worker | `120000` | `registry` |
| `JYEOO_BACKFILL_TIMEOUT_MS` | 脚本（`jyeoo:backfill`） | `session_max × 90000` ms | `src/capabilities/practice/server/question-supply/jyeoo-supply-config.ts` |
| `JYEOO_SPAWN_MAX_STDOUT_BYTES` | app、worker | `8388608` | `registry` |
| `JYEOO_SPAWN_MAX_STDERR_BYTES` | app、worker | `1048576` | `registry` |
| `JYEOO_DAILY_FETCH_BUDGET` | app、worker | `40`；`0` 表示当日禁抓 | `registry` |
| `HOME` | app、worker（jyeoo 子进程） | 原样透传 | `src/capabilities/practice/server/question-supply/jyeoo-spawn.ts` |
| `PATH` | app、worker（jyeoo 子进程） | 原样透传 | 同上 |
| `TMPDIR` | app、worker（jyeoo 子进程） | 原样透传 | 同上 |
| `WORKSHEET_RENDER_APP_ORIGIN` | worker（`worksheet_render`） | 仅完全未设置时缺省 `http://localhost:5173`；设为空串时报 `worksheet_render: WORKSHEET_RENDER_APP_ORIGIN is empty`；compose worker 设为 `http://app:8787` | `src/capabilities/practice/jobs/worksheet_render.ts`；`docker-compose.yml` |

### 功能开关

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `JUDGE_DURABLE_ENABLED` | app、worker | `false` | `registry` |
| `JUDGE_FALLBACK_PROVIDER` | app、worker | `anthropic-sub`；空串 = 显式关闭兜底 | `registry` |
| `MISCONCEPTION_PROMOTE_ENABLED` | app、worker | `false`；compose 强制项，DB 写入返回 409 | `registry`；`src/server/config/write.ts` |
| `MISCONCEPTION_HARD_CONFIRM_ENABLED` | app、worker | `false` | `registry` |
| `QUESTION_SUPPLY_REFILL_ENABLED` | app、worker | `false` | `registry` |
| `CONFUSABLE_CONTRAST_ENABLED` | worker（夜间发现） | `false` | `registry`；`src/capabilities/practice/jobs/confusable_contrast_nightly.ts` |
| `RESEARCH_MEETING_AGENT_ENABLED` | worker（夜间任务） | `false` | `registry`；`src/capabilities/agency/jobs/research_meeting_agent_nightly.ts` |
| `JUDGE_CALIBRATION_SAMPLING_ENABLED` | worker | `false` | `registry` |
| `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` | worker | `false`；compose 强制项，DB 写入返回 409 | `registry`；`src/server/config/write.ts` |
| `WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD` | worker | `0.85` | `registry` |
| `WORKFLOW_JUDGE_OBSERVE_ENABLED` | worker | `false` | `registry` |
| `WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED` | worker | `false` | `registry` |
| `WAVE6_TRIGGER_MARK_WRONG_ENABLED` | app、worker | `true` | `registry` |
| `WAVE6_TRIGGER_MASTERY_ENABLED` | app、worker | `true` | `registry` |
| `WAVE6_TRIGGER_DREAMING_ENABLED` | app、worker | `true` | `registry` |
| `WAVE6_TRIGGER_VERIFY_ENABLED` | app、worker | `false` | `registry` |
| `AUTO_INTERVENTION_EXPANSION_ENABLED` | app、worker | `false` | `registry` |
| `INTERVENTION_DISABLED_METHOD_IDS` | app、worker | `[]`；CSV 解析为数组 | `registry` |
| `COPILOT_SUBAGENT_ENABLED` | app、worker | `true` | `registry` |
| `NOTES_MASTERY_SUBSCRIPTION_ENABLED` | app、worker | `true`；关则掌握进度不入队笔记 refinement | `registry`；`src/capabilities/notes/server/mastery-progress-subscription.ts` |
| `COPILOT_NUDGE_ENABLED` | app、worker | `false` | `registry` |
| `COPILOT_NUDGE_DAILY_MAX` | app、worker | `3` | `registry` |
| `COPILOT_NUDGE_EXPIRES_HOURS` | app、worker | `24` | `registry` |
| `COPILOT_NUDGE_STREAK_N` | app、worker | `3` | `registry` |
| `COPILOT_NUDGE_KC_COOLDOWN_HOURS` | app、worker | `24` | `registry` |
| `PLACEMENT_PROBE_ENABLED` | app、worker | `false`；compose 强制项，DB 写入返回 409 | `registry`；`src/server/config/write.ts` |
| `PROJECTION_IS_WRITER_ITEM_CALIBRATION` | app、worker | `false`；env 只认字面 `1` 为 true | `registry` |
| `SELECTION_POLICY` | app、worker | `softmax_mfi`；只接受 `legacy`/`softmax_mfi` | `registry` |
| `HUB_SYNC_MODE` | worker（夜间同步） | `off`；只接受 `off`/`shadow`/`apply` | `registry` |

### 调参

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `AI_RATE_LIMIT_MAX` | app | `30` | `registry`；`src/kernel/request-rate-limit.ts` |
| `AI_RATE_LIMIT_WINDOW_MS` | app | `10000` | `registry`；`src/kernel/request-rate-limit.ts` |
| `JUDGE_CALIBRATION_BATCH_MAX` | worker | `20`；范围 1–50 | `registry` |
| `JUDGE_CALIBRATION_WINDOW_DAYS` | worker | `7`；范围 1–90 | `registry` |
| `JUDGE_CALIBRATION_REJUDGE_PROVIDER` | worker | `anthropic-sub` | `registry` |
| `JUDGE_CALIBRATION_REJUDGE_MODEL` | worker | `claude-opus-4-8` | `registry` |
| `KC_DEDUP_DISTANCE_MAX` | worker（夜间去重） | `0.1` | `registry` |
| `KC_DEDUP_WINDOW_DAYS` | worker（夜间去重） | `7` | `registry` |
| `KC_DEDUP_MAX_PAIRS` | worker（夜间去重） | `50` | `registry` |
| `TAGGING_MATCH_THRESHOLD` | app、worker | `0.55` | `registry` |
| `BACKUP_IMPORT_MAX_BYTES` | app（导入 API） | `1000000000`；低于 1 MB 时告警并回退默认 | `registry`；`src/capabilities/observability/api/backup-import.ts` |

### 可观测

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `LMNR_PROJECT_API_KEY` | app、worker | 空或未设时跳过 Laminar SDK 与导出 | `src/server/ai/laminar-tracing.ts` |
| `LMNR_DEV_TRANSCRIPTS` | app、worker | 只有字面 `1` 且 `NODE_ENV=development` 时开启 | `src/server/ai/laminar-transcript.ts` |
| `LMNR_DEBUG` | app、worker | 只要设置就拒绝初始化 tracing | `src/server/ai/laminar-tracing.ts` |
| `LMNR_TRACE_METADATA` | app、worker | 只要设置就拒绝初始化 tracing | `src/server/ai/laminar-tracing.ts` |
| `LMNR_SPAN_CONTEXT` | app、worker | 只要设置就拒绝初始化 tracing | `src/server/ai/laminar-tracing.ts` |

### 脚本、运维与测试

| 键 | 谁读 | 未设置时 | 出处 |
| --- | --- | --- | --- |
| `API_SMOKE_BASE_URL` | 脚本（`api:smoke`） | `http://localhost:3001` | `scripts/api-smoke.ts` |
| `AUDIT_READ_DATABASE_URL` | 脚本（`ops:threshold-calibration`） | 回落到 `DATABASE_URL`；session 固定只读 | `scripts/ops-threshold-calibration.ts`；`src/server/env.ts` |
| `B3_GATE_CONFIRM_CLONE` | 脚本（`b3:gate`） | 不等于 `1` 时拒绝运行 | `scripts/b3-gate.ts` |
| `DELIVERY_API_PORT` | 脚本（`delivery:evidence`） | `8787` | `scripts/delivery-evidence.ts` |
| `DELIVERY_API_BASE` | 脚本（`delivery:evidence`） | `http://127.0.0.1:<DELIVERY_API_PORT>` | `scripts/delivery-evidence.ts` |
| `DOCKER_HOST` | 脚本（grounding/rehearsal） | 自动尝试 OrbStack / Docker Desktop socket | `scripts/grounding-gate.ts` |
| `PROFILE_CRITIC_OK` | 脚本（`compile:profile`） | 非 `1` 时拒绝非 loopback `DATABASE_URL` | `scripts/compile-profile.ts` |
| `SEED_SYNTHETIC_OK` | 脚本（`seed:synthetic`） | 必须为 `1`，否则拒绝执行 | `scripts/seed-synthetic.ts` |
| `TUNNEL_TOKEN` | 运维（compose/预检） | 空时 `compose:up` 预检失败 | `scripts/cloudflared-preflight.ts`；`docker-compose.yml` |
| `TUNNEL_PROTOCOL` | 运维（compose/预检） | `auto`；只接受 `auto`/`http2`/`quic` | `scripts/cloudflared-preflight.ts` |

### schema 中声明、未见读取

`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`（`src/server/env.ts`）。

## DB 配置层 `system_config`

`system_config` 按 registry 登记的 key 存 jsonb 值，并带 `revision`、`source_note`、`updated_by` 与时间戳；`system_config_journal` 是 append-only 账本（`(key, revision)` 主键，`action` 为 `set`/`clear`/`seed`，payload 记 `prev`/`next`/`note`）；`system_config_epoch` 只有 `id='global'` 一行（`src/db/schema.ts`）。key 空间是 registry 的静态键、动态 `task.<kind>.{provider,model,budget,reasoning,override_global_pin}`，以及已登记的 `lane.{verify_solve,vision_judge,global}.{provider,model}`；secret、boot 输入和 env schema 自身不在表内（`src/core/config/registry.ts`）。

app 与 worker 启动时各 hydrate 一次，之后每 `15_000` ms 刷新；刷新先探测 epoch，同号则跳过全量 SELECT，新快照整块替换内存快照；表缺失、DB 不可用或坏行时保留 last-good 或退回 env + code default（`src/server/config/hydrate.ts`；`server/index.ts`；`src/server/boss/start-worker.ts`）。`pinned` 键的 DB 行会被跳过并告警（`src/server/config/hydrate.ts`）。

写面是 `PATCH /api/admin/config` 与 `POST /api/admin/config/reset`，页面为 `/admin/config`；同一事务内 upsert/删除行、追加 journal、bump epoch，提交后本进程立即 hydrate，响应分别报告提交 epoch 与本进程快照 epoch（`src/capabilities/observability/manifest.ts`；`src/server/config/write.ts`；`src/server/config/admin-config-write.ts`；`src/kernel/ui-surfaces.ts`）。

生效优先级按 key 的 `envMode`：默认 `fallback` = DB > env > code default；`priority` = env 显式 > DB > code default；`pinned` = 只看 env（DB 写入 409）。当前 `pinned` 是 `MISCONCEPTION_PROMOTE_ENABLED`、`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`、`PLACEMENT_PROBE_ENABLED`（`src/core/config/store.ts`；`registry`）。
