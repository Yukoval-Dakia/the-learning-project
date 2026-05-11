# Sub 0c · Async lane (pg-boss) + OCR Upgrade — Design

**Status**: Brainstormed via /grill-with-docs on 2026-05-11. Ready for plan decomposition.

**Branches off**: Sub 0b1 (API route migration, shipped).

**Blocks**: Sub 1 (Capture Pipeline Rebuild). Parallel-safe with Sub 0z (NAS deployment bootstrap) and Sub 0b2 (UI rebuild).

**Related ADRs**:
- ADR-0001 — TypeScript 单语种 + Python sidecar 逃生舱
- ADR-0002 — 抽取层 = OCR / 分析层 = LLM / Vision = 用户救援
- ADR-0003 — Provider 抽象推迟到真正需要切换时

---

## 0. Goal

把当前**全同步 HTTP** 的后端扩张出一条**异步任务流水线**，并把 OCR 升级为新一代 Tencent 接口 + 结构化存储。Sub 0c 是 Phase 1b 全栈（Sub 1 起）的地基：

1. **异步执行**：pg-boss 内联 worker，docker-compose 独立服务，跨进程通讯走 Postgres LISTEN/NOTIFY，前端走 SSE。
2. **事件溯源**：`job_events` 表 + Last-Event-ID replay → SSE 成为唯一对外通道（SoT）。
3. **OCR 升级**：Tencent EduPaperOCR → QuestionSplitOCR；输出题目级结构 + 配图 bbox；服务端裁剪配图为独立 R2 asset。
4. **Cascade 去 LLM 化**：移除 Vision 自动 fallback；Tier 2/3 只通过 `/api/ingestion/[id]/rescue` 由用户手动触发。

UI 集成、JudgeTask 实现、领域编辑工具集都不在 Sub 0c 范围（推 Sub 1 / 0b2）。

---

## 1. Locked decisions

### 1.1 异步执行 / pg-boss

- **引擎**：pg-boss（v10+），同进程内联 worker；不引入 Redis / BullMQ / Temporal。
- **部署形态**：docker-compose 起两个服务，同 image，不同 command：
  - `app`: `node .next/standalone/server.js`
  - `worker`: `node dist/scripts/worker.js`
- **schema 隔离**：pg-boss 默认 `pgboss.*` schema，业务表在 `public.*`，共 DB；drizzle-kit 不感知 pgboss schema，零迁移冲突。
- **不引入** PgBouncer（pg-boss 跟 transaction-mode pooler 有兼容性问题；NAS PG 直连足够）。

### 1.2 SSE-as-SoT

- **事件存储**：`job_events` 表，`id bigserial PK` 作为 Last-Event-ID。
- **NOTIFY 通道**：单通道 `job_status`，payload 含 `{event_id, business_table, business_id}`。
- **客户端协议**：浏览器原生 `EventSource` API，断线重连自动带 `Last-Event-ID` header。
- **事件 payload**：**full-state**（每条事件包含当前完整业务态），不存 delta。
- **首连接 snapshot**：服务端从业务表合成一条 `event: snapshot` 给客户端，之后转 live。
- **Replay 优化**：同一 business_id 有多条新事件时，replay 只发 `MAX(id)` 那条（前面是过期态）；live 模式逐条推（progress 可视）。
- **保留窗口**：`job_events` 30 天，凌晨 cron 删；`cost_ledger` 不删（审计数据）。

### 1.3 事务模型

Worker handler 跑完后，**单一事务**做四件事：

```sql
BEGIN;
  UPDATE <business_table> SET status='...', ... WHERE id=$1;
  INSERT INTO job_events (...) RETURNING id;
  SELECT pg_notify('job_status', json{event_id, business_table, business_id}::text);
  SELECT pgboss.complete($job_id, $output);
COMMIT;
```

任一失败 → 全 rollback → SSE 不推、cost_ledger 不留矛盾行。

### 1.4 失败语义

- **错误分类**：`RetryableError` vs `PermanentError`，由 handler 显式抛出；未分类裸 `Error` 默认 Permanent（fail-loud）。
- **AI SDK 错误映射**（在 wrapper 一层 catch 做）：
  | SDK 错误 | 分类 |
  |---|---|
  | `APICallError` 5xx / 429 | Retryable |
  | `APICallError` 4xx | Permanent |
  | `AbortError`（自身 timeout） | Retryable |
  | 网络 `ECONNRESET` / `ETIMEDOUT` | Retryable |
  | `finishReason='content-filter'` / refusal | Permanent |
  | tool-calling 死循环至 `maxSteps` | Permanent |
- **Retry 配置**：3 次，指数 backoff `10s / 60s / 300s`。
- **AI SDK 自身 retry 关闭**：`generateText({ maxRetries: 0, ... })`。pg-boss 是唯一 retry 权威。
- **超时**：
  - handler `AbortController(timeout = TaskDef.budget.timeout)`，传给 AI SDK
  - pg-boss `expireInSeconds: 600` 作为兜底（worker 卡死 / OOM 释放）
- **失败暴露**：worker 写业务表 `status='failed' + error_kind + error_md`，commit，NOTIFY；SSE 推 `event: failed`；UI 显示重试按钮（手动重新 enqueue）。

### 1.5 连接池布局

| 进程 | Pool | 用途 | size |
|---|---|---|---|
| **app** | drizzle (postgres-js) | HTTP handler 业务 SQL + `boss.send()` | `max=5` |
| app | pg-boss internal (node-postgres) | enqueue / schedule，不 poll | `max=2` |
| app | `listenClient` (postgres-js) | SSE 专用 LISTEN 长连 | `max=1` |
| **worker** | drizzle (postgres-js) | handler 业务写 + NOTIFY | `max=3` |
| worker | pg-boss internal (node-postgres) | poll + complete | `max=2` |

总占用 13 个 PG 连接，NAS PG `max_connections=100` 默认值富余。

### 1.6 OCR 升级 —— Tencent 试题批改 Agent（异步 Job API）

> **Spec 修订（2026-05-11 grill 反馈）**：原计划的 `EduPaperOCR → QuestionSplitOCR` 同步替换被超集 API 替代。新方向：用 `SubmitQuestionMarkAgentJob` + `DescribeQuestionMarkAgentJob` 异步 job 对，完整覆盖切题 + 手写答案 + 知识点标签 + Tencent 内置判分 evidence。完形填空 / 长 passage + 网格选项 类布局原生支持（已经用真实样本 verify，见 fixtures）。

- **Submit endpoint**：`SubmitQuestionMarkAgentJob`（Action 名），Version `2018-11-19`。请求要点：
  - `ImageBase64` 或 `ImageUrl`（≤10M）；多页用 `ImageBase64List` / `ImageUrlList`，最多 3 张
  - 返回 `JobId`（同步返回，无须 poll Submit 本身）
- **Query endpoint**：`DescribeQuestionMarkAgentJob`，请求只带 `JobId`。
  - `JobStatus` 四态：`WAIT` / `RUN` / `FAIL` / `DONE`
  - `DONE` → 完整响应载荷可读（MarkInfos 树）
  - `FAIL` → 配合 `ErrorCode` / `ErrorMessage`
- **Tencent 错误码 → 我们错误分类映射**：

  | Tencent ErrorCode | 我们的分类 |
  |---|---|
  | `FailedOperation.DownLoadError` | Permanent（输入 URL 失效） |
  | `FailedOperation.ImageDecodeFailed` | Permanent（图损坏） |
  | `FailedOperation.PDFParseFailed` | Permanent |
  | `FailedOperation.OcrFailed` | Retryable（OCR 引擎瞬态） |
  | `InvalidParameterValue.*` | Permanent |
  | `ResourceUnavailable.InArrears` | Permanent（**欠费** —— 单用户工具下，告警并暂停，不是技术问题） |
  | `JobStatus=FAIL` 且无明确码 | Permanent（已处理过的图重试无意义） |

- **响应 shape**（与 QuestionSplitOCR **完全不同**）：

  ```
  MarkInfos[]                                ← 顶层数组（每个 compound 一条）
    .AnswerInfos[]                            ← stem 级别一般空
    .MarkInfos[]                              ← 嵌套！sub-questions
      .AnswerInfos[]                          ← 每 sub 一条
        .HandwriteInfo                        ← 用户手写错答（"C"）
        .HandwriteInfoPositions [x1..y4]      ← 8 数组（4 角）
        .RightAnswer                          ← 正确答案
        .IsCorrect                            ← Tencent 内置判分
        .AnswerAnalysis                       ← 中文解析
        .KnowledgePoints[]                    ← 知识点标签
      .MarkItemTitle                          ← "1. ______\nA. ...\nB. ...\nC. ...\nD. ..."
      .QuestionPositions [x1..y4]
      .QuestionImagePositions [x1..y4][]      ← 配图坐标（无对象，仅坐标）
  ```

- **位置归一化**：8 数组 `[x1,y1,x2,y2,x3,y3,x4,y4]` 取 axis-aligned bounding box：

  ```ts
  function flat8ToBBox(p: number[], w: number, h: number): BBox {
    const xs = [p[0], p[2], p[4], p[6]];
    const ys = [p[1], p[3], p[5], p[7]];
    return {
      x: Math.min(...xs) / w,
      y: Math.min(...ys) / h,
      width: (Math.max(...xs) - Math.min(...xs)) / w,
      height: (Math.max(...ys) - Math.min(...ys)) / h,
    };
  }
  ```

- **MarkItemTitle 解析**：sub 的 `MarkItemTitle = "1. ______\nA. decision\nB. reason\nC. difference\nD. choice"`，parser 拆首行（题号 + 题面）+ 后续行（A/B/C/D 选项，**bbox 信息丢失，可接受**）。stem 的 `MarkItemTitle` 是完整 passage 含内联空，**整体存进 stem.prompt.text，不二次拆分**。

- **完形填空一致性检查**：parser 用 regex `/(\d+)\.\s*_+/g` 扫 stem MarkItemTitle 数空位数 vs `sub_questions.length`。
  - 匹配 → `layout_quality: 'structured'`
  - 数量不一致（如样本里：stem 文本有 7 个空，sub_questions 也是 7 —— 但若上传的原图有 10 个空，stem 文本只识别到 7 也算 partial）→ `layout_quality: 'partial'` + warning 写到 `ingestion_session.warnings[]`

- **存储**：
  - `question_block.structured: jsonb<StructuredQuestion>` 唯一真相（含 stem/sub 树 + extraction_evidence）
  - `question_block.figures: jsonb<FigureRef[]>` 配图元数据 + R2 asset_id（从 `QuestionImagePositions` 派生）
  - `question_block.layout_quality: text` 新增列（`'structured' | 'partial' | 'text_only'`）
  - `question_block.extracted_prompt_md` **删除字段**
  - markdown 通过 `structuredToPromptMarkdown()` 现场派生，**不缓存**

- **配图裁剪**：`sharp` 库，从 `QuestionImagePositions` 派生 bbox → crop 原页 → R2 upload → 写 `FigureRef`。Sub 0c 默认 `role: 'diagram'`（Tencent 不分类）。

- **执行模型 —— 真异步**：
  - `POST /api/ingestion/[id]/extract` → enqueue pg-boss job `tencent_ocr_extract` → 立即 200 `{ status: 'queued', business_id }`
  - 前端开 SSE `GET /api/ingestion/:id/events` 等结果
  - Worker handler：
    1. 调 `SubmitQuestionMarkAgentJob` 拿 `JobId`
    2. **固定 2s 间隔 poll** `DescribeQuestionMarkAgentJob` 直到 `JobStatus ∈ {DONE, FAIL}`
    3. 总超时 5min（150 次 poll）；超时 → 抛 `RetryableError`，pg-boss 重试整 job
    4. `DONE` → parse → 配图裁剪 + R2 upload → 事务内写 question_block + figures + 事件 + ack
    5. `FAIL` → 按错误码分类抛 Retryable/Permanent

- **救援路径不变**：`POST /api/ingestion/[id]/rescue`（body `{ page, bbox?, tier: 2|3, strategy? }`）保留**同步**调用，走 VisionExtractTask / Heavy，写新 version 的 structured。

- **VisionExtractTask / Heavy 在 registry 加 `invocation: 'manual_rescue_only'` 元字段**（文档性，防误用）。

- **Angle != 0 处理**：Sub 0c 仅告警（写 `ingestion_session.warnings[]`），不旋正；旋正预处理推 Sub 1。

- **`cascade.ts` 删除**：原来的 Tier 1 sync + auto-fallback 链路彻底退役。Sub 0c 替换为"单一 Tier 1 异步 job + 用户手动 rescue"两条独立路径。

### 1.7 数据 shape

```ts
// src/core/schemas/structured_question.ts (新)
export interface StructuredQuestion {
  // —— 树结构 ——
  index: number;                                  // 在 compound 内的稳定序号；标量 + parser 自分配
  role: 'standalone' | 'stem' | 'sub';            // standalone = 独立题；stem = 大题（含 passage）；sub = 小题
  parent_index?: number;                          // role='sub' 时指向 stem 的 index

  // —— 业务标识 ——
  question_no?: string;                           // "1" / "(2)" / "三、"；stem 通常 undefined
  question_type: 'single' | 'multi' | 'fill' | 'essay' | 'judge' | 'other';
                                                  // role='stem' 用 'other'

  // —— 题面 ——
  // stem: prompt.text 是共享 passage（含 inline 编号空）
  // sub / standalone: prompt.text 是题面
  prompt: { text: string; bbox?: BBox };

  // —— 题型相关字段 —— bbox 一律 optional（agent 添加时可空、Tencent 部分 endpoint 不返回）
  options: Array<{ label: string; text: string; bbox?: BBox }>;
  answers: Array<{ text: string; bbox?: BBox }>;                  // 标准答案
  parses: Array<{ text: string; bbox?: BBox }>;
  tables: Array<{ text: string; bbox?: BBox }>;

  // —— 嵌套 sub-questions（role='stem' 时存在）——
  sub_questions?: StructuredQuestion[];

  group_bbox?: BBox;                              // compound 外接

  // —— 抽取证据（source='tencent_ocr' 走 SubmitQuestionMarkAgentJob 时填）——
  extraction_evidence?: {
    handwriting?: {                               // 用户手写错答
      text: string;                                // "C" / 转写文本
      bbox?: BBox;
    };
    tencent_grading?: {                           // Tencent 内置判分 —— evidence-only，不当真相
      is_correct: boolean;
      right_answer: string;
      answer_analysis_md: string;
      knowledge_points: string[];                  // ["完形填空", "词义辨析"]
    };
  };

  // —— provenance ——
  source: 'tencent_ocr' | 'vision_rescue' | 'manual' | 'agent_edit';
  source_run_id?: string;                         // 链到 ai_run / ocr job
  last_modified_by?: AgentRef;
}

export interface FigureRef {
  asset_id: string;                               // R2 上裁剪图 asset
  role: 'diagram';                                // Tencent 不分类，默认 diagram
  source_asset_id: string;                        // 原始整页 asset
  source_page_index: number;
  source_bbox: BBox;
  attached_to_index: number;                      // 哪个 StructuredQuestion.index 拥有此图
  attach_confidence: 'high' | 'low' | 'manual';   // high = 空间包含明确；low = 启发式择优；manual = 用户改过
  last_reassigned_at?: string;                    // ISO 8601；manual 时填
}

// BBox 归一化 0-1
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

**Markdown 派生函数**（在 `src/core/schemas/structured_question.ts` 旁同文件导出）：

```ts
export function structuredToPromptMarkdown(s: StructuredQuestion): string {
  if (s.role === 'stem') {
    const lines = [s.prompt.text];
    for (const sub of s.sub_questions ?? []) {
      lines.push('', structuredToPromptMarkdown(sub));
    }
    return lines.join('\n');
  }
  // sub / standalone
  const lines = [s.prompt.text];
  if (s.options.length) {
    for (const o of s.options) lines.push(`${o.label}. ${o.text}`);
  }
  return lines.join('\n');
}

export function structuredToReferenceMarkdown(s: StructuredQuestion): string {
  // 优先 extraction_evidence.tencent_grading.right_answer（来自批改 API）
  // 否则 answers[]（来自普通 OCR）
  // 然后 parses
  // ...
}
```

> **LLM 调用方约定**：当 sub 被单独取出用于 LLM prompt 时，**调用方必须前置注入 stem.prompt.text** 作为上下文（passage），否则 sub 没语境。这条约定 Sub 1 JudgeTask 实现时再形式化为一个 helper `structuredToContextualPrompt(stem, sub)`。

> **关于 bbox 一律 optional**：除了"agent 后续手添加"这个理由外，**Tencent 自身在某些层级也不返回 position**（实测 Mark Agent 的 stem 级 `QuestionPositions = []`，部分 sub 也可能为空数组）。Parser 必须将空数组安全降级为 `bbox = undefined`，不当 fail；后续 UI / LLM 拿不到 bbox 时仅丧失可视化能力，不影响语义。这条约束让"无 bbox"成为合法状态而非缺陷状态。

### 1.7.1 配图归属（figure ↔ question mapping）

Tencent 返回 `QuestionImagePositions: [x1..y4][]`（每张配图的 4 角坐标），**但不告诉我们这张图属于哪道题**。系统需要：

**(a) Parser 初配启发式**（`tencent_mark_parser.ts` 内部）：

1. 对每张配图 bbox，遍历 compound 内所有 StructuredQuestion（含 sub）的 prompt.bbox + group_bbox
2. 找空间包含（图 bbox 完全在 question bbox 内）的候选；多个候选取**面积最大覆盖**（最贴近的父）
3. 若无空间包含候选，取**最近邻**（图中心到 question 中心的欧氏距离最小）；置 `attach_confidence: 'low'`
4. 若 compound 完全无 bbox 信息（极端情况），挂在 root（index=0），置 `attach_confidence: 'low'`
5. 有明确空间包含且唯一候选 → `attach_confidence: 'high'`

**(b) 用户重对应 API**（Sub 0c 后端 endpoint）：

```
PATCH /api/question-blocks/:id/figures/:figure_asset_id
Body: { attached_to_index: number }

行为:
- 更新 question_block.figures[].attached_to_index
- 设 attach_confidence = 'manual'
- 写 last_reassigned_at = now()
- question_block.version + 1
- 校验：new attached_to_index 必须在 structured 树中存在（含 sub_questions）
- 写一条 job_events，event_type='figure.reassigned'，触发 SSE 推到当前 ingestion session 订阅者
```

**(c) UI（Sub 0b2 工作，仅记录契约）**：

- 渲染 question_block 时按 figures.attached_to_index 在对应题旁内联渲染配图
- `attach_confidence === 'low'` → 配图边框标红 + 提示"系统不确定这张图属于哪道题，点击重新归属"
- 重对应 = 拖拽 / 下拉选目标题号 → 调 PATCH endpoint → 等 SSE 事件刷新

### 1.8 Cron

| Cron | Schedule | singletonKey | 幂等策略 |
|---|---|---|---|
| `knowledge_propose_nightly` | `0 3 * * *` (Asia/Shanghai) | `knowledge_propose` | window-based：过去 24h 内 created_at 的 mistakes |
| `prune_job_events` | `0 4 * * *` | `prune_job_events` | DELETE 天然幂等 |

- **时区**：pg-boss 构造时 `tz: 'Asia/Shanghai'`。
- **错过的运行**：跳过，不补跑。NAS 关机 → 那天的 propose 不跑，用户用 `POST /api/_/backfill/knowledge_propose?since=<date>` 手动补。
- **首次部署**：**不**自动 backfill 老 mistake，只对未来新增生效。

### 1.9 可观测性

- `cost_ledger` 新增：
  - `outcome: text` (`'success' | 'failed_retryable' | 'failed_permanent'`)
  - `pgboss_job_id: text` (nullable，同步任务为 null)
- **每次尝试都写一行**（失败行 cost/tokens 为 0）。
- 新增 `GET /api/_/logs/jobs`：返回最近 N 个 pg-boss job 视图（success / failed / retrying），join cost_ledger 后输出每条 job 的总 cost / retry 链 / 当前 outcome。**不**直接暴露 `pgboss.*`。
- 新增 `GET /api/_/logs/jobs/:id`：单 job 详情（含 cost 聚合、所有 attempts、所有 events）。
- Worker stdout 日志：pino 结构化输出，docker-compose 收集；**不**入库。

### 1.10 Provider abstraction（部分）

- `Provider` 类型放宽至 `'anthropic' | 'openrouter' | 'gateway' | 'openai'`。
- `src/server/ai/runner.ts` 工厂只实现 `'anthropic'` 分支，其它 throw `not implemented`。
- 触发完整 factory 化的条件见 ADR-0003。

---

## 2. Source layout (delta)

```
src/
  core/
    schemas/
      structured_question.ts          # 新 — StructuredQuestion / FigureRef / BBox + Zod
      job_event.ts                    # 新 — JobEvent payload schema
      errors.ts                       # 新 — RetryableError / PermanentError
  db/
    schema.ts                         # 改 — question_block: drop extracted_prompt_md, add structured + figures; cost_ledger: +outcome/+pgboss_job_id; new job_events / echo_jobs tables
  ai/
    registry.ts                       # 改 — Provider 类型放宽；VisionExtract* 加 invocation 字段
  server/
    boss/
      client.ts                       # 新 — createBoss() / pg-boss 单例构造
      handlers.ts                     # 新 — registerHandlers(boss, db) (含 echo / knowledge_propose_nightly / prune_job_events / tencent_ocr_extract)
      shutdown.ts                     # 新 — installShutdownHandler
      handlers/
        echo.ts                       # 新 — EchoJob handler (validation)
        tencent_ocr_extract.ts        # 新 — 真生产 job：Submit → poll → parse → crop → write
        knowledge_propose_nightly.ts  # 新 — Dreaming lane cron handler
        prune_job_events.ts           # 新 — 房间清理 cron handler
    ai/
      runner.ts                       # 改 — provider factory + maxRetries:0 + AbortSignal
      errors.ts                       # 新 — mapSdkError(err): Retryable | Permanent
    events/
      writer.ts                       # 新 — writeJobEvent(tx, ...) + pg_notify
      sse_router.ts                   # 新 — in-memory Map<business_id, SseController[]>
      sse_replay.ts                   # 新 — Last-Event-ID query + snapshot synth
      listen_loop.ts                  # 新 — start listenClient + dispatch to router
    ingestion/
      tencent_mark.ts                 # 新 — SubmitQuestionMarkAgentJob + DescribeQuestionMarkAgentJob 客户端
      tencent_mark_parser.ts          # 新 — raw response → StructuredQuestion 树 (含 extraction_evidence)
      tencent_mark_errors.ts          # 新 — Tencent ErrorCode → Retryable/Permanent 映射
      crop.ts                         # 新 — sharp 裁剪 + R2 upload (从 QuestionImagePositions 派生)
      rescue.ts                       # 新 — Vision Tier 2/3 同步调用 + 写 structured
      # cascade.ts                    # 删除 — Tier 1 sync + auto-fallback 链路彻底退役
      # ocr_tencent.ts                # 删除 — 旧 EduPaperOCR 同步客户端
      # ocr_tencent_sign.ts           # 保留 — V3 签名机制复用
    backfill/
      knowledge_propose.ts            # 新 — 手动 backfill handler

app/api/
  echo/
    route.ts                          # 新 — POST enqueue echo job
    [id]/
      events/route.ts                 # 新 — SSE endpoint with Last-Event-ID replay
  ingestion/
    [id]/
      rescue/route.ts                 # 新 — POST Vision Tier 2/3 同步
  question-blocks/
    [id]/
      figures/
        [asset_id]/route.ts           # 新 — PATCH 重对应 attached_to_index（用户改归属）
  mistakes/
    [id]/
      events/route.ts                 # 新 — SSE endpoint per mistake
  _/
    logs/
      jobs/route.ts                   # 新 — list view
      jobs/[id]/route.ts              # 新 — detail aggregation
    backfill/
      knowledge_propose/route.ts      # 新

scripts/
  worker.ts                           # 新 — docker-compose worker entrypoint

tests/
  helpers/
    worker.ts                         # 新 — startTestWorker(testDb)
    sse.ts                            # 新 — openSSEAndCollect(url, opts)
    mocks/
      anthropic.ts                    # 新 — MSW handlers
      tencent.ts                      # 新 — MSW handlers (SubmitQuestionMarkAgentJob + DescribeQuestionMarkAgentJob)
  fixtures/
    tencent_question_split_sample.json          # 单题 + 配图样本（math，第 5 题有 Figure）
    tencent_question_split_nested_sample.json   # 嵌套 stem/sub 样本（语文阅读理解，3 个 sub）
    tencent_mark_agent_cloze_sample.json        # 完形填空样本（DescribeQuestionMarkAgentJob 真实响应，7 sub）

middleware.ts                         # 改（可能） — SSE endpoints 仍走 x-internal-token
package.json                          # 改 — +pg-boss, +sharp; (?) +@types/pg
```

---

## 3. Schema migration

Drizzle migration `drizzle/0XXX_sub0c.sql` 大致内容：

```sql
-- question_block: 删除 extracted_prompt_md，加 structured + figures + layout_quality
ALTER TABLE question_block DROP COLUMN extracted_prompt_md;
ALTER TABLE question_block ADD COLUMN structured jsonb;
ALTER TABLE question_block ADD COLUMN figures jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE question_block ADD COLUMN layout_quality text NOT NULL DEFAULT 'structured';
  -- 'structured' | 'partial' | 'text_only' —— UI 据此决定是否提示用户走 rescue

-- ingestion_session: 加 warnings jsonb (parser 写非致命警告，例如 angle != 0 / 空数不匹配)
ALTER TABLE ingestion_session ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

-- cost_ledger: 加 outcome + pgboss_job_id
ALTER TABLE cost_ledger ADD COLUMN outcome text NOT NULL DEFAULT 'success';
ALTER TABLE cost_ledger ADD COLUMN pgboss_job_id text;

-- 新表
CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  business_table text NOT NULL,
  business_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_events_business ON job_events (business_table, business_id, id);

CREATE TABLE echo_jobs (
  id text PRIMARY KEY,
  input text NOT NULL,
  output text,
  status text NOT NULL DEFAULT 'queued',
  error_md text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**pg-boss schema (`pgboss.*`)**：由 `boss.start()` 第一次调用时自动建，drizzle-kit 不管。

**Migration 顺序**：
1. drizzle migration 跑（drop / add columns + new tables）
2. app 启动 → `boss.start()` → pg-boss schema 自建
3. worker 启动 → 同上（若 app 先起则 worker 启动时 pgboss.* 已存在）

**老数据**：开发态，无 prod 数据。`question_block` 现有行 `extracted_prompt_md` 被丢弃，`structured` / `figures` 空。**不 backfill**。

---

## 4. SSE protocol

### 4.1 Endpoint shape

```
GET /api/<business>/:id/events
Headers:
  x-internal-token: <token>            # middleware 仍守
  Last-Event-ID: <bigint>              # optional, by EventSource auto on reconnect
Response:
  Content-Type: text/event-stream
  Cache-Control: no-cache, no-transform
  Connection: keep-alive
  X-Accel-Buffering: no                # 防 Cloudflare Tunnel buffer
```

### 4.2 Server 流程

```
1. Parse Last-Event-ID header (default 0)
2. 取数据库快照：
   - if Last-Event-ID == 0:
       row = SELECT * FROM <business> WHERE id=$1
       emit { id: row.latest_event_id, event: 'snapshot', data: row }
       cutoff = row.latest_event_id
   - else:
       events = SELECT * FROM job_events
                  WHERE business_table=$1 AND business_id=$2 AND id > $LastEventID
                  ORDER BY id ASC
       if events.length > 0:
         emit only events[events.length - 1]   # full-state，前面过期
         cutoff = events[last].id
       else:
         cutoff = $LastEventID
3. Subscribe in-memory router by (business_table, business_id)
4. On NOTIFY callback:
   if payload.event_id > cutoff:
     SELECT * FROM job_events WHERE id = payload.event_id
     emit { id, event: type, data: payload }
5. On disconnect: unsubscribe
```

### 4.3 In-memory router

```ts
// src/server/events/sse_router.ts
const subscribers = new Map<string, Set<SSEController>>();   // key = `${table}:${id}`

export function subscribe(table: string, id: string, ctrl: SSEController) {
  const key = `${table}:${id}`;
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key)!.add(ctrl);
}

export function broadcast(notify: NotifyPayload) {
  const key = `${notify.business_table}:${notify.business_id}`;
  const set = subscribers.get(key);
  if (!set) return;                            // 无订阅者，丢弃（重连时会补）
  for (const ctrl of set) ctrl.enqueue(notify);
}
```

### 4.4 LISTEN loop

```ts
// src/server/events/listen_loop.ts
export async function startListenLoop() {
  const listenClient = postgres(DATABASE_URL, { max: 1 });
  await listenClient.listen('job_status', (raw) => {
    const payload = JSON.parse(raw) as NotifyPayload;
    broadcast(payload);
  });
}
// 在 app 启动时调一次（next.js instrumentation.ts）
```

---

## 5. Test strategy

### 5.1 三层结构

| 层 | 形态 | 例子 |
|---|---|---|
| handler 单测 | 直接调函数 + mock job + testDb | `echoHandler.test.ts` 测 input='hello' → output='olleh' |
| boss-driven 集成 | testcontainer + 同进程 boss + `boss.send()` | retry 行为 / cron singletonKey / RetryableError 三次后失败 |
| E2E golden | 上述 + fetch route handler + SSE parser | `echo.e2e.test.ts`（详见下） |

### 5.2 EchoJob E2E

```ts
test('Echo job: HTTP enqueue → worker → SSE delivers full-state success event', async () => {
  const boss = await startTestWorker(testDb);

  const { businessId } = await postEcho({ input: 'hello' });
  const events = openSSEAndCollect(
    `/api/echo/${businessId}/events`,
    { timeout: parseInt(process.env.SSE_TEST_TIMEOUT_MS ?? '10000', 10) },
  );
  const final = await events.until((e) => e.outcome === 'success');

  expect(final.payload.output).toBe('olleh');
  expect((await db.select().from(echo_jobs).where(eq(echo_jobs.id, businessId)))[0]).toMatchObject({
    status: 'success',
    output: 'olleh',
  });

  await boss.stop({ graceful: true });
});
```

### 5.3 OCR parser tests — 三个 golden fixture

用 `tests/fixtures/tencent_mark_agent_cloze_sample.json` 作主 fixture（DONE 状态的完整响应）：

```ts
test('parses cloze (1 stem + 7 subs) with extraction_evidence', async () => {
  const raw = JSON.parse(readFileSync('tests/fixtures/tencent_mark_agent_cloze_sample.json', 'utf8'));
  const parsed = parseMarkAgentResponse(raw, { pageWidth: 1500, pageHeight: 2000 });

  // 顶层应当是 1 个 stem
  expect(parsed.questions).toHaveLength(1);
  expect(parsed.questions[0].role).toBe('stem');
  expect(parsed.questions[0].sub_questions).toHaveLength(7);

  // 第 1 个 sub
  const sub1 = parsed.questions[0].sub_questions![0];
  expect(sub1.role).toBe('sub');
  expect(sub1.question_no).toBe('1');
  expect(sub1.options).toEqual([
    { label: 'A', text: 'decision' },
    { label: 'B', text: 'reason' },
    { label: 'C', text: 'difference' },
    { label: 'D', text: 'choice' },
  ]);
  expect(sub1.answers[0].text).toBe('C');                                    // RightAnswer
  expect(sub1.extraction_evidence?.handwriting?.text).toBe('C');              // 用户写了 C
  expect(sub1.extraction_evidence?.tencent_grading?.is_correct).toBe(true);
  expect(sub1.extraction_evidence?.tencent_grading?.knowledge_points).toContain('完形填空');

  // layout_quality 检查（stem 文本里 7 个空，sub 也是 7 个 → structured）
  expect(parsed.layout_quality).toBe('structured');
});

test('parses standalone math questions + figure on Q5 (QuestionSplitOCR-legacy fixture, optional)', async () => {
  // 仅当未来需要回兼时启用
});

test('parses nested compound — passage stem + 3 subs (QuestionSplitOCR-style)', async () => {
  // 当前 fixture 是旧版 endpoint 响应，此 test 标 @skip，仅作 type 验证
});
```

> 注意：旧 fixtures（`tencent_question_split_sample.json` / `tencent_question_split_nested_sample.json`）保留作为**类型设计参考**（StructuredQuestion 树形的源头），但 Sub 0c 实现的 parser 是 `parseMarkAgentResponse`，**不**针对 QuestionSplitOCR 响应。

### 5.4 Mock 策略

- **Anthropic / Tencent / R2**：MSW 拦截，**绝不**调真 API
- **sharp**：实际跑（小图，快，binary 跨平台无问题）
- **pg-boss schema 创建**：让 `boss.start()` 自然建；不在 global-setup 里 pre-build

### 5.5 不测的东西

- pg-boss cron 实际触发（手动 `boss.send('knowledge_propose_nightly', {})` 验证 handler 正确性）
- docker-compose 启动（Sub 0z 工作）
- 浏览器 EventSource 行为（Node 用自写 stream parser）

---

## 6. Acceptance checklist

Merge gate — 5 必须 + 文档 + 性能：

- [ ] **EchoJob E2E 通过**：HTTP → worker → DB → SSE 收到 full-state success event
- [ ] **`/api/_/logs/jobs` + `/api/_/logs/jobs/:id` 工作**：EchoJob 跑后能在列表 / 详情中看到，含 cost / outcome / retry 链
- [ ] **`knowledge_propose_nightly` 手动 trigger 跑通**：`boss.send('knowledge_propose_nightly', {})` → 产出 ≥1 条 proposals 行（测试前先插一条最近 24h mistake）
- [ ] **OCR upgrade（异步 job 端到端）**：用 cloze fixture 模拟 Tencent → enqueue `tencent_ocr_extract` → worker poll → parse → mock R2 收到裁剪图 upload → `question_block.structured + figures + layout_quality` 正确落库 → SSE 收到 `extraction.success` 事件
- [ ] **Cascade.ts 删除**：源码中无 `cascade.ts` 引用；不存在 Tier 1 → Tier 2/3 自动升级路径
- [ ] **Rescue endpoint**：`POST /api/ingestion/[id]/rescue` 同步返回 StructuredQuestion（含新 source='vision_rescue'）；写入后 question_block.version 递增
- [ ] **extraction_evidence 完整捕获**：cloze fixture 解析后，每个 sub 的 handwriting + tencent_grading 都正确存入
- [ ] **图归属启发式 + 用户改归属**：parser 给每张 figure 派初始 `attached_to_index` + `attach_confidence`；`PATCH /api/question-blocks/:id/figures/:asset_id` 改归属、bump version、写 `figure.reassigned` 事件、SSE 推前端
- [ ] `docs/architecture.md` 加"异步任务层 (pg-boss)" + 更新"AI 任务层"
- [ ] pg-boss handler 平均 poll latency < 500ms（`newJobCheckInterval: 200` 配置）
- [ ] SSE 从 NOTIFY 到 client receive < 100ms（local）
- [ ] worker SIGTERM → exit < 5s graceful（in-flight job 完成或 30s 强 kill）
- [ ] `pnpm typecheck && pnpm lint && pnpm test` 全绿

---

## 7. Risks + mitigations

| 风险 | 缓解 |
|---|---|
| Tencent SubmitQuestionMarkAgentJob 并发限制 10 张/分钟 | 单用户工具流量远低于此；超阈值时 pg-boss 自动 backoff（job 卡 active 状态等下次 poll 周期）|
| Tencent JobStatus=FAIL 且 Tencent 端图损坏，retry 无意义 | ErrorCode → Permanent 映射；FAIL 写 `outcome='failed_permanent'`，UI 提示用户重传图或走 rescue |
| Tencent 账号欠费（`ResourceUnavailable.InArrears`） | Permanent，整段 extraction 链路 fail-loud；UI 显示明确的"账号欠费"提示而非通用错误 |
| cloze 解析时 stem 文本里 N 个空但 sub_questions 只有 M (<N) | parser 写 `layout_quality='partial'` + warning；UI 在 Sub 0b2 提示用户走 rescue |
| 5min 总超时仍然不够（极复杂多页 PDF） | 抛 RetryableError → pg-boss 重试整 job 触发新 Submit；若 3 次重试仍超时 → Permanent，告警用户 |
| pg-boss schema 与 drizzle-kit 冲突 | drizzle 只管 `public.*`，pgboss 在 `pgboss.*`；`db:push` 不会触碰 |
| SSE replay 期间正好来 NOTIFY，重复发送 | cutoff 机制 + read-committed 隔离；E2E 测试构造 race 场景 verify |
| Cloudflare Tunnel 默认 buffer 非 chunked 响应 | response 加 `X-Accel-Buffering: no`；Sub 0z 验收清单标记验证 |
| `sharp` 在 docker alpine 缺 libvips | Sub 0z Dockerfile 用 `node:24-bookworm-slim` base（debian），自带 libvips |
| LISTEN 连接断开 / 长时间无活动 | postgres-js `.listen()` 内部自动重连；监听一次性失败 → process exit + docker restart |
| Tencent QuestionSplitOCR 单价 > EduPaperOCR | 接受。单用户工具，月度 OCR 调用数 <1000，绝对成本可忽略 |
| pg-boss singletonKey 在 worker 滚动重启时残留锁 | pg-boss 自带 expire 机制（`expireInSeconds`）保证锁不会永久持有 |
| EventSource 在某些浏览器对 `X-Accel-Buffering` 不敏感 | Sub 0b2 UI 联调时验；Sub 0c 仅保证 server 侧正确 |

---

## 8. Estimate

约 **4-5 d** 单人推进（比初版多 ~1 d，因 OCR 从同步替换升级为真异步 job + extraction_evidence 完整捕获）：

- pg-boss + worker + SSE 基础设施：1.5 d
- `job_events` 表 + replay + cron pruning：0.5 d
- Tencent Mark Agent endpoint（Submit + Describe + poll loop + error 映射）：1 d
- Parser（cloze 树形 + extraction_evidence + layout_quality + figure 归属启发式）+ figure crop：1 d
- Figure 重对应 API（PATCH endpoint + 事件 + 校验）：0.3 d
- Rescue endpoint（同步 Tier 2/3）+ schema migration：0.5 d
- 测试（三 fixture）+ acceptance：0.5 d

---

## 9. Out of scope / followups

| 工作 | 归属 |
|---|---|
| JudgeTask handler 实现 | Sub 1 |
| StructureTask（如需） | Sub 1 |
| 领域工具集（updatePrompt / addOption / ...） | Sub 1 |
| SSE 集成进 UI（rescue 按钮 / 状态 / 重试） | Sub 0b2 |
| Dockerfile multi-stage / docker-compose / Cloudflare Tunnel | Sub 0z |
| AI provider factory 完整化（OpenRouter / Gateway 实现） | ADR-0003 触发条件满足时 |
| 老 ingestion sessions 的 OCR / mistake backfill | 手动 `/api/_/backfill/knowledge_propose`，仅在用户主动触发 |
| Tencent OCR Angle != 0 旋正预处理 | Sub 1 |
| 用户手写错答抽取 | ✅ **Sub 0c 实现**（Tencent Mark Agent 自带 HandwriteInfo，存入 extraction_evidence.handwriting） |
| Tencent 内置判分作为权威判分（替代 JudgeTask） | ❌ 不替代。Sub 0c 当 evidence 存储；Sub 1 JudgeTask 仍独立实现，可用 Tencent 判分作为输入信号 / 互相校验 |
| Figure role 细分（chart / illustration / photo） | 推 — 需要时再加 Vision 分类 step |
| R2 配图 GC（rescue 后旧 figures 不删） | 推 — `crop_refs` 单用户工具不会爆 |
