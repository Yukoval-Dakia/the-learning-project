# src/server — server-only modules

> Server-only 业务层（route handler + worker 共用）。浏览器**不**直接 import。架构权威见 [docs/architecture.md](../../docs/architecture.md)；领域词条见 [CONTEXT.md](../../CONTEXT.md)。

## WHERE TO LOOK
| 子模块 | 职责 |
|--------|------|
| `ai/` | Pi agent runner（唯一执行引擎，YUK-1025 后无 SDK 子进程）+ domain tool registry + tool bridge（见本目录 AGENTS.md）|
| `boss/` | pg-boss client + handler 注册；`handlers/` 是 job/cron 目录（见 AGENTS.md）|
| `../capabilities/ingestion/server/` | 录入状态操作、OCR / Vision rescue 与 DOCX 文本初始化（见该域 AGENTS.md）|
| `knowledge/` | 知识树 + mesh edge + propose/attribute/review（见 AGENTS.md）|
| `events/` | event 写入 + 查询（事件驱动核的 IO 层）|
| `../capabilities/agency/server/conjecture/` | 预测问责排序、硬确认事实读取与判定、probe 记账及纠错回放；typed ledger 与共享单探针评分归 `@/kernel/records/` |
| `session/` | 剩余会话状态操作；Placement 归 `../capabilities/practice/server/placement-session-lifecycle.ts`，录入归 ingestion capability，共享守卫归 `../kernel/learning-session-guard.ts` |
| `proposals/` | propose event 的 accept/dismiss/retract actions（破坏性动作落地点）|
| `artifacts/` | Living Note body-blocks / sections / editing-session / hub-dismiss |
| `review/` + `fsrs/` | FSRS 调度（ts-fsrs）+ review event → `material_fsrs_state` 投影 |
| `judge/` | 判分 service（写 judge event）|
| `questions/` | StructuredQuestion CRUD + timeline |
| `memory/` | Mem0 fact layer ingest + per-scope brief（ADR-0017）|
| `copilot/` | conversation/tutor session runtime |
| `teaching/` | Active Teaching turn 物化（ask_check → question(source='teaching_check')）|
| `quiz/` | QuizGen / Sourcing few-shot 检索 + verify framework |
| `agents/` | `leave_agent_note` 软提示 channel（→ Dreaming / Maintenance）|
| `learning-items/` | active learning-item reader（Coach brief 的 attention pressure）|
| `goals/` · `today/` · `records/` · `admin/` | learning intent / today plan / learning record / 管理面 |
| `export/` · `http/` · `redis/` · `r2.ts` | 导入导出 / HTTP helper / redis / R2 blob client |

## CONVENTIONS
- 每个 service owns 自己的 write path（schema audit 要求）。AI tool 只能包装已有 owner service，不能传任意 mutation payload。
- Service 写 `event` / `tool_call_log` / `cost_ledger` 留痕（evidence-first，可重放可审计）。
- 测试（仅限 AGENTS.md 五类不变量，YUK-1401）就地：`*.test.ts` 旁置；依赖 DB/drizzle/PgBoss 的进 db config，纯逻辑进 unit config。

## ANTI-PATTERNS
- 别把 subject-specific 逻辑漏进这里——学科特化属于 `src/subjects/<name>/`。
- 派生 lifecycle 字段不回写源表——建 reader/projection（如 `material_fsrs_state`）。
