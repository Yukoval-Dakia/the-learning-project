# src/server — server-only modules

> Server-only 业务层（route handler + worker 共用）。浏览器**不**直接 import。架构权威见 [docs/architecture.md](../../docs/architecture.md)；领域词条见 [CONTEXT.md](../../CONTEXT.md)。

## WHERE TO LOOK
| 子模块 | 职责 |
|--------|------|
| `ai/` | Pi agent runner（唯一执行引擎）+ domain tool registry + tool bridge（见本目录 AGENTS.md）；`ai/mem0/` 是 Mem0 平台适配器 |
| `boss/` | pg-boss client + handler 注册；`handlers/` 是 job/cron 目录（见 AGENTS.md）|
| `config/` | 运行时配置水合与管理面配置读写 |
| `durable/` | DBOS durable 层：判分、孤儿会话回收等 workflow family；付费状态机与后端控制归 `../core/paid-work/server/` |
| `events/` | 事件因果级联遍历 + 进程级 LISTEN 连接；`events/subscriptions/` 是 capability 事件订阅的注册与派发挂载 |
| `http/` | HTTP 错误与 provider 会话截止时间 helper |
| `migration/` | 迁移捕获与应用；`migration/contract-epoch/` 是契约 epoch 规则与 pg-boss 生产者 fence |
| `orchestration/` | 夜间 DAG 编排器（anchor + tick 推进）|
| `projections/` | 投影 gather/fold、parity 与漂移审计 |
| `proposals/` | propose event 的 accept/dismiss/retract actions（破坏性动作落地点）|
| `questions/` | 题目草稿、编辑与提交写路径 |
| `release/` | 发布证据 manifest 生成；`release/rehearsal/` 在临时 PG 容器内做发布前迁移演练 |
| `revert/` | 级联撤销与 state_snapshot 恢复 |
| `../capabilities/agency/server/memory/` | Agency 的 Mem0 摄取与 per-scope brief 管线（见该目录 AGENTS.md）|
| `../capabilities/ingestion/server/` | 录入状态操作、OCR / Vision rescue 与 DOCX 文本初始化（见该域 AGENTS.md）|
| `../capabilities/agency/server/conjecture/` | 预测问责排序、解离事实读取、probe 记账及纠错回放；typed ledger 与共享单探针评分归 `@/kernel/records/` |
| `../kernel/object-storage.ts` | 共享 R2/S3 对象 I/O 与首次调用时构造的 client；资产引用、锁、恢复及付费策略归业务 owner |

## CONVENTIONS
- 每个 service owns 自己的 write path（schema audit 要求）。AI tool 只能包装已有 owner service，不能传任意 mutation payload。
- Service 写 `event` / `tool_call_log` / `cost_ledger` 留痕（evidence-first，可重放可审计）。
- 测试（仅限 AGENTS.md 五类不变量，YUK-1401）就地：`*.test.ts` 旁置；依赖 DB/drizzle/PgBoss 的进 db config，纯逻辑进 unit config。

## ANTI-PATTERNS
- 别把 subject-specific 逻辑漏进这里——学科特化属于 `src/subjects/<name>/`。
- 派生 lifecycle 字段不回写源表——建 reader/projection（如 `material_fsrs_state`）。
