# Sub 0c: 异步 lane + Tencent OCR 升级 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。每步 checkbox `- [ ]` 追踪进度，完成后改 `- [x]` 并 commit。

**Goal**：把 Sub 0c design 落地。引入 pg-boss 异步 lane（独立 worker container + SSE-as-SoT + LISTEN/NOTIFY + 事务内 ack），把 Tencent OCR 替换为 SubmitQuestionMarkAgentJob 异步 job（含 cloze / 嵌套 / 手写答案 / Tencent 内置判分 evidence），完成配图自动裁剪 + 用户改归属 API。EchoJob 作为 golden E2E 验证整个范式。

**Spec**：`docs/superpowers/specs/2026-05-11-sub0c-async-and-ocr-upgrade-design.md`

**ADRs**：`docs/adr/0002`（OCR 抽取层 / Vision 救援）、`docs/adr/0003`（Provider 抽象延迟）

**关键 fixtures**（已 commit 到 main）：
- `tests/fixtures/tencent_mark_agent_cloze_sample.json` —— parser 主 golden
- `tests/fixtures/tencent_question_split_sample.json` —— 类型设计参考
- `tests/fixtures/tencent_question_split_nested_sample.json` —— 类型设计参考

**预估**：4-5 d 单人推进，14 个 Step。

---

## Step 0: 准备 + 依赖 + schema

- [ ] **Step 0.1**: 当前分支 `sub-0c-implementation`，从 main 起。`git status` 干净。
- [ ] **Step 0.2**: 装新依赖
  ```
  pnpm add pg-boss sharp pg tencentcloud-sdk-nodejs-ocr
  pnpm add -D @types/pg
  ```
  - `pg` 是 pg-boss 内部驱动；`postgres-js` 仍用于 drizzle，**两个驱动共存是被库逼的**。
  - `tencentcloud-sdk-nodejs-ocr` 是 Tencent 官方 SDK（精简版，只装 OCR 产品；自动拉 `tencentcloud-sdk-nodejs-common`）。**直接调 `client.SubmitQuestionMarkAgentJob()` / `client.DescribeQuestionMarkAgentJob()`，零手写签名 / HTTP / 错误形状**。TypeScript 类型自带（`SubmitQuestionMarkAgentJobRequest` 等）。
- [ ] **Step 0.3**: `.env.example` 加一行（pg-boss 共用 DATABASE_URL，但 worker process 可能独立配置）：
  ```
  # pg-boss schema (auto-created on boss.start())。无需手动设。
  ```
  不加新 env vars。
- [ ] **Step 0.4**: Drizzle schema (`src/db/schema.ts`)：
  - `question_block` DROP COLUMN `extracted_prompt_md`
  - `question_block` ADD `structured jsonb`、`figures jsonb NOT NULL DEFAULT '[]'`、`layout_quality text NOT NULL DEFAULT 'structured'`
  - `ingestion_session` ADD `warnings jsonb NOT NULL DEFAULT '[]'`
  - `cost_ledger` ADD `outcome text NOT NULL DEFAULT 'success'`、`pgboss_job_id text`
  - 新表 `job_events`：`id bigserial PK, business_table text, business_id text, event_type text, payload jsonb, occurred_at timestamptz`，索引 `(business_table, business_id, id)`
  - 新表 `echo_jobs`：`id text PK, input text NOT NULL, output text, status text NOT NULL DEFAULT 'queued', error_md text, created_at/updated_at`
- [ ] **Step 0.5**: `pnpm db:generate` 生成 migration 文件；本地 `.env.local` 指向 Neon dev DB 运行 `pnpm db:push`，确认 migration 干净
- [ ] **Step 0.6**: Commit：`chore(sub-0c): add pg-boss/sharp deps + drizzle schema for async lane + OCR upgrade`

---

## Step 1: Core types + Zod schemas

- [ ] **Step 1.1 (red)**: 写 `src/core/schemas/structured_question.test.ts` —— Zod 解析 StructuredQuestion 树（stem + sub），验证 bbox optional、role enum、extraction_evidence 嵌套；解析 FigureRef + BBox。**测试预期 fail**（文件不存在）。
- [ ] **Step 1.2**: `pnpm vitest run src/core/schemas/structured_question` 确认 fail
- [ ] **Step 1.3 (green)**: 实现 `src/core/schemas/structured_question.ts`：
  - `BBox`（zod object，0-1 归一化）
  - `FigureRef`（asset_id / role: 'diagram' / source_* / attached_to_index / attach_confidence: enum / last_reassigned_at?）
  - `StructuredQuestion`（递归类型 + role + sub_questions? + extraction_evidence?）
  - 导出 `structuredToPromptMarkdown(s)` + `structuredToReferenceMarkdown(s)` —— stem 递归拼 passage + sub markdown
  - `RetryableError` / `PermanentError` 类（继承 Error，含 `cause` field）
- [ ] **Step 1.4**: `pnpm vitest run src/core/schemas/structured_question` 全过
- [ ] **Step 1.5**: Commit：`feat(sub-0c): core schemas — StructuredQuestion tree + FigureRef + Retryable/PermanentError`

---

## Step 2: pg-boss foundation

- [ ] **Step 2.1 (red)**: 写 `src/server/boss/client.test.ts` —— `createBoss()` 返回 PgBoss 实例并 `await boss.start()`；start 后能 `boss.send('test', {})` 再 `boss.fetch('test')` 拿到 job。tests 用 testcontainer DATABASE_URL。
- [ ] **Step 2.2**: 跑 fail
- [ ] **Step 2.3 (green)**: 实现
  - `src/server/boss/client.ts`：`createBoss()` 单例，配置 `schema='pgboss'`、`newJobCheckInterval: 200`、`archiveCompletedAfterSeconds: 7*86400`、`expireInSeconds: 600`
  - `src/server/boss/shutdown.ts`：`installShutdownHandler(boss)` 监听 SIGTERM → `await boss.stop({ graceful: true, timeout: 30_000 })` → `process.exit(0)`
  - `src/server/boss/handlers.ts`：`registerHandlers(boss, db)` 注册函数（先空，后续 Step 加 handler）
- [ ] **Step 2.4**: tests 全过；`pgboss.*` schema 自动建出
- [ ] **Step 2.5**: Commit：`feat(sub-0c): pg-boss client + graceful shutdown + handler registry stub`

---

## Step 3: job_events + LISTEN/NOTIFY + SSE 路由

- [ ] **Step 3.1 (red)**: 写 `src/server/events/writer.test.ts` —— `writeJobEvent(tx, payload)` 写一行 + 发 NOTIFY；另写 `src/server/events/listen_loop.test.ts` —— `startListenLoop()` 后 `NOTIFY job_status` 触发回调拿到 payload。
- [ ] **Step 3.2**: fail
- [ ] **Step 3.3 (green)**:
  - `src/server/events/writer.ts`：`writeJobEvent(tx: Db, { business_table, business_id, event_type, payload })` —— 插 job_events RETURNING id；`SELECT pg_notify('job_status', json{event_id, business_table, business_id}::text)`。**必须接收 tx 而非全局 db**，保证事务原子性
  - `src/server/events/sse_router.ts`：in-memory `Map<string, Set<SSEController>>` + `subscribe/unsubscribe/broadcast`
  - `src/server/events/listen_loop.ts`：`startListenLoop(db: Db)` 拿专用 `listenClient = postgres(url, { max: 1 })`，`.listen('job_status', cb)` 解析 payload 调 `broadcast(payload)`
  - `src/server/events/sse_replay.ts`：`computeReplay({ businessTable, businessId, lastEventId })` —— 查 `job_events WHERE business_table=$ AND business_id=$ AND id > $` 返回最大 id 那条（前面过期态）；lastEventId=0 时返回 snapshot（业务行合成）
- [ ] **Step 3.4**: tests 全过
- [ ] **Step 3.5**: Commit：`feat(sub-0c): job_events writer + LISTEN/NOTIFY loop + SSE in-memory router + replay`

---

## Step 4: EchoJob — golden E2E（最关键的 acceptance gate）

- [ ] **Step 4.1 (red)**: 写 `tests/helpers/worker.ts` exports `startTestWorker(db)`、`tests/helpers/sse.ts` exports `openSSEAndCollect(url, opts)`（用 fetch + ReadableStream 解析 SSE，~30 行）；写 `app/api/echo/echo.e2e.test.ts`：POST `/api/echo` 入队 → 开 SSE → 等 `outcome === 'success'` → 断言 payload + DB
- [ ] **Step 4.2**: fail（handler / route / SSE endpoint 都还不存在）
- [ ] **Step 4.3 (green)**:
  - `src/server/boss/handlers/echo.ts`：handler 拿 `{ input: string }` → 业务逻辑（反转字符串）→ 事务内：update echo_jobs + writeJobEvent + pgboss complete via SQL function
  - `app/api/echo/route.ts`：POST，body `{ input }`，insert echo_jobs(status='queued') + `boss.send('echo', { businessId, input })`，return `{ businessId }`
  - `app/api/echo/[id]/events/route.ts`：GET，parse Last-Event-ID header → computeReplay → emit replay events + snapshot → subscribe sse_router → 写 stream
  - `src/server/boss/handlers.ts`：加 `await boss.work('echo', { teamSize: 1 }, echoHandler)`
  - App 启动时调 `startListenLoop()`：放 `instrumentation.ts`（Next.js 自动调一次）
- [ ] **Step 4.4**: `pnpm test` 整套全过，**EchoJob E2E 是 acceptance 头号 gate**
- [ ] **Step 4.5**: Commit：`feat(sub-0c): EchoJob end-to-end — HTTP enqueue → worker → DB → SSE delivers full-state event`

---

## Step 5: Cron 任务

- [ ] **Step 5.1 (red)**: 写 `src/server/boss/handlers/knowledge_propose_nightly.test.ts` —— 直接调 handler 函数，传 testDb + mock runTask；预期：查最近 24h mistakes → 对每条调 KnowledgeProposeTask → 写 proposals。`prune_job_events.test.ts` —— 插 30 天前 events + 1 小时前 events → handler 跑 → 旧的没了、新的还在。
- [ ] **Step 5.2**: fail
- [ ] **Step 5.3 (green)**:
  - `src/server/boss/handlers/knowledge_propose_nightly.ts`：handler 查 `mistakes WHERE created_at > now() - interval '24 hours'`；对每条调现有 `runProposeAndWrite`（已存在）；handler 内部多个失败不互相影响（per-mistake try-catch）
  - `src/server/boss/handlers/prune_job_events.ts`：`DELETE FROM job_events WHERE occurred_at < now() - interval '30 days'`
  - `src/server/boss/handlers.ts` 注册：
    ```ts
    await boss.work('knowledge_propose_nightly', handler);
    await boss.work('prune_job_events', handler);
    await boss.schedule('knowledge_propose_nightly', '0 3 * * *', {}, { tz: 'Asia/Shanghai', singletonKey: 'knowledge_propose' });
    await boss.schedule('prune_job_events', '0 4 * * *', {}, { tz: 'Asia/Shanghai', singletonKey: 'prune_job_events' });
    ```
  - `app/api/_/backfill/knowledge_propose/route.ts`：POST 接 `?since=<date>`，直接调 handler 函数（不进 cron），返回处理统计
- [ ] **Step 5.4**: tests 全过
- [ ] **Step 5.5**: Commit：`feat(sub-0c): cron jobs — knowledge_propose_nightly + prune_job_events + manual backfill endpoint`

---

## Step 6: Tencent Mark Agent client（用官方 SDK）+ 错误映射

> **重要决策**：用 `tencentcloud-sdk-nodejs-ocr` 官方 SDK 而非手写 HTTP 客户端。SDK 自动处理 V3 签名 / endpoint / retry / 错误结构化 + 自带 TS 类型。**删除老的 `src/server/ingestion/ocr_tencent_sign.ts` + 其 test**（不再需要手签）。

- [ ] **Step 6.1 (red)**: 写 `src/server/ingestion/tencent_mark.test.ts`：
  - mock SDK client（用 `vi.mock('tencentcloud-sdk-nodejs-ocr')`）的 `SubmitQuestionMarkAgentJob` 和 `DescribeQuestionMarkAgentJob` 方法
  - `submitOcrJob(params)` → 透传给 SDK，返回 `JobId` 字符串
  - `pollUntilDone(jobId, opts)` → mock 三次返回 `{ JobStatus: 'WAIT' }` / `'RUN'` / `'DONE'` + 完整响应 → 固定 2s 间隔，总耗时 ≈ 4s
  - `pollUntilDone` 超时（5min）→ 抛 RetryableError
  - SDK 抛 `TencentCloudSDKException` `{ code: 'FailedOperation.OcrFailed', message }` → mapper 转 RetryableError
  - SDK 抛 `code: 'InvalidParameterValue.X'` → PermanentError
  - SDK 抛 `code: 'ResourceUnavailable.InArrears'` → PermanentError（账号欠费）
- [ ] **Step 6.2**: fail
- [ ] **Step 6.3 (green)**:
  - `src/server/ingestion/tencent_mark.ts`：
    ```ts
    import { ocr } from 'tencentcloud-sdk-nodejs-ocr';
    const OcrClient = ocr.v20181119.Client;

    function createOcrClient() {
      return new OcrClient({
        credential: {
          secretId: process.env.TENCENT_SECRET_ID!,
          secretKey: process.env.TENCENT_SECRET_KEY!,
        },
        region: process.env.TENCENT_OCR_REGION ?? 'ap-shanghai',
        profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } },
      });
    }

    export async function submitOcrJob(params: {
      ImageUrl?: string;
      ImageBase64?: string;
      ImageUrlList?: string[];
    }): Promise<string> {
      const client = createOcrClient();
      const resp = await client.SubmitQuestionMarkAgentJob(params);
      return resp.JobId!;
    }

    export async function pollUntilDone(
      jobId: string,
      opts = { intervalMs: 2000, timeoutMs: 300_000 },
    ): Promise<DescribeQuestionMarkAgentJobResponse> {
      const client = createOcrClient();
      const deadline = Date.now() + opts.timeoutMs;
      while (Date.now() < deadline) {
        const resp = await client.DescribeQuestionMarkAgentJob({ JobId: jobId });
        if (resp.JobStatus === 'DONE' || resp.JobStatus === 'FAIL') return resp;
        await new Promise((r) => setTimeout(r, opts.intervalMs));
      }
      throw new RetryableError(`Tencent OCR poll timeout after ${opts.timeoutMs}ms`);
    }
    ```
  - `src/server/ingestion/tencent_mark_errors.ts`：`mapTencentError(err: TencentCloudSDKException): RetryableError | PermanentError` —— 取 `err.code` 做 spec § 1.6 错误映射表分类（其它包装 PermanentError，cause 保留原错）
  - **删除** `src/server/ingestion/ocr_tencent_sign.ts` 和 `ocr_tencent_sign.test.ts`（SDK 替代）
- [ ] **Step 6.4**: tests 全过；mock SDK 路径正确
- [ ] **Step 6.5**: Commit：`feat(sub-0c): Tencent Mark Agent via official SDK + poll loop + error mapper (replaces hand-rolled V3 signing)`

---

## Step 7: Tencent response parser

- [ ] **Step 7.1 (red)**: 写 `src/server/ingestion/tencent_mark_parser.test.ts`：
  - `parseMarkAgentResponse(rawCloze, { pageWidth: 1500, pageHeight: 2000 })` → 1 stem + 7 sub；每个 sub 含 options[4] / answers[1] / extraction_evidence.handwriting / extraction_evidence.tencent_grading（含 knowledge_points）
  - `layout_quality === 'structured'`（stem 文本里 7 个空 + 7 个 sub）
  - 构造一个**故意缺 sub** 的合成 fixture（stem 含 10 个 `\d+\.\s*___`，sub 只 7 个）→ `layout_quality === 'partial'` + warnings 非空
  - `flat8ToBBox([77, 967, 1035, 967, 1035, 1015, 77, 1015], 1500, 2000)` → BBox 归一化正确
- [ ] **Step 7.2**: fail
- [ ] **Step 7.3 (green)**:
  - `src/server/ingestion/tencent_mark_parser.ts`：
    - `flat8ToBBox(p, w, h): BBox` —— 取 axis-aligned bbox
    - `parseSubMarkItemTitle(title): { question_no, prompt_text, options }` —— 首行解析题号 + 题面；后续行 regex `^([A-Z])\.\s*(.*)`
    - `parseStemMarkItemTitle(title): { prompt_text }` —— 整段含 inline 空，**不二次拆**
    - `mapGroupType(group: string, answerCount: number): question_type` —— spec § 1.6 GroupType map（multiple-choice + answerCount>1 → multi）
    - `parseMarkAgentResponse(raw, pageMeta): { questions: StructuredQuestion[], figures: Array<{bbox, source_page_index}>, layout_quality, warnings }`
    - layout_quality 启发式：扫 stem 文本 `/(\d+)\.\s*_+/g` → 数空位；对比 sub_questions.length
- [ ] **Step 7.4**: tests 全过（cloze 主 fixture + 合成 partial fixture）
- [ ] **Step 7.5**: Commit：`feat(sub-0c): Tencent Mark Agent parser — cloze tree + extraction_evidence + layout_quality heuristic`

---

## Step 8: 配图裁剪 + 归属启发式 + R2

- [ ] **Step 8.1 (red)**: 写 `src/server/ingestion/crop.test.ts`：用 sharp 生成一张测试图（500×500 纯色 + 一个 100×100 红块），调 `cropAndUploadFigures(args)` → mock R2 收到 N 个 put 调用 + 返回的 FigureRef[].asset_id 非空。`figure_attach.test.ts`：构造 stem + 2 subs（不同 bbox）+ 1 figure bbox 在 sub2 内 → heuristic 派 `attached_to_index === sub2.index`、`attach_confidence === 'high'`；零候选 fallback 到 root + 'low'。
- [ ] **Step 8.2**: fail
- [ ] **Step 8.3 (green)**:
  - `src/server/ingestion/crop.ts`：`cropAndUploadFigures({ pageImage: Buffer, pageAssetId, pageIndex, figureBoxes: BBox[], r2 }): Promise<FigureRef[]>` —— `Promise.all` 并行 sharp.extract + r2.put + 生 FigureRef（默认 attach_confidence: 'low'，等下一步填）
  - `src/server/ingestion/figure_attach.ts`：`assignFigures(figures: FigureRef[], questions: StructuredQuestion[]): FigureRef[]` —— spec § 1.7.1 (a) 启发式：空间包含 → 多候选取最小覆盖（最贴近父）→ 零候选取最近邻 + 'low'；root 兜底
- [ ] **Step 8.4**: tests 全过
- [ ] **Step 8.5**: Commit：`feat(sub-0c): figure crop via sharp + R2 upload + attachment heuristic (spatial containment + nearest)`

---

## Step 9: Tencent OCR pg-boss handler — 第一个真生产 async job

- [ ] **Step 9.1 (red)**: 写 `src/server/boss/handlers/tencent_ocr_extract.test.ts`（boss-driven 集成）：
  - mock Tencent fetch（Submit → JobId / Describe 三次 WAIT/RUN/DONE → cloze response）
  - 插 ingestion_session + 一张 source_asset
  - `boss.send('tencent_ocr_extract', { sessionId, assetId })` → 等 handler 完成
  - 断言：question_block.structured + figures 写入；ingestion_session.status = 'extracted'；job_events 含 'extraction.success' 事件；cost_ledger 含 `outcome='success'` + `pgboss_job_id` 非空
- [ ] **Step 9.2**: fail
- [ ] **Step 9.3 (green)**:
  - `src/server/boss/handlers/tencent_ocr_extract.ts`：
    1. 取 session + asset
    2. download asset bytes (r2.get) → asset URL（如 R2 公开 URL）或直接 base64
    3. `submitJob` → JobId
    4. `pollUntilDone(jobId)` （内部 2s poll）
    5. parse response → questions + figures + layout_quality
    6. `cropAndUploadFigures` → FigureRef[] with bbox
    7. `assignFigures(figures, questions)` → 填 attached_to_index
    8. **事务内**：insert question_block(structured, figures, layout_quality) + writeJobEvent('extraction.success', payload=full state) + update ingestion_session(status='extracted', warnings) + writeCostLedger(outcome='success', pgboss_job_id)
    9. 抛 error → wrapper catch → 分类 Retryable/Permanent → 写 cost_ledger(outcome='failed_*') + writeJobEvent('extraction.failed') → rethrow 让 pg-boss retry / archive
  - 注册在 `handlers.ts`：`await boss.work('tencent_ocr_extract', { teamSize: 1 }, handler)`
- [ ] **Step 9.4**: tests 全过；E2E retry 行为 verify（mock 第一次 fail → 第二次 success）
- [ ] **Step 9.5**: Commit：`feat(sub-0c): tencent_ocr_extract pg-boss handler — first production async job`

---

## Step 10: Extract endpoint 改 enqueue + SSE per session

- [ ] **Step 10.1 (red)**: 写 `app/api/ingestion/[id]/extract/route.test.ts`：POST → 200 + `{ jobId, businessId }`，立即返回；同时 `boss.fetch` 能拿到一条 pending job。`app/api/ingestion/[id]/events/route.test.ts`：开 SSE → 收到 snapshot 事件 → handler 跑完后收到 'extraction.success' live 事件。
- [ ] **Step 10.2**: fail
- [ ] **Step 10.3 (green)**:
  - `app/api/ingestion/[id]/extract/route.ts`：**改 POST 为 enqueue**：插业务行 status='queued' + `boss.send` + return `{ businessId, jobId }`，**移除老的 sync 路径**
  - `app/api/ingestion/[id]/events/route.ts`：SSE endpoint，subscribe `ingestion_session:id`
  - **删除** `src/server/ingestion/cascade.ts` 及其 tests（不再有 sync Tier 1 + auto Vision 升级）
  - **删除** `src/server/ingestion/ocr_tencent.ts` 旧版（保留 `ocr_tencent_sign.ts` 复用）
  - 删除 cascade.test.ts、ocr_tencent.test.ts
- [ ] **Step 10.4**: tests 全过；前述删除文件没引用残留
- [ ] **Step 10.5**: Commit：`feat(sub-0c): extract endpoint → pg-boss enqueue + SSE per session; remove cascade.ts + legacy sync OCR`

---

## Step 11: Rescue endpoint（手动 Vision Tier 2/3 救援）

- [ ] **Step 11.1 (red)**: 写 `app/api/ingestion/[id]/rescue/route.test.ts`：POST `{ page, bbox?, tier: 2 | 3 }` → 同步调 VisionExtractTask → 返回 StructuredQuestion；写入 question_block 时 source='vision_rescue'、version+1
- [ ] **Step 11.2**: fail
- [ ] **Step 11.3 (green)**:
  - `src/server/ingestion/rescue.ts`：`runRescue({ db, sessionId, page, bbox?, tier, strategy?, r2 })` —— 调对应 VisionExtractTask（tier=2 → haiku，tier=3 → sonnet），结果解析为 StructuredQuestion + figures，update question_block
  - `app/api/ingestion/[id]/rescue/route.ts`：POST，同步返回
  - `src/ai/registry.ts`：VisionExtractTask + Heavy 加 `invocation: 'manual_rescue_only' as const` 字段
  - 预留 `strategy?: 'extract' | 'restructure_cloze' | 'restructure_compound'`，仅实现 'extract'，其它 throw `not implemented`
- [ ] **Step 11.4**: tests 全过
- [ ] **Step 11.5**: Commit：`feat(sub-0c): /api/ingestion/[id]/rescue — manual Vision Tier 2/3 rescue endpoint`

---

## Step 12: Figure 重对应 API

- [ ] **Step 12.1 (red)**: 写 `app/api/question-blocks/[id]/figures/[asset_id]/route.test.ts`：PATCH `{ attached_to_index }` → 更新 figures[].attached_to_index = new value、attach_confidence = 'manual'、last_reassigned_at 写入；question_block.version + 1；写一条 `figure.reassigned` job_event；校验 new index 必须在 structured 树内（无效 index → 400）
- [ ] **Step 12.2**: fail
- [ ] **Step 12.3 (green)**:
  - `app/api/question-blocks/[id]/figures/[asset_id]/route.ts`：PATCH handler
  - 校验：读 question_block.structured，walk stem/sub 找 index 是否存在
  - 事务内：update + writeJobEvent + bump version
- [ ] **Step 12.4**: tests 全过
- [ ] **Step 12.5**: Commit：`feat(sub-0c): figure re-attachment API — PATCH /api/question-blocks/:id/figures/:asset_id`

---

## Step 13: cost_ledger 观测 + /api/_/logs/jobs

- [ ] **Step 13.1 (red)**: 写 `app/api/_/logs/jobs/route.test.ts` + `[id]/route.test.ts`：列表返回最近 N 个 pg-boss job（按 outcome / cost / retry 链聚合）；详情返回单 job 全 attempts + 总 cost
- [ ] **Step 13.2**: fail
- [ ] **Step 13.3 (green)**:
  - Update `src/server/ai/log.ts`：`writeCostLedger` 接受 `outcome` + `pgboss_job_id` 可选字段
  - 同步调用点全部 outcome='success', pgboss_job_id=null（向后兼容）
  - async handler 调用点（Step 9）填两个新字段
  - `app/api/_/logs/jobs/route.ts`：SELECT cost_ledger GROUP BY pgboss_job_id ORDER BY MAX(occurred_at) DESC LIMIT N
  - `app/api/_/logs/jobs/[id]/route.ts`：单 job 全 attempts + tool_call_log join
- [ ] **Step 13.4**: tests 全过
- [ ] **Step 13.5**: Commit：`feat(sub-0c): cost_ledger outcome + pgboss_job_id + /api/_/logs/jobs aggregation`

---

## Step 14: Worker entrypoint + Provider 类型放宽

- [ ] **Step 14.1 (red)**: 写 `scripts/worker.test.ts`（如 tsx 直接 spawn 不好测，可跳过 test，用 integration）；写 `src/ai/registry.test.ts`：Provider 类型 union 验证存在
- [ ] **Step 14.2**: fail（或 skip）
- [ ] **Step 14.3 (green)**:
  - `scripts/worker.ts`：
    ```ts
    async function main() {
      const boss = await createBoss();
      await registerHandlers(boss, db);
      await startListenLoop(db);   // worker 也起 LISTEN 吗？不，只在 app 进程。删
      installShutdownHandler(boss);
      console.log('[worker] running');
    }
    main().catch((err) => { console.error(err); process.exit(1); });
    ```
  - 配 `tsconfig.scripts.json` 或 `package.json` 加 `worker:dev` script：`tsx scripts/worker.ts`
  - `package.json` 加 `worker:build`：`tsc -p tsconfig.scripts.json --outDir dist`（Sub 0z 部署会用到）
  - `src/ai/registry.ts`：`export type Provider = 'anthropic' | 'openrouter' | 'gateway' | 'openai';`（widen，runner 只实现 anthropic 分支）
  - `src/server/ai/runner.ts`：在 generateText 调用 + streamText 加 `maxRetries: 0`；用 `AbortSignal.timeout(def.budget.timeout)` 显式（已有）；SDK 错误 catch wrapper 映射 `APICallError`/`AbortError`/网络错 → Retryable/Permanent
- [ ] **Step 14.4**: typecheck 通过；`pnpm worker:dev` 本地 worker 起来；`pnpm dev` 也起得来
- [ ] **Step 14.5**: Commit：`feat(sub-0c): worker entrypoint + Provider type widening + AI SDK retry control`

---

## Step 15: docs + 收尾

- [ ] **Step 15.1**: 更新 `docs/architecture.md`：
  - 新增章节"异步任务层 (pg-boss)"
  - 更新"AI 任务层"：移除 cascade auto-promotion 描述、加 rescue 路径、加 extraction_evidence 概念
- [ ] **Step 15.2**: 跑完整 acceptance（spec § 6 checklist 全过）：
  - EchoJob E2E ✓
  - `/api/_/logs/jobs` 工作 ✓
  - `knowledge_propose_nightly` 手动触发 ✓
  - OCR upgrade 异步 job 端到端 ✓
  - cascade.ts 删除 ✓
  - rescue endpoint ✓
  - extraction_evidence 完整捕获 ✓
  - figure 归属启发式 + 改归属 API ✓
- [ ] **Step 15.3**: `pnpm typecheck && pnpm lint && pnpm test` 三连绿
- [ ] **Step 15.4**: Commit：`docs(sub-0c): architecture.md — async lane + extraction_evidence; final acceptance`
- [ ] **Step 15.5**: 推 PR：`gh pr create --title "Sub 0c: async lane (pg-boss) + Tencent OCR upgrade" --body "<spec link>"`

---

## 收尾后

更新 `docs/superpowers/specs/2026-05-11-sub0c-handoffs.md` § 8 落盘清单 —— `docs/architecture.md` 改完打钩。

Sub 0c handoffs § 7.1（fire-and-forget → pg-boss）应当在 Step 9/10 自然消化（旧的 `runProposeAndWrite` 用 Promise.allSettled 那块改成 pg-boss enqueue）；Step 10 完成时一并 verify 删了那段。

---

## Notes / 防踩坑

- **pg-boss 跟 drizzle-kit 不互动**：drizzle 只管 `public.*`，pg-boss 在 `pgboss.*`，`db:push` 不会触碰。但 testcontainer 起 boss 时 `boss.start()` 自建 schema，可能跟测试并发触发 race —— 用 vitest `singleFork: true`（已配）+ 全局 boss 单例。
- **`postgres-js` 跟 `pg` 共存**：两个驱动各自维护 pool，不能共享连接。spec § 1.5 给定 pool sizing，照搬。
- **SSE timeout**：测试用 10s + ENV `SSE_TEST_TIMEOUT_MS` override；本地 dev 一般 < 2s。
- **`sharp` 在 NAS Docker 里需要 libvips**：Sub 0z 已用 `node:24-bookworm-slim` + `apt-get install libvips`（merged on main）。开发本地 `pnpm add sharp` 装 prebuild binary，零额外配置。
- **Tencent SubmitQuestionMarkAgentJob 并发 10/分钟**：单用户工具不会撞墙；如撞，pg-boss 自动 backoff（job 卡 active 状态）。
- **Region**：Tencent OCR endpoint `ocr.tencentcloudapi.com` 不带 region；但 `TENCENT_OCR_REGION=ap-shanghai`（.env.example 已设）可能影响计费 / latency —— 看实际部署。
