# API 资源契约收敛计划

> 状态：已完成（YUK-642～YUK-668；最终收口 YUK-668 / PR #820）
> 总单：[YUK-641](https://linear.app/yukoval-studios/issue/YUK-641)
> 基线：`origin/main@47fdff208095cc515fa2ef253a2d260b5eda4341`
> 范围：Hono capability manifests、对应 handler、shipped Vite SPA caller 与契约测试

完成态：152/152 条 manifest route 已声明 operationId、request/response、成功状态与适用的分页契约；
legacy contract allowlist 为 0；生成的 OpenAPI 含 143 个 path。仍保留的兼容 alias 继续遵守本计划的
Deprecation/调用证据/Sunset 门槛，不因契约清零而无证据删除。

## 1. 结论

Loom 当前 API 已有可靠的资源型基础，但整体仍是“内部业务 RPC + 局部 REST”：

- `/api/assets`、`/api/questions/:id`、统一 token gate、JSON 404/error envelope 已经可复用；
- `practice` 同时表示 paper 集合、paper 详情、review session 创建和 daily stream；
- proposal decision 有三套 URI；
- ingestion、review、placement、solve、admin 中存在大量动词端点；
- 创建状态码、`Location`、列表 envelope、分页和 manifest 元数据不统一。

本计划不追求一次性“纯 REST”。迁移顺序是：**新增 canonical 资源 → shipped SPA 切换 →
旧路径兼容并标记弃用 → 观察调用 → 有真实日期后再设置 Sunset → 删除别名**。异步 AI/OCR/
判分工作继续用 `POST` 创建 operation/job/attempt 等资源，不硬塞进 `PATCH`。

## 2. 目标与非目标

### 目标

1. URI 直接表达领域实体，不再让同一路径承载不同集合。
2. 状态迁移、异步受理、幂等复用能从 method/status/header 看懂。
3. 新客户端只依赖一套 canonical 路径、错误码和分页契约。
4. 旧客户端在兼容窗口内不破坏；弃用信息可由机器读取。
5. manifest 最终成为 OpenAPI 与 route contract test 的单一声明源。

### 非目标

- 不修改 token auth、单用户部署边界或 `/api/health` 豁免。
- 不改变 judge、FSRS、proposal apply、ingestion worker 的业务语义。
- 不把所有现有 payload 一次性包进新 envelope。
- 不在没有调用证据和发布日期时编造 `Sunset` 日期。
- 不在用户当前 YUK-634 checkout 工作。

## 3. 迁移不变量

1. **安全不变量**：破坏性 AI 动作仍只可 propose；canonical URI 不新增直写捷径。
2. **行为不变量**：兼容 alias 调用原业务函数，不复制一套领域逻辑。
3. **可解析 Location**：返回 `Location` 的创建操作必须有可读取的资源路径。
4. **诚实状态码**：新建 `201`；异步受理 `202`；命中现有幂等资源 `200`；无状态变化可用
   `204`；状态冲突 `409`；语义校验失败 `422`，格式/必填错误 `400`。
5. **兼容头**：legacy route 按 RFC 9745 返回 Structured Field Date 形式的 `Deprecation` 与
   `Link: <canonical>; rel="successor-version"`；`Sunset` 只在删除日期获批后添加。
6. **稳定分页**：cursor 必须编码稳定排序键；禁止只按可重复时间戳翻页。
7. **无 big-bang**：每个 phase 可独立合并、回滚和验证。

## 4. Canonical 资源词汇

| 领域实体 | Canonical collection | 说明 |
|---|---|---|
| paper | `/api/papers` | `tool_quiz` 的学习者作答资源视图，不再叫 `practice` |
| review session | `/api/review-sessions` | paper-bound 与普通 review session 的统一创建/读取面 |
| proposal decision | `/api/proposals/:id/decisions` | 创建不可变决策/决策结果；兼容旧 proposal 路径 |
| ingestion session | `/api/ingestion-sessions` | 当前 `learning_session(type=ingestion)` 的资源名 |
| operation/job | `.../:id/extraction-jobs` 等 | AI/OCR/导入/组卷的异步受理资源 |
| attempt/submission | `/api/.../attempts`、`.../submissions` | 用户作答及提交事实 |
| correction | `/api/events/:id/corrections` | 对历史事件的追加纠正，不伪装为原事件覆盖 |
| knowledge node | `/api/knowledge-nodes` | 当前 `/api/knowledge/:id` 实际资源 |
| practice stream | `/api/practice-streams/:date` | daily stream 是按日期寻址的投影视图 |
| backup/restore job | `/api/admin/backups`、`/api/admin/restore-jobs` | 取代 `/api/_/*` 私有命令面 |

## 5. 当前热点到目标路径

| 当前路径 | 问题 | 目标 | Issue |
|---|---|---|---|
| `GET /api/practice` | 名词过载 | `GET /api/papers` | YUK-642 |
| `POST /api/practice` | 在 paper 集合路径创建 session | `POST /api/review-sessions {paper_id}` | YUK-642 |
| `GET /api/practice/:id` | 实际读取 paper | `GET /api/papers/:id` | YUK-642 |
| `POST /api/review/sessions` | 资源被 RPC namespace 包裹 | `POST /api/review-sessions` | YUK-642 |
| proposal 三套 decide URI | 同一概念多套语义 | `POST /api/proposals/:id/decisions` | YUK-645 |
| ingestion `/extract` `/import` `/make-paper` `/rescue` | URL 编码异步命令 | 创建 extraction/import/paper-generation/rescue job | YUK-643 |
| review `/pause` `/resume` `/end` `/reopen` | 状态机藏在命令路径 | session 状态迁移契约 | YUK-644 |
| placement `/start` `/next` `/end` | session/attempt/termination 混合 | placement session + attempts + completion | YUK-644 |
| solve `/submit` `/hint`、review `/submit` `/appeal` | attempt 行为没有资源身份 | attempt/submission/hint-request/appeal | YUK-644 |
| `/api/events/:id/correct` | correction 是动词 | `POST /api/events/:id/corrections` | YUK-644 |
| 创建普遍返回 `200` | HTTP 语义不可区分 | `201/202/200 + Location` 矩阵 | YUK-646 |
| `{rows}`、`{papers}`、裸对象及 limit/offset 混用 | 客户端不可复用 | canonical `{data,page}` + cursor | YUK-646 |
| `ApiRouteDecl` 仅 method/path/load | 无法验证契约 | schema/status/deprecation/operationId/OpenAPI | YUK-647 |

## 6. 分阶段执行

### Phase 1 — papers / review-sessions（YUK-642，已完成）

交付：

- 新增 `GET /api/papers`、`GET /api/papers/:id`；
- 新增 `POST /api/review-sessions`、`GET /api/review-sessions/:id`；
- `POST /api/review-sessions`：无 `paper_id` 创建普通 review session；带 `paper_id` 时验证 paper，
  新建返回 `201`，复用 started/paused session 返回 `200`，两者都返回可解析 `Location`；
- shipped SPA 的 list/detail/session create 切到 canonical 路径；
- 旧 `/api/practice`、`/api/practice/:id`、`/api/review/sessions` 继续工作并返回弃用头；
- stream、answer、submit 与状态迁移不在本 phase 改名。

验收：定向 unit + DB tests、composition、Biome、typecheck；旧 handler 回归用例继续通过。

### Phase 2 — proposal decisions（YUK-645）

先做三套 handler 的语义矩阵：producer kind、允许 decision、是否写事件、apply side effect、幂等键、
重复决策结果、404/409/422。再新增统一 decision resource 和适配层。禁止在 URI 收敛过程中弱化
propose-only 约束。

### Phase 3 — ingestion operations（YUK-643）

把 extract/import/make-paper/rescue 视为异步 operation/job。每次受理返回 `202`、operation id、
`Location` 和当前 state；复用现有 job events/SSE 作为状态读面。`revert` 单独建模为 reversal/correction，
因为它具有审计与可逆性语义。

### Phase 4 — session transitions 与 attempts（YUK-644）

先为 review/placement 写状态迁移表，再决定：

- 简单状态变更可 `PATCH /review-sessions/:id {status}`；
- 需要独立审计身份的动作创建 transition/attempt/appeal/hint-request 资源；
- 所有路径明确 allowed-from、idempotent replay、409 conflict 与结果 representation。

### Phase 5 — status、Location、列表分页（YUK-646）

建立跨 capability response matrix，并提供共享 helper。列表迁移按集合增长风险排序：events/jobs/runs/
questions/proposals 优先；固定小集合可声明 `pagination: none`。迁移期 canonical response 可同时带旧字段，
但新调用方只读 `{data,page}`。

### Phase 6 — manifest / OpenAPI（YUK-647）

`ApiRouteDecl` 渐进增加：

```ts
interface ApiRouteDecl {
  method: HttpMethod;
  path: string;
  operationId?: string;
  request?: { params?: ZodType; query?: ZodType; body?: ZodType };
  responses?: Record<number, ZodType>;
  successStatus?: number;
  pagination?: 'none' | { kind: 'cursor'; defaultLimit: number; maxLimit: number };
  deprecation?: { successor: string; sunset?: string };
  load?: () => Promise<RouteHandler>;
}
```

所有字段先 optional；composition/audit 报告 legacy allowlist，逐包清零。只有 schema 与 runtime response
对齐后才生成 OpenAPI，避免“文档正确、运行时另一套”。

## 7. HTTP 契约矩阵

| 场景 | 状态 | Header/Body |
|---|---:|---|
| 同步创建新资源 | 201 | `Location` + representation/handle |
| 幂等请求命中已有资源 | 200 | 同一 `Location` + existing handle |
| 异步任务已受理 | 202 | operation `Location` + `{id,status}` |
| 成功且无需 body | 204 | 无 body |
| malformed JSON / 缺必填 | 400 | 统一 error envelope |
| 未认证 | 401 | 继续由 token gate 统一处理 |
| 资源不存在 | 404 | 统一 error envelope |
| 版本/状态迁移冲突 | 409 | 当前 version/status + allowed transitions |
| 语义校验失败 | 422 | field/issues 细节 |
| 限流 | 429 | `Retry-After` |
| 未预期错误 | 500 | 不泄漏内部异常 |

## 8. Cursor 契约

Canonical 可增长集合：

```json
{
  "data": [],
  "page": {
    "limit": 50,
    "next_cursor": null
  }
}
```

- 请求参数统一 `limit`、`cursor`；过滤参数仍为领域名；
- `limit` 有 default/max；非法 cursor 返回 `400 invalid_cursor`；
- cursor 编码稳定排序的全部键，例如 `(created_at,id)`；
- 翻页期间新写入不得导致重复或永久跳过旧行；
- offset 仅作为旧路径兼容，不在新 canonical route 扩散。

### Phase 5 落地清单（YUK-646）

本轮按 manifest 全量核对 collection/create handler，并按“资源创建、异步受理、命令/投影”分类，
不以 `POST` 本身推断 `201`：

| 类别 | 已落地契约 |
|---|---|
| 同步创建 | goal、asset、mistake event、review/placement/solve session、answer draft、submission/attempt/appeal/hint request、knowledge edge、event correction、admin subject/trait、PDF page assets、DOCX ingestion session 返回 `201 + Location` |
| 幂等复用 | review session、admin subject、既有 answer draft 等可识别 replay 路径返回 `200 +` 同一 `Location` |
| 异步受理 | ingestion operation 与 durable Copilot run 返回 `202 +` operation/job `Location` |
| 批量创建 | PDF 以首个 page asset 作为 `Location`，并为全部 page asset 返回 `Link: rel="item"`；DOCX 的批量页证据封装在 ingestion session 下，`Location` 指向 session |
| 命令/目标状态替换 | proposal decision、session transition、retract/undo、calibration anchors、trait binding、restore/import 等不虚构新资源，保持 `200`；后续 URI 迁移由对应 phase/manifest 元数据表达 |

所有新增 `Location` 均由契约测试读回；错误边界固定为 `400/401/404/409/422/429/5xx`，
其中 `429` 保留 `Retry-After`。共享 helper 在 `src/kernel/http.ts`，错误 header 透传在
`src/server/http/errors.ts`。

可增长、需要跨页遍历的 JSON 集合已提供 `limit + cursor`、稳定复合排序键与迁移期兼容字段：

| Route | 稳定键 | 兼容字段 |
|---|---|---|
| `GET /api/questions` | 现有排序轴 + 全部 tie-break key | 原 question list 字段 |
| `GET /api/papers` | `(created_at,id)` | `papers` |
| `GET /api/ingestion-sessions` | `(created_at,id)` | `rows` |
| `GET /api/proposals` | 既有 proposal cursor | 原 proposal list 字段 |
| `GET /api/admin/runs` | `(started_at,id)` | `runs` |
| `GET /api/knowledge/edges` | `(created_at,id)` | `edges` |
| `GET /api/mistakes` | `(created_at,id)` | `rows` |
| `GET /api/review/drafts` | `(question.created_at,question.id)` | `rows`、legacy offset |
| `GET /api/admin/traits/:id/journal` | `(revision)`（trait id 绑定在 cursor） | `journal` |

上述响应统一增量提供 `{data,page:{limit,next_cursor}}`；非法 cursor 返回 `400`，同时使用 offset
和 cursor 的兼容路径返回 `400`。`GET /api/jobs/:kind/:id/events` 是 SSE 事件流，继续以
`Last-Event-ID` 作为流式 cursor，不强行套 JSON envelope。

其余 manifest 读面显式归为不分页投影：配置 registry（subjects/traits）、单资源内聚合
（note page、correction state、knowledge tree/node）、固定时间窗/last-N feed（AI changes、Copilot
turns、agent notes）、有硬上限的 typeahead/备课卡，以及 workbench/admin/calibration 等汇总报表。
这些端点不承诺集合遍历；若未来改为可遍历历史，必须先切换 cursor contract，不能继续扩大裸数组。

## 9. Deprecation 与删除门槛

1. canonical route 与兼容 alias 同一 PR 上线；
2. shipped SPA、Postman、测试 fixture 全部切换 canonical；
3. alias 返回 RFC 9745 `Deprecation` 日期 + successor `Link`；
4. 用 access log/测试 inventory 证明没有第一方调用；
5. owner 批准删除日期后才加 RFC 1123 `Sunset`；
6. 至少跨一个发布窗口后删除；删除 PR 单独可回滚。

## 10. 验证与停止条件

每个 phase 至少通过：

- canonical success/error/幂等/Location contract tests；
- legacy payload 与 status 回归；
- `src/capabilities/composition.unit.test.ts`；
- touched-file Biome；
- `pnpm typecheck`；
- 涉及 DB 的定向 `*.db.test.ts`；
- shipped SPA caller 搜索确认无旧路径；
- closeout 时同步 Linear 状态与新发现 follow-up。

出现以下情况时停止扩大范围：

- canonical 模型会弱化 propose-only、安全或审计链；
- 需要 schema migration 才能提供真实资源身份；
- 无法区分“新建”与“幂等复用”；
- `Location` 指向不可读取的假资源；
- 旧路径存在未知外部调用且没有兼容证据。

## 11. Issue 图与完成态

```text
YUK-641 API 收敛总单
├── YUK-642 papers/review-sessions（Done）
├── YUK-645 proposal decisions（Done）
├── YUK-643 ingestion operations（Done）
├── YUK-644 session transitions/attempts（Done）
├── YUK-646 status/Location/cursor（Done）
├── YUK-647 manifest/OpenAPI（Done）
└── YUK-648～YUK-668 capability contract allowlist 清零（Done）
```

各 phase 已复用同一兼容 helper、状态码和测试配方，没有复制领域业务逻辑。后续工作只在出现真实
调用证据与获批 Sunset 时删除 alias，或在新增 route 时保持 audit 的 0-legacy 门禁。
