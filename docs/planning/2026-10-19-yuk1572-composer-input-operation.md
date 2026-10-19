# YUK-1572 第二片 — composer due 输入直读 typed operation + 标签事实归属

Base：`origin/main 696449125b53b0c35a210dbc9a57292f014712de`；branch
`refactor/yuk-1572-composer-input-operation`；源码 head 见最新 commit（下方验证记录）。
本片不改 `practice/public.ts`、测试、UI、provider 链；不出 PR。

## 操作与归属

`collectComposerInputs` 的 due 候选不再构造内部
`Request → handleReviewDue → Response.json` 往返，直调 HTTP adapter 共用的
typed 读取 `queryReviewDue(db, { limit: REVIEW_DUE_LIMIT_MAX })`；due 页读取
失败→空候选的降级策略由输入收集侧显式持有（私有 `readComposerDueRows`），
HTTP adapter 保留协议整形与错误映射原样。knowledge id→显示名批量读取独立成
`knowledge-labels.ts`——inputs 与 view 共用同一事实源，view 不再为取名字
依赖输入编排模块。

## 调用方退出的知识

- `collectComposerInputs` 不再知道：URL/Request/Response 形状、`Response.json()`
  解析、`rows?:` 可选包装与 `?? []` JSON 形状假设、limit 的字符串编码。
- `stream-view` 不再知道：knowledge 名读取住在哪个编排模块里（原
  `import { knowledgeLabels } from './stream-inputs'` 解除）。
- composer 仍持有（有意保留）：due 页失败→空候选的降级策略本身——它属于
  「输入收集」语义，不属于传输层。

## 失败/序列化边界逐边对照（旧 HTTP 内调 → 新直读）

| 事件 | 旧路径 | 新路径 |
|------|--------|--------|
| queryReviewDue 抛 ApiError | errorResponse→结构化 body（无日志）→`rows` 缺→`[]` | catch→`[]`，同样不记日志 |
| queryReviewDue 抛普通 Error | errorResponse→`console.error('unhandled error',{message,stack,timestamp})`→500 body→`[]` | catch→同款 `console.error('unhandled error',…)`→`[]` |
| 成功 | `Response.json({rows})`→`.json()` 取 `question_id`/`knowledge_ids` | 直接用 typed `ReviewDueRow` 同名字段（JSON 稳定字段值相同） |
| `Response.json` 序列化失败 | errorResponse→`[]` | 不再可达：无序列化往返。ReviewDueRow 全部来自 Drizzle timestamp/jsonb 投影（Date、string[]、字符串枚举），不可序列化值现实不可达（domain 假设，非等价伪装） |
| `.json()` 解析失败 | 不可达（body 由 Response.json 产出） | 不适用 |
| due 读取之后的所有查询（intervention 候选+准入、变式、new_check、frontier、practiceList、metadata、labels） | 在 collectComposerInputs 体内、无 try/catch→抛出 | 仍在 `readComposerDueRows` 之外→抛出，逐条未动 |
| tx 内调用（recompose 传 `tx`） | handler 内 catch 后同 tx 继续后续查询；若 PG 事务已 aborted，后续查询抛 abort 错 | 完全相同：catch 边界相同、同一句柄、同一顺序 |

保留未动：intervention due-union（前缀并集 + dedup + `includeInterventionDiagnostics`
准入）、`readAutomaticallyServableQuestionIds` 全部调用点、null-state 优先/
round-robin/goal 软偏置（queryReviewDue 内部原样）、`resolveDailyPracticeBudget`
与 view 侧 `recoveryRowIds` 关系、全部过滤器（notDraft/suspended/servability）。

## 两个真实维护场景 前→后

1. **改 due 页上限或降级策略**（如降降级日志改 metrics）：旧需同时懂
   `kernel/http.errorResponse`（全路由共用，不能为 composer 单改）与
   composer 端 `rows ?? []` 的形状巧合；新只需改 `readComposerDueRows` 一处，
   HTTP adapter 对真实路由行为不变。
2. **改 due 页 ceiling**（200→其它或可调）：旧 `due-list` clamp 与
   `stream-inputs` 的 `DUE_INPUT_LIMIT=200` 是两个独立字面量，可静默漂移使
   composer 拿到截断页；新 composer 直接请求 `REVIEW_DUE_LIMIT_MAX`，请求与
   clamp 同一份事实，不可能分叉。
3. **另一处 stream surface 需要知识名**：旧只能 import 输入编排模块
   （view→inputs 反向同理），新 `knowledge-labels.ts` 是唯一完整读取 owner。

## 实际移除的旧职责

- stream-inputs：Request 构造、Response.json 解析、`rows?` shape cast、
  `DUE_INPUT_LIMIT` 字面量、`knowledgeLabels` 函数本体（移出非删）。
- stream-view：对 `./stream-inputs` 的 import 边解除。
- due-list：唯一改动是导出 `REVIEW_DUE_LIMIT_MAX` 并在 clamp 使用；无逻辑变更。

## 接口与行数/边 delta

- 操作接口：内部 HTTP 传输 1 套移除（Request ctor + Response.json + unsafe
  cast）；新增私有 `readComposerDueRows`；due-list 新增 1 个常量导出（事实，
  非转发）；knowledge-labels 新增 `knowledgeLabels` 唯一 owner。
- 文件边（practice/server 内部）：view→inputs −1；inputs→knowledge-labels +1；
  view→knowledge-labels +1；inputs→due-list 保持 1（同文件不同符号）。
  净 +1 文件边换取 view 对编排模块的解耦。
- 行数：due-list 705→713；stream-inputs 355→369（净 +14，主要为降级契约
  注释）；stream-view 410→410；knowledge-labels +26（新文件）。
- 指标（同口径）：>1500 源文件 18→18；SCC 1（5 成员）不变；
  capability→server 444、cross-value 48、baseline 141 行不变
  （audit:capability-boundaries exit 0）。

## 兼容

- `handleReviewDue` / `queryReviewDue` / `ReviewDueDeps` / `ReviewDueQuery` /
  `ReviewDueRow` 原样导出：`api/due.ts`、`practice/public.ts` lazy re-export、
  `stream-store-reserved-connection.db.test.ts` 与
  `intervention-preparation.db.test.ts` 的既有入口不动（测试零改动）。
- stream-store 既有 import/re-export 面不变：`collectComposerInputs`、
  `resolveDailyPracticeBudget`、`VARIANT_INPUT_LIMIT`、`StreamView`/`StreamScope`、
  `buildStreamView`、`filterProspectiveStreamQuestions`、`getStreamViewItem`。
- `knowledgeLabels` 不再经 stream-inputs 导出：唯一生产消费者 stream-view 已
  改到新模块；全库 grep 无测试或其它文件引用旧路径。

## 验证（exact commands → 结果）

- `pnpm typecheck` → exit 0（含 `server/start/tsconfig.json`）
- `pnpm exec biome check`（4 个触及文件）→ clean，0 fixes
- `pnpm lint` → exit 0，179 warnings（与基线一致，无新增）
- `pnpm build` → exit 0（web build + server/worker/migrate esbuild）
- `pnpm audit:capability-boundaries` → exit 0（444/0/48，无新跨 capability 边）
- `pnpm audit:architecture-deepening` → exit 0
- `pnpm audit:relations` → exit 0（dead-edge 行项为既有 report-only 信号）
- NOT_RUN：本机测试套件、DB/TEST/Docker、运行时回放、provider/付费调用
  （owner 规则）。行为等价由上表逐边对照论证，未经真实请求或事务回放；
  「干预诊断仍可前缀并集」「降级后同 tx 后续查询」等运行时事实为代码级
  同构结论，非实测。

外部日志与逐文件 SHA-256（按验证时源码 commit
`c1a68eaf541427ba58a6ad7db8a515518b75b337` 命名）：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/c1a68eaf541427ba58a6ad7db8a515518b75b337/`，
`checks-sha256.json` 索引 SHA-256
`1a222448e8ab113a4ae3fd6fe9b91f165fd1c5e6d745f559a55dc0efe0804127`。
