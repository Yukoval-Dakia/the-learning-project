# Linear 残留工作盘点 — 2026-10-07

查询范围：YUK 团队，非归档，状态类型 backlog/unstarted/started；三组查询均返回 hasNextPage=false。此清单用于迁移之后逐项核销，不代表每张都是尚未实现的独立功能。状态随主线推进会变化，执行前须重新读取票据和代码。

共 260 张：Backlog 227、Todo 21、进行/审查中 12。其中 169 张标题为 SCF 核验或修复候选，不可未经核验当作已确认漏洞。

UI 依 owner 指令暂缓；此快照不擅自关闭任何功能、数据前置 gate 或需要真实模型证据的验收。重复/被替代/已实现事项需取证后在 Linear 对齐。

## started

| 工单 | 当前状态 | 标题 |
| --- | --- | --- |
| [YUK-1338](https://linear.app/yukoval-studios/issue/YUK-1338) | In Review | [TS 架构/验证] 验证 Pi + DBOS 的状态版本与进程恢复竖切 |
| [YUK-1364](https://linear.app/yukoval-studios/issue/YUK-1364) | In Progress | TeachingBrief 过滤未正式发题的 probe，避免可见题无法判分 |
| [YUK-1353](https://linear.app/yukoval-studios/issue/YUK-1353) | In Progress | [UI · Opus 5.5 only / P2] 视觉方向 loft：首页「回来时」与学习工作台 3 个结构性变体并定稿 |
| [YUK-1351](https://linear.app/yukoval-studios/issue/YUK-1351) | In Progress | [TS 迁移+UI 重写 / Epic] TanStack Start + Pi + Drizzle + DBOS 路由级迁移与前端重写 |
| [YUK-1325](https://linear.app/yukoval-studios/issue/YUK-1325) | In Progress | 接入 Laminar，基于真实 AI pipeline traces 定位改进点 |
| [YUK-1346](https://linear.app/yukoval-studios/issue/YUK-1346) | In Progress | 落实 Copilot 单次对话的“不写入记忆”控制并约束异步派生 |
| [YUK-1360](https://linear.app/yukoval-studios/issue/YUK-1360) | In Progress | 接续 PR1584 依赖升级：修复 pg-boss 类型契约并验证兼容性 |
| [YUK-1350](https://linear.app/yukoval-studios/issue/YUK-1350) | In Progress | Memory reconcile 超时后重投必须防止再次付费调用，并覆盖响应体超时 |
| [YUK-1042](https://linear.app/yukoval-studios/issue/YUK-1042) | In Progress | pg-boss DLQ 积压恢复：本机现存 42 个任务，含 memory_event_ingest 14 个 |
| [YUK-1007](https://linear.app/yukoval-studios/issue/YUK-1007) | In Progress | 统一配置面板：per-task AI 模型、系统偏好、语言 |
| [YUK-1109](https://linear.app/yukoval-studios/issue/YUK-1109) | In Progress | 停止跟踪 PLAN 与本地 agent 产物，统一 Linear + 本地交接规则 |
| [YUK-1089](https://linear.app/yukoval-studios/issue/YUK-1089) | In Progress | Ship-engine: pstack-port 自动 ship 值班层落地与实测 |

## unstarted

| 工单 | 当前状态 | 标题 |
| --- | --- | --- |
| [YUK-406](https://linear.app/yukoval-studios/issue/YUK-406) | Todo | Phase 0 — 关系脑 thin slice：conjecture 引擎 + 例会 job + 备课台 |
| [YUK-310](https://linear.app/yukoval-studios/issue/YUK-310) | Todo | C2 · P3 async tracker 剩余：合入 runner job_events（0db6703a0）+ tracker 卡绑 run |
| [YUK-443](https://linear.app/yukoval-studios/issue/YUK-443) | Todo | A7 每个 KC 达到 0.95 mastery 就停，把题目预算让给更不确定的点 |
| [YUK-464](https://linear.app/yukoval-studios/issue/YUK-464) | Todo | paper 路径 SRT parity — 卷题作答的 RT 当前不喂 θ̂（刻意 θ̂-channel 决策，待定） |
| [YUK-295](https://linear.app/yukoval-studios/issue/YUK-295) | Todo | 题库归档生命周期字段回写 question.metadata（vs 仅留 event/projection）——YUK-281 deferred |
| [YUK-147](https://linear.app/yukoval-studios/issue/YUK-147) | Todo | UX 决策: undo 一个 auto-link dismiss 后，下次 nightly 会重新移除（"回来又消失"） |
| [YUK-213](https://linear.app/yukoval-studios/issue/YUK-213) | Todo | 删除孤儿 SolveTutorPanel.tsx（Chat 合并后续残留，2026-10-07 收窄） |
| [YUK-1134](https://linear.app/yukoval-studios/issue/YUK-1134) | Todo | [SCF] 修复并验证：Probe judge claim release race weakens cost guard |
| [YUK-1189](https://linear.app/yukoval-studios/issue/YUK-1189) | Todo | [SCF] 核验并处置：unit_dimension lets generated checks bypass grading |
| [YUK-1270](https://linear.app/yukoval-studios/issue/YUK-1270) | Todo | [SCF] 核验并处置：State snapshot restore corrupts mastery counters |
| [YUK-1217](https://linear.app/yukoval-studios/issue/YUK-1217) | Todo | [SCF] 核验并处置：Activation accepts evaluations for withheld scoring rules |
| [YUK-1195](https://linear.app/yukoval-studios/issue/YUK-1195) | Todo | [SCF] 核验并处置：Copilot SSE leaks raw agent errors to clients |
| [YUK-1128](https://linear.app/yukoval-studios/issue/YUK-1128) | Todo | [SCF] 修复并验证：PR-controlled CI planner can skip the required gate |
| [YUK-1141](https://linear.app/yukoval-studios/issue/YUK-1141) | Todo | [SCF] 修复并验证：Unbounded adaptive feedback queries enable DB DoS |
| [YUK-1139](https://linear.app/yukoval-studios/issue/YUK-1139) | Todo | [SCF] 修复并验证：Migration runner bypasses PostgreSQL TLS enforcement |
| [YUK-1136](https://linear.app/yukoval-studios/issue/YUK-1136) | Todo | [SCF] 修复并验证：Unbounded session summary failure scan enables DoS |
| [YUK-1131](https://linear.app/yukoval-studios/issue/YUK-1131) | Todo | [SCF] 修复并验证：Markdown asset URLs can trigger arbitrary tokened GETs |
| [YUK-1124](https://linear.app/yukoval-studios/issue/YUK-1124) | Todo | [SCF] 修复并验证：Manual quiz generation can be spammed without a budget gate |
| [YUK-1123](https://linear.app/yukoval-studios/issue/YUK-1123) | Todo | [SCF] 修复并验证：Vision judge fallback bypasses provider pinning |
| [YUK-1122](https://linear.app/yukoval-studios/issue/YUK-1122) | Todo | [SCF] 修复并验证：Read-backed ephemeral HTML can exfiltrate private Copilot data |
| [YUK-766](https://linear.app/yukoval-studios/issue/YUK-766) | Todo | 订阅系统灾备恢复语义：备份排除 checkpoint/delivery 导致 restore 后未投递增量被标 skipped |

## backlog

| 工单 | 当前状态 | 标题 |
| --- | --- | --- |
| [YUK-1356](https://linear.app/yukoval-studios/issue/YUK-1356) | Backlog | [TS 迁移 P4a / 非 UI] 首个竖切后端：复习作答 → 判分 → 状态更新 → 下一项（业务操作 + server function + 判分任务族迁 DBOS） |
| [YUK-1361](https://linear.app/yukoval-studios/issue/YUK-1361) | Backlog | Laminar transcript 表示保真：脱敏占位重复与远端消息元数据差异 |
| [YUK-1359](https://linear.app/yukoval-studios/issue/YUK-1359) | Backlog | [TS 迁移 P7 / 非 UI] 切换收口：旧 SPA 与 pg-boss 退役、Hono 去留裁决、文档与 ADR 同步 |
| [YUK-1358](https://linear.app/yukoval-studios/issue/YUK-1358) | Backlog | [TS 迁移 P6 / 拆分容器] 剩余页面分波迁移：每波拆「后端非 UI」与「UI · Opus 5.5 only」两票 |
| [YUK-1357](https://linear.app/yukoval-studios/issue/YUK-1357) | Backlog | [UI · Opus 5.5 only / P4b] 首个竖切 UI：学习工作台复习作答页在 TanStack 上以新设计上线 |
| [YUK-1355](https://linear.app/yukoval-studios/issue/YUK-1355) | Backlog | [TS 迁移 P5 / 非 UI] pg-boss → DBOS 任务族迁移框架：worker 双栈、逐族切换开关、排空与回退手册 |
| [YUK-1354](https://linear.app/yukoval-studios/issue/YUK-1354) | Backlog | [UI · Opus 5.5 only / P3] 新设计系统基座（tokens/primitives/壳）+ 错题页示踪路由迁到 TanStack |
| [YUK-1352](https://linear.app/yukoval-studios/issue/YUK-1352) | Backlog | [TS 迁移 P1 / 非 UI] TanStack Start 前门：挂载现有 Hono /api + 旧 SPA 回落 + 本机 Compose 形态 |
| [YUK-405](https://linear.app/yukoval-studios/issue/YUK-405) | Backlog | 私人教研团：AI-native 学习产品 rethink（关系脑先行 · conjecture 引擎） |
| [YUK-419](https://linear.app/yukoval-studios/issue/YUK-419) | Backlog | [RESURRECTED] Auto-Quest = 目标锚定长程编排（你设目标，团队拆解+维护近期由规划脑填） |
| [YUK-418](https://linear.app/yukoval-studios/issue/YUK-418) | Backlog | [RESURRECTED] 元认知反思层 / Reflection Tree = meta-conjectures（建在已确认 conjecture 之上） |
| [YUK-438](https://linear.app/yukoval-studios/issue/YUK-438) | Backlog | A9 LLM step-grading — 解题分步评分，PFA 证据 3-6× 倍增器 |
| [YUK-354](https://linear.app/yukoval-studios/issue/YUK-354) | Backlog | 形态轴 A1-A4 实施 epic（claude design handoff 前置 — 审计抓到形态轴零工单） |
| [YUK-439](https://linear.app/yukoval-studios/issue/YUK-439) | Backlog | A12 LLM 先验→贝叶斯更新 — 每个 LLM 贡献框成分布，σ²→active-PPI 接口 |
| [YUK-437](https://linear.app/yukoval-studios/issue/YUK-437) | Backlog | A8 distractor→misconception — 记「选了哪个错项」升级为 typed fail |
| [YUK-370](https://linear.app/yukoval-studios/issue/YUK-370) | Backlog | A4 kind 作选题/mix 信号维（非独立 FSRS 调度单元） |
| [YUK-492](https://linear.app/yukoval-studios/issue/YUK-492) | Backlog | 整页 holistic 判分 + 同页密集归属（YUK-488 收窄后延迟的终态） |
| [YUK-416](https://linear.app/yukoval-studios/issue/YUK-416) | Backlog | [DEFERRED] 异质双强 de-bias panel + cross-provider wrapper（gated on 第二条 frontier lane = GPT 5.5 级） |
| [YUK-327](https://linear.app/yukoval-studios/issue/YUK-327) | Backlog | D11 record 域退役时摘除 ingestion copilotTools 的 query_records / get_record_context |
| [YUK-257](https://linear.app/yukoval-studios/issue/YUK-257) | Backlog | [YUK-253 follow-up] Wire 题级 bbox (bboxUnion of member GLM blocks) into page_spans once ADR-0002 full-page-bbox is relaxed |
| [YUK-505](https://linear.app/yukoval-studios/issue/YUK-505) | Backlog | P2 规划脑 — deliberative planning panel MVP（单 Opus，SELECT-not-fuse） |
| [YUK-1342](https://linear.app/yukoval-studios/issue/YUK-1342) | Backlog | 实际模型探针：显式运行开关与不可覆盖的证据封存 |
| [YUK-1347](https://linear.app/yukoval-studios/issue/YUK-1347) | Backlog | Copilot 现有题目的 LaTeX 解答缺少标记时绕过独立校验 |
| [YUK-1349](https://linear.app/yukoval-studios/issue/YUK-1349) | Backlog | Copilot 数学解答显示原始 LaTeX，需接入学科公式渲染 |
| [YUK-1348](https://linear.app/yukoval-studios/issue/YUK-1348) | Backlog | Copilot 普通学习偏好被后台记住，但回复误称没有记忆写入通道 |
| [YUK-1228](https://linear.app/yukoval-studios/issue/YUK-1228) | Backlog | [SCF] 核验并处置：Status-worded quizzes bypass independent validation |
| [YUK-1343](https://linear.app/yukoval-studios/issue/YUK-1343) | Backlog | Copilot 会话入口一致性：失败创建来源、截断列表续接与恢复回归 |
| [YUK-1329](https://linear.app/yukoval-studios/issue/YUK-1329) | Backlog | [Readiness] 为 compose 发布建立可重复执行、验证与安全回滚入口 |
| [YUK-1344](https://linear.app/yukoval-studios/issue/YUK-1344) | Backlog | Loom 私有 Tailscale 远程入口已配置，待外部设备确认 |
| [YUK-1164](https://linear.app/yukoval-studios/issue/YUK-1164) | Backlog | [SCF] 核验并处置：Full note bodies are sent to memory ingestion |
| [YUK-1235](https://linear.app/yukoval-studios/issue/YUK-1235) | Backlog | [SCF] 核验并处置：Docker image keeps stale externalized dependency versions |
| [YUK-1345](https://linear.app/yukoval-studios/issue/YUK-1345) | Backlog | 校准统计按全局模型 pin 识别同源视觉复判 |
| [YUK-1339](https://linear.app/yukoval-studios/issue/YUK-1339) | Backlog | 补齐 typed primitive AI runs 的 Laminar tracing |
| [YUK-1187](https://linear.app/yukoval-studios/issue/YUK-1187) | Backlog | [SCF] 核验并处置：Stale grounding failure can undo verified question state |
| [YUK-1314](https://linear.app/yukoval-studios/issue/YUK-1314) | Backlog | [SCF] 核验并处置：Required probe reference hides old conjecture proposals |
| [YUK-1265](https://linear.app/yukoval-studios/issue/YUK-1265) | Backlog | [SCF] 核验并处置：Post-commit mastery telemetry can record the wrong delta |
| [YUK-1273](https://linear.app/yukoval-studios/issue/YUK-1273) | Backlog | [SCF] 核验并处置：Cascade revert can re-apply already retracted snapshots |
| [YUK-1258](https://linear.app/yukoval-studios/issue/YUK-1258) | Backlog | [SCF] 核验并处置：Copilot hero links can route to missing SPA pages |
| [YUK-1238](https://linear.app/yukoval-studios/issue/YUK-1238) | Backlog | [SCF] 核验并处置：Block assembly relies on unordered DB row adjacency |
| [YUK-1336](https://linear.app/yukoval-studios/issue/YUK-1336) | Backlog | [Readiness] 复核评估证据口径并裁定剩余检查项的实际适用性 |
| [YUK-1335](https://linear.app/yukoval-studios/issue/YUK-1335) | Backlog | [Readiness] 为依赖更新增加发布冷却策略并保留安全修复通道 |
| [YUK-1334](https://linear.app/yukoval-studios/issue/YUK-1334) | Backlog | [Readiness] 为复杂度、重复代码与大文件建立增量维护成本检查 |
| [YUK-1333](https://linear.app/yukoval-studios/issue/YUK-1333) | Backlog | [Readiness] 为 Vite SPA 建立可解释的 bundle 体积防退化检查 |
| [YUK-1332](https://linear.app/yukoval-studios/issue/YUK-1332) | Backlog | [Readiness] 为提交前检查提供轻量可安装入口并保护部分暂存 |
| [YUK-1331](https://linear.app/yukoval-studios/issue/YUK-1331) | Backlog | [Readiness] 汇总 CI 测试稳定性并建立 flaky 归因与跟进规则 |
| [YUK-1330](https://linear.app/yukoval-studios/issue/YUK-1330) | Backlog | [Readiness] 为关键业务模块建立覆盖率基线与防退化门槛 |
| [YUK-1328](https://linear.app/yukoval-studios/issue/YUK-1328) | Backlog | [Readiness] 建立 API/worker 错误聚合、基础指标与告警闭环 |
| [YUK-856](https://linear.app/yukoval-studios/issue/YUK-856) | Backlog | [FULL/F0.O1] Observe and enforce provider attempts in production |
| [YUK-1327](https://linear.app/yukoval-studios/issue/YUK-1327) | Backlog | [Readiness] 统一 API/worker 结构化日志并验证敏感字段脱敏 |
| [YUK-1326](https://linear.app/yukoval-studios/issue/YUK-1326) | Backlog | JSON引用投影兼容负零：避免忠实 -0 引用被保守拒绝 |
| [YUK-1324](https://linear.app/yukoval-studios/issue/YUK-1324) | Backlog | Today 桌面背景伪元素越出内容列，造成横向滚动 |
| [YUK-1137](https://linear.app/yukoval-studios/issue/YUK-1137) | Backlog | [SCF] 核验并处置：Unbounded per-question failure scan can exhaust database |
| [YUK-1113](https://linear.app/yukoval-studios/issue/YUK-1113) | Backlog | 收口四个仍无生产写入的 schema 预留字段，按消费契约实施或退场 |
| [YUK-1107](https://linear.app/yukoval-studios/issue/YUK-1107) | Backlog | 全量 CI ≤120秒：按行为保障重组测试组合并消除执行长尾 |
| [YUK-1318](https://linear.app/yukoval-studios/issue/YUK-1318) | Backlog | [SCF] 核验并处置：Canonical dismiss can 500 on folded proposals |
| [YUK-1317](https://linear.app/yukoval-studios/issue/YUK-1317) | Backlog | [SCF] 核验并处置：GET stream read can delete pending practice items |
| [YUK-1315](https://linear.app/yukoval-studios/issue/YUK-1315) | Backlog | [SCF] 核验并处置：Subject rename migration can orphan or block existing KC data |
| [YUK-1313](https://linear.app/yukoval-studios/issue/YUK-1313) | Backlog | [SCF] 核验并处置：Merge-chain logging can exhaust memory on long chains |
| [YUK-1312](https://linear.app/yukoval-studios/issue/YUK-1312) | Backlog | [SCF] 核验并处置：Merge sweep counts intentionally frozen rows as orphans |
| [YUK-1311](https://linear.app/yukoval-studios/issue/YUK-1311) | Backlog | [SCF] 核验并处置：Archived misconceptions can trigger contrast quiz jobs |
| [YUK-1310](https://linear.app/yukoval-studios/issue/YUK-1310) | Backlog | [SCF] 核验并处置：C-tier proposals are hidden without dismissal controls |
| [YUK-1309](https://linear.app/yukoval-studios/issue/YUK-1309) | Backlog | [SCF] 核验并处置：Due hard constraint still broken in legacy paths |
| [YUK-1308](https://linear.app/yukoval-studios/issue/YUK-1308) | Backlog | [SCF] 核验并处置：Unchunked genesis backfill can fail on large tables |
| [YUK-1306](https://linear.app/yukoval-studios/issue/YUK-1306) | Backlog | [SCF] 核验并处置：Projection rebuild can delete rows before genesis backfill |
| [YUK-1305](https://linear.app/yukoval-studios/issue/YUK-1305) | Backlog | [SCF] 核验并处置：Removed pg-boss cron leaves stale schedule behind |
| [YUK-1304](https://linear.app/yukoval-studios/issue/YUK-1304) | Backlog | [SCF] 核验并处置：Fail-open grading can create bogus student attempts |
| [YUK-1303](https://linear.app/yukoval-studios/issue/YUK-1303) | Backlog | [SCF] 核验并处置：Placement probe fetches answer-bearing question detail |
| [YUK-1302](https://linear.app/yukoval-studios/issue/YUK-1302) | Backlog | [SCF] 核验并处置：Calibration audit replays history with current family b |
| [YUK-1301](https://linear.app/yukoval-studios/issue/YUK-1301) | Backlog | [SCF] 核验并处置：Auto-commit appeal button does not continue |
| [YUK-1300](https://linear.app/yukoval-studios/issue/YUK-1300) | Backlog | [SCF] 核验并处置：KT nightly job starves candidates beyond first 500 |
| [YUK-1299](https://linear.app/yukoval-studios/issue/YUK-1299) | Backlog | [SCF] 核验并处置：409 refetch can wipe unsaved question edits |
| [YUK-1298](https://linear.app/yukoval-studios/issue/YUK-1298) | Backlog | [SCF] 核验并处置：Archived knowledge labels leak in draft review |
| [YUK-1297](https://linear.app/yukoval-studios/issue/YUK-1297) | Backlog | [SCF] 核验并处置：Unescaped successor Link headers can turn 4xx into 500s |
| [YUK-1296](https://linear.app/yukoval-studios/issue/YUK-1296) | Backlog | [SCF] 核验并处置：Canonical decisions 500 on stale block-merge accepts |
| [YUK-1295](https://linear.app/yukoval-studios/issue/YUK-1295) | Backlog | [SCF] 核验并处置：Null response text is treated as missing calibration input |
| [YUK-1294](https://linear.app/yukoval-studios/issue/YUK-1294) | Backlog | [SCF] 核验并处置：Queue retries amplify paid LLM jobs and side effects |
| [YUK-1291](https://linear.app/yukoval-studios/issue/YUK-1291) | Backlog | [SCF] 核验并处置：Mind probes can leak into review and mutate FSRS |
| [YUK-1289](https://linear.app/yukoval-studios/issue/YUK-1289) | Backlog | [SCF] 核验并处置：Provenance audit treats any token as a guard |
| [YUK-1287](https://linear.app/yukoval-studios/issue/YUK-1287) | Backlog | [SCF] 核验并处置：MERGE undo runbook restores the wrong memory text |
| [YUK-1286](https://linear.app/yukoval-studios/issue/YUK-1286) | Backlog | [SCF] 核验并处置：Backfill repair count misses kc_typed pointer-only fixes |
| [YUK-1285](https://linear.app/yukoval-studios/issue/YUK-1285) | Backlog | [SCF] 核验并处置：Merge repair schema rejects emitted edge repair logs |
| [YUK-1284](https://linear.app/yukoval-studios/issue/YUK-1284) | Backlog | [SCF] 核验并处置：Confusable contrast job can repeatedly waste LLM budget |
| [YUK-1283](https://linear.app/yukoval-studios/issue/YUK-1283) | Backlog | [SCF] 核验并处置：Archived KC misconception data exposed by new subroute |
| [YUK-1282](https://linear.app/yukoval-studios/issue/YUK-1282) | Backlog | [SCF] 核验并处置：Frontier scan cap can hide valid pending proposals |
| [YUK-1281](https://linear.app/yukoval-studios/issue/YUK-1281) | Backlog | [SCF] 核验并处置：FSRS JSON state is not parsed before retrievability read |
| [YUK-1280](https://linear.app/yukoval-studios/issue/YUK-1280) | Backlog | [SCF] 核验并处置：Overnight digest can exhaust memory with unbounded event reads |
| [YUK-1279](https://linear.app/yukoval-studios/issue/YUK-1279) | Backlog | [SCF] 核验并处置：Batch landing leaves stale ingest recovery query |
| [YUK-1278](https://linear.app/yukoval-studios/issue/YUK-1278) | Backlog | [SCF] 核验并处置：Malformed RT buffer JSON can crash timed submissions |
| [YUK-1276](https://linear.app/yukoval-studios/issue/YUK-1276) | Backlog | [SCF] 核验并处置：Conjecture edit payload is dropped by decide API |
| [YUK-1275](https://linear.app/yukoval-studios/issue/YUK-1275) | Backlog | [SCF] 核验并处置：Lifecycle event can be skipped on same-timestamp imports |
| [YUK-1274](https://linear.app/yukoval-studios/issue/YUK-1274) | Backlog | [SCF] 核验并处置：Exact theta compare breaks old cascade reverts |
| [YUK-1272](https://linear.app/yukoval-studios/issue/YUK-1272) | Backlog | [SCF] 核验并处置：Retract can clobber newer learning item state |
| [YUK-1269](https://linear.app/yukoval-studios/issue/YUK-1269) | Backlog | [SCF] 核验并处置：KC dedup can propose cross-subject merges |
| [YUK-1268](https://linear.app/yukoval-studios/issue/YUK-1268) | Backlog | [SCF] 核验并处置：Oldest-first backfill can starve newer rows |
| [YUK-1267](https://linear.app/yukoval-studios/issue/YUK-1267) | Backlog | [SCF] 核验并处置：Auto-tagging can reuse KCs under archived parents |
| [YUK-1266](https://linear.app/yukoval-studios/issue/YUK-1266) | Backlog | [SCF] 核验并处置：Knowledge reparent leaves descendant embeddings stale |
| [YUK-1264](https://linear.app/yukoval-studios/issue/YUK-1264) | Backlog | [SCF] 核验并处置：MCQ answer-key replacement corrupts reference text |
| [YUK-1263](https://linear.app/yukoval-studios/issue/YUK-1263) | Backlog | [SCF] 核验并处置：Observed-distinct gate counts non-calibration judge events |
| [YUK-1262](https://linear.app/yukoval-studios/issue/YUK-1262) | Backlog | [SCF] 核验并处置：Migration resets existing family calibration state |
| [YUK-1261](https://linear.app/yukoval-studios/issue/YUK-1261) | Backlog | [SCF] 核验并处置：Re-rank fix can still delete an unfilled stream slot |
| [YUK-1260](https://linear.app/yukoval-studios/issue/YUK-1260) | Backlog | [SCF] 核验并处置：Poisson re-rank can delete or overfill pending stream items |
| [YUK-1259](https://linear.app/yukoval-studios/issue/YUK-1259) | Backlog | [SCF] 核验并处置：Review partials pollute calibration labels |
| [YUK-1257](https://linear.app/yukoval-studios/issue/YUK-1257) | Backlog | [SCF] 核验并处置：Paper judge feedback lost after attribution supersedes event |
| [YUK-1256](https://linear.app/yukoval-studios/issue/YUK-1256) | Backlog | [SCF] 核验并处置：Swallowed pg-boss start race can disable cron loops |
| [YUK-1255](https://linear.app/yukoval-studios/issue/YUK-1255) | Backlog | [SCF] 核验并处置：Choice-prefix parsing can mark wrong text answers correct |
| [YUK-1254](https://linear.app/yukoval-studios/issue/YUK-1254) | Backlog | [SCF] 核验并处置：Material quizzes can be falsely rejected as copied |
| [YUK-1253](https://linear.app/yukoval-studios/issue/YUK-1253) | Backlog | [SCF] 核验并处置：Block merge accept can commit without acceptance audit |
| [YUK-1252](https://linear.app/yukoval-studios/issue/YUK-1252) | Backlog | [SCF] 核验并处置：Empty revert reason causes server-side 500 |
| [YUK-1251](https://linear.app/yukoval-studios/issue/YUK-1251) | Backlog | [SCF] 核验并处置：Low-score partial solve attempts are orphaned |
| [YUK-1250](https://linear.app/yukoval-studios/issue/YUK-1250) | Backlog | [SCF] 核验并处置：Empty Mimo overrides break vision preflight defaults |
| [YUK-1249](https://linear.app/yukoval-studios/issue/YUK-1249) | Backlog | [SCF] 核验并处置：ref_kind not included in artifact_block_ref uniqueness |
| [YUK-1248](https://linear.app/yukoval-studios/issue/YUK-1248) | Backlog | [SCF] 核验并处置：AI change undo can wipe later note edits |
| [YUK-1246](https://linear.app/yukoval-studios/issue/YUK-1246) | Backlog | [SCF] 核验并处置：Paused review pruning uses session start, not pause time |
| [YUK-1245](https://linear.app/yukoval-studios/issue/YUK-1245) | Backlog | [SCF] 核验并处置：Retract downgrades records still used by accepted proposals |
| [YUK-1243](https://linear.app/yukoval-studios/issue/YUK-1243) | Backlog | [SCF] 核验并处置：Historical mistakes disappear after records migration |
| [YUK-1242](https://linear.app/yukoval-studios/issue/YUK-1242) | Backlog | [SCF] 核验并处置：Exact quiz mismatches can auto-promote on judge failure |
| [YUK-1241](https://linear.app/yukoval-studios/issue/YUK-1241) | Backlog | [SCF] 核验并处置：Live answer draft uniqueness misses NULL session_id |
| [YUK-1240](https://linear.app/yukoval-studios/issue/YUK-1240) | Backlog | [SCF] 核验并处置：Nightly edge proposals can create unacceptably redundant edges |
| [YUK-1239](https://linear.app/yukoval-studios/issue/YUK-1239) | Backlog | [SCF] 核验并处置：Quiz choice normalization can corrupt valid option text |
| [YUK-1237](https://linear.app/yukoval-studios/issue/YUK-1237) | Backlog | [SCF] 核验并处置：Cold LaTeX render briefly activates Markdown images |
| [YUK-1234](https://linear.app/yukoval-studios/issue/YUK-1234) | Backlog | [SCF] 核验并处置：Editor can crash on insecure LAN origins |
| [YUK-1233](https://linear.app/yukoval-studios/issue/YUK-1233) | Backlog | [SCF] 核验并处置：Bootstrap can skip events committed during startup |
| [YUK-1232](https://linear.app/yukoval-studios/issue/YUK-1232) | Backlog | [SCF] 核验并处置：Goal-scope decisions ignore non-accept verbs |
| [YUK-1230](https://linear.app/yukoval-studios/issue/YUK-1230) | Backlog | [SCF] 核验并处置：Recovery conformance audit is tautological |
| [YUK-1227](https://linear.app/yukoval-studios/issue/YUK-1227) | Backlog | [SCF] 核验并处置：Audit-only question events can block database upgrades |
| [YUK-1225](https://linear.app/yukoval-studios/issue/YUK-1225) | Backlog | [SCF] 核验并处置：Late warning response can mark a later clean import degraded |
| [YUK-1223](https://linear.app/yukoval-studios/issue/YUK-1223) | Backlog | [SCF] 核验并处置：Post-rerank validation accepts candidates dropped by top-K |
| [YUK-1222](https://linear.app/yukoval-studios/issue/YUK-1222) | Backlog | [SCF] 核验并处置：Non-atomic cooldown allows duplicate paid catalog proposals |
| [YUK-1221](https://linear.app/yukoval-studios/issue/YUK-1221) | Backlog | [SCF] 核验并处置：Unbounded composite parts amplify LLM output into database DoS |
| [YUK-1220](https://linear.app/yukoval-studios/issue/YUK-1220) | Backlog | [SCF] 核验并处置：Redacted migration captures retain private question text |
| [YUK-1216](https://linear.app/yukoval-studios/issue/YUK-1216) | Backlog | [SCF] 核验并处置：Stale workers bypass the epoch fence for subscription writes |
| [YUK-1215](https://linear.app/yukoval-studios/issue/YUK-1215) | Backlog | [SCF] 核验并处置：Submission endpoint permits unbounded writes to one evaluation group |
| [YUK-1213](https://linear.app/yukoval-studios/issue/YUK-1213) | Backlog | [SCF] 核验并处置：Unbounded advice image refs can exhaust server memory |
| [YUK-1211](https://linear.app/yukoval-studios/issue/YUK-1211) | Backlog | [SCF] 核验并处置：Cutover backup exposes private data in the checkout |
| [YUK-1209](https://linear.app/yukoval-studios/issue/YUK-1209) | Backlog | [SCF] 核验并处置：Unbounded hot budgets can enable excessive paid AI execution |
| [YUK-1208](https://linear.app/yukoval-studios/issue/YUK-1208) | Backlog | [SCF] 核验并处置：Raw mastery deltas exposed by trend endpoint |
| [YUK-1207](https://linear.app/yukoval-studios/issue/YUK-1207) | Backlog | [SCF] 核验并处置：Latent DoS in prereq propagation CTE |
| [YUK-1206](https://linear.app/yukoval-studios/issue/YUK-1206) | Backlog | [SCF] 核验并处置：Vision judge OAuth misconfig falls back to Xiaomi |
| [YUK-1205](https://linear.app/yukoval-studios/issue/YUK-1205) | Backlog | [SCF] 核验并处置：Completed onboarding uploads keep SSE connections open |
| [YUK-1204](https://linear.app/yukoval-studios/issue/YUK-1204) | Backlog | [SCF] 核验并处置：Unbounded placement knowledgeIds enables DB DoS |
| [YUK-1203](https://linear.app/yukoval-studios/issue/YUK-1203) | Backlog | [SCF] 核验并处置：Mem0 restore can leave stale memories behind |
| [YUK-1202](https://linear.app/yukoval-studios/issue/YUK-1202) | Backlog | [SCF] 核验并处置：Malformed merge event can crash nightly dedup |
| [YUK-1201](https://linear.app/yukoval-studios/issue/YUK-1201) | Backlog | [SCF] 核验并处置：Unbounded placement scope fans out DB reads |
| [YUK-1200](https://linear.app/yukoval-studios/issue/YUK-1200) | Backlog | [SCF] 核验并处置：Unindexed stream_item_id lookup can slow submissions |
| [YUK-1199](https://linear.app/yukoval-studios/issue/YUK-1199) | Backlog | [SCF] 核验并处置：Preflight accepts OCR engine values the worker rejects |
| [YUK-1198](https://linear.app/yukoval-studios/issue/YUK-1198) | Backlog | [SCF] 核验并处置：Duplicate node IDs can make one edit mutate many nodes |
| [YUK-1197](https://linear.app/yukoval-studios/issue/YUK-1197) | Backlog | [SCF] 核验并处置：Note reader trusts untyped block attrs, causing stored UI DoS |
| [YUK-1194](https://linear.app/yukoval-studios/issue/YUK-1194) | Backlog | [SCF] 核验并处置：Web-sourced questions can bypass solve verification |
| [YUK-1193](https://linear.app/yukoval-studios/issue/YUK-1193) | Backlog | [SCF] 核验并处置：VLM extraction is logged as Tencent OCR |
| [YUK-1191](https://linear.app/yukoval-studios/issue/YUK-1191) | Backlog | [SCF] 核验并处置：Unbounded proposal status pagination enables DB DoS |
| [YUK-1190](https://linear.app/yukoval-studios/issue/YUK-1190) | Backlog | [SCF] 核验并处置：Git guard misses commands after unspaced shell operators |
| [YUK-1188](https://linear.app/yukoval-studios/issue/YUK-1188) | Backlog | [SCF] 核验并处置：Self-conflicting note patches can partially auto-apply |
| [YUK-1186](https://linear.app/yukoval-studios/issue/YUK-1186) | Backlog | [SCF] 核验并处置：Nightly ranker can scan unbounded score history |
| [YUK-1185](https://linear.app/yukoval-studios/issue/YUK-1185) | Backlog | [SCF] 核验并处置：Quiz planner bypasses placement cost reservation |
| [YUK-1184](https://linear.app/yukoval-studios/issue/YUK-1184) | Backlog | [SCF] 核验并处置：Planner tools expose failed answers through prompt injection |
| [YUK-1183](https://linear.app/yukoval-studios/issue/YUK-1183) | Backlog | [SCF] 核验并处置：Image proposals lose cross-run cooldown deduplication |
| [YUK-1182](https://linear.app/yukoval-studios/issue/YUK-1182) | Backlog | [SCF] 核验并处置：VLM-extracted answers can be certified as official |
| [YUK-1181](https://linear.app/yukoval-studios/issue/YUK-1181) | Backlog | [SCF] 核验并处置：Probe image refs allow oversized LLM payloads |
| [YUK-1180](https://linear.app/yukoval-studios/issue/YUK-1180) | Backlog | [SCF] 核验并处置：Unbounded active-goal load enables summary DoS |
| [YUK-1179](https://linear.app/yukoval-studios/issue/YUK-1179) | Backlog | [SCF] 核验并处置：Probe answer can trigger unbounded LLM judging cost |
| [YUK-1178](https://linear.app/yukoval-studios/issue/YUK-1178) | Backlog | [SCF] 核验并处置：Golden capture script can commit private production data |
| [YUK-1177](https://linear.app/yukoval-studios/issue/YUK-1177) | Backlog | [SCF] 核验并处置：Authenticated DoS via unbounded merge-event gather |
| [YUK-1176](https://linear.app/yukoval-studios/issue/YUK-1176) | Backlog | [SCF] 核验并处置：MATCH audit events enter memory brief LLM pipeline |
| [YUK-1175](https://linear.app/yukoval-studios/issue/YUK-1175) | Backlog | [SCF] 核验并处置：Unbounded placement leanings can exhaust DB resources |
| [YUK-1174](https://linear.app/yukoval-studios/issue/YUK-1174) | Backlog | [SCF] 核验并处置：Unbounded nightly axis scan enables authenticated DoS |
| [YUK-1173](https://linear.app/yukoval-studios/issue/YUK-1173) | Backlog | [SCF] 核验并处置：Nightly conjecture job can be DoSed by huge KC ref arrays |
| [YUK-1172](https://linear.app/yukoval-studios/issue/YUK-1172) | Backlog | [SCF] 核验并处置：Nightly KC dedup can cause database CPU DoS |
| [YUK-1171](https://linear.app/yukoval-studios/issue/YUK-1171) | Backlog | [SCF] 核验并处置：tagKnowledge commits before review and accept gates |
| [YUK-1170](https://linear.app/yukoval-studios/issue/YUK-1170) | Backlog | [SCF] 核验并处置：Profile endpoint processes unbounded goal scopes |
| [YUK-1169](https://linear.app/yukoval-studios/issue/YUK-1169) | Backlog | [SCF] 核验并处置：Goal scopes are stored without validation or size limits |
| [YUK-1168](https://linear.app/yukoval-studios/issue/YUK-1168) | Backlog | [SCF] 核验并处置：Unbounded telemetry fan-out can exhaust the DB pool |
| [YUK-1167](https://linear.app/yukoval-studios/issue/YUK-1167) | Backlog | [SCF] 核验并处置：Stale note proposals can overwrite verified blocks |
| [YUK-1166](https://linear.app/yukoval-studios/issue/YUK-1166) | Backlog | [SCF] 核验并处置：Orphaned claim recovery permits duplicate agent runs |
| [YUK-1165](https://linear.app/yukoval-studios/issue/YUK-1165) | Backlog | [SCF] 核验并处置：Agent proposals accept fabricated evidence refs |
| [YUK-1163](https://linear.app/yukoval-studios/issue/YUK-1163) | Backlog | [SCF] 核验并处置：Edge accept parity loads all live edges, enabling DoS |
| [YUK-1162](https://linear.app/yukoval-studios/issue/YUK-1162) | Backlog | [SCF] 核验并处置：Reference backfill can overrun queue timeout |
| [YUK-1161](https://linear.app/yukoval-studios/issue/YUK-1161) | Backlog | [SCF] 核验并处置：Sub-question judging still leaks whole-row judge material |
| [YUK-1160](https://linear.app/yukoval-studios/issue/YUK-1160) | Backlog | [SCF] 核验并处置：Prompt-injected uploads can auto-create approved KCs |
| [YUK-1159](https://linear.app/yukoval-studios/issue/YUK-1159) | Backlog | [SCF] 核验并处置：Cold-start uploads bypass source verification gate |
| [YUK-1158](https://linear.app/yukoval-studios/issue/YUK-1158) | Backlog | [SCF] 核验并处置：Deferred note-refine patches bypass the new rate breaker |
| [YUK-1157](https://linear.app/yukoval-studios/issue/YUK-1157) | Backlog | [SCF] 核验并处置：Malformed mem0 backup entries preserve stale memories |
| [YUK-1155](https://linear.app/yukoval-studios/issue/YUK-1155) | Backlog | [SCF] 核验并处置：Nightly KT job can replay unbounded review history |
| [YUK-1154](https://linear.app/yukoval-studios/issue/YUK-1154) | Backlog | [SCF] 核验并处置：Privileged workflow trusts untrusted PR comments |
| [YUK-1152](https://linear.app/yukoval-studios/issue/YUK-1152) | Backlog | [SCF] 核验并处置：Draft quiz practice updates FSRS before proposal accept |
| [YUK-1151](https://linear.app/yukoval-studios/issue/YUK-1151) | Backlog | [SCF] 核验并处置：PDF rendering can exhaust server CPU and memory |
| [YUK-1150](https://linear.app/yukoval-studios/issue/YUK-1150) | Backlog | [SCF] 核验并处置：Few-shot examples can prompt-inject QuizGen tools |
| [YUK-1149](https://linear.app/yukoval-studios/issue/YUK-1149) | Backlog | [SCF] 核验并处置：Unbounded answer image refs reach vision judge |
| [YUK-1147](https://linear.app/yukoval-studios/issue/YUK-1147) | Backlog | [SCF] 核验并处置：Buffered verdicts leak through returned event IDs |
| [YUK-1146](https://linear.app/yukoval-studios/issue/YUK-1146) | Backlog | [SCF] 核验并处置：Vision judge can leak unrelated document images |
| [YUK-1145](https://linear.app/yukoval-studios/issue/YUK-1145) | Backlog | [SCF] 核验并处置：Copilot can exfiltrate private context via Tavily MCP |
| [YUK-1144](https://linear.app/yukoval-studios/issue/YUK-1144) | Backlog | [SCF] 核验并处置：Low-confidence LLM grading is auto-enrolled |
| [YUK-1143](https://linear.app/yukoval-studios/issue/YUK-1143) | Backlog | [SCF] 核验并处置：Unbounded solve submissions enable paid LLM/image DoS |
| [YUK-1140](https://linear.app/yukoval-studios/issue/YUK-1140) | Backlog | [SCF] 核验并处置：Per-brief cap is bypassed by unbounded event scans |
| [YUK-1138](https://linear.app/yukoval-studios/issue/YUK-1138) | Backlog | [SCF] 核验并处置：Unbounded mistake filter scan enables authenticated DoS |
| [YUK-1135](https://linear.app/yukoval-studios/issue/YUK-1135) | Backlog | [SCF] 核验并处置：Supersede proposals are shown as simple edge additions |
| [YUK-1133](https://linear.app/yukoval-studios/issue/YUK-1133) | Backlog | [SCF] 核验并处置：Duplicate merge bypasses KC verification |
| [YUK-1130](https://linear.app/yukoval-studios/issue/YUK-1130) | Backlog | [SCF] 核验并处置：Wrong-streak nudge evaluation can exhaust DB/worker resources |
| [YUK-1129](https://linear.app/yukoval-studios/issue/YUK-1129) | Backlog | [SCF] 核验并处置：Copilot run_task bypasses graph context caps |
| [YUK-1126](https://linear.app/yukoval-studios/issue/YUK-1126) | Backlog | [SCF] 核验并处置：Learning validator misses secondary HTML channels |
| [YUK-1125](https://linear.app/yukoval-studios/issue/YUK-1125) | Backlog | [SCF] 核验并处置：Stored cross-agent prompt injection via agent notes |
| [YUK-738](https://linear.app/yukoval-studios/issue/YUK-738) | Backlog | Add auditable ASR/TTS audio evidence path for English listening and speaking |
| [YUK-1083](https://linear.app/yukoval-studios/issue/YUK-1083) | Backlog | 存量 seed:*:root FSRS 行与 seed-root 绑题的 owner ops 处置 |
| [YUK-1105](https://linear.app/yukoval-studios/issue/YUK-1105) | Backlog | 历史迁移 revision-registry producer + pending→resolved 回放（接 YUK-1050） |
| [YUK-1085](https://linear.app/yukoval-studios/issue/YUK-1085) | Backlog | YUK-572 P3：dreaming + maintenance charter 化（接 evidence-scout + objective 升章程） |
| [YUK-506](https://linear.app/yukoval-studios/issue/YUK-506) | Backlog | P3 教学法脑 — 8-method palette + 确定性 policy() + 3 anti-learning-styles locks（panel-SELECT step） |
| [YUK-1108](https://linear.app/yukoval-studios/issue/YUK-1108) | Backlog | worker-boot scoped QA 10秒等待超时：保留原始 RED 并验证同步条件 |
| [YUK-1101](https://linear.app/yukoval-studios/issue/YUK-1101) | Backlog | 迁移捕获 checkpoint：question/learning_record 的 updated_at+version 既不采集也不声明 —— 观测盲区需补齐或显式排除 |
| [YUK-572](https://linear.app/yukoval-studios/issue/YUK-572) | Backlog | 背景 agent 运行时 — 议程权分层 + charter 化（例会/dreaming/maintenance）+ 共享 subagent 能力 + shadow 对照翻转 |
| [YUK-1087](https://linear.app/yukoval-studios/issue/YUK-1087) | Backlog | YUK-452 inc-F：LLM 学生模拟（day-one 评测模拟器） |
| [YUK-1086](https://linear.app/yukoval-studios/issue/YUK-1086) | Backlog | YUK-452 inc-D：AutoElicit 式 LLM θ 先验（dark-ship on THETA_GRID） |
| [YUK-1033](https://linear.app/yukoval-studios/issue/YUK-1033) | Backlog | 学段纠正面：goal.declared_stage 的用户可达编辑入口（YUK-1009 follow-up） |
| [YUK-1029](https://linear.app/yukoval-studios/issue/YUK-1029) | Backlog | GPT-6 Astra P3：冻结迁移任务清单并完成真实输出对照与灰度验收 |
| [YUK-1028](https://linear.app/yukoval-studios/issue/YUK-1028) | Backlog | GPT-6 Astra P2：费用归因、缓存与逐次调用预算闭合 |
| [YUK-1080](https://linear.app/yukoval-studios/issue/YUK-1080) | Backlog | [待 owner] supply_planner 跨科目规划硬编码 PLANNER_HOST_SUBJECT=math——per-subject 还是显式宿主配置 |
| [YUK-999](https://linear.app/yukoval-studios/issue/YUK-999) | Backlog | matcher 接 live caller 后用真实 demand embedding 重跑 axis C 标定（评估 0.45–0.55 带） |
| [YUK-550](https://linear.app/yukoval-studios/issue/YUK-550) | Backlog | kg-borrowing × frontier evidence-floor：flag 翻转前必须重审 tracked trigger（打磨#4 frontier-gate Q4 归属） |
| [YUK-907](https://linear.app/yukoval-studios/issue/YUK-907) | Backlog | Agent-note 确定性写端扩面：owner 审批阈值、聚合边界与载体 |
| [YUK-859](https://linear.app/yukoval-studios/issue/YUK-859) | Backlog | [FULL/F2.P1] Decide JobYield dependency acceptance policy |
| [YUK-767](https://linear.app/yukoval-studios/issue/YUK-767) | Backlog | 架构耦合深度 + 多用户就绪度：owner 方向信号落地（含 07-24「单用户 by-design」处置再审清单） |
| [YUK-698](https://linear.app/yukoval-studios/issue/YUK-698) | Backlog | [Supply-v2/0] 建立证据需求驱动的可靠供给控制面 |
| [YUK-774](https://linear.app/yukoval-studios/issue/YUK-774) | Backlog | 夜间任务编排 DAG 运行态：admin observability 读面 + 「今晚图」可视化 UI（YUK-758 follow-up） |
| [YUK-508](https://linear.app/yukoval-studios/issue/YUK-508) | Backlog | POLY_SIGMOID_ENABLED 全核 σ flip — 高风险 prod op（DB 混存污染 + 2 前置 gate + SoT runbook） |
| [YUK-563](https://linear.app/yukoval-studios/issue/YUK-563) | Backlog | 原生多端 app（ArkUI 华为 + Flutter 苹果 + 共享 Rust 核）— 全原生定稿 |
| [YUK-552](https://linear.app/yukoval-studios/issue/YUK-552) | Backlog | evidence-floor 维度进 UI(frontier readiness 的证据量露出)——gated-future,owner 选中才启 |
| [YUK-545](https://linear.app/yukoval-studios/issue/YUK-545) | Backlog | mastery 冻结行的解冻门实施 — LFA 模型比较 / CDM 属性可区分度（数据够后） |
| [YUK-530](https://linear.app/yukoval-studios/issue/YUK-530) | Backlog | A5 S3 DiagnosticDrill（CDM/IRT 诊断下钻）后端读路径 follow-up — gated ADR-0035 #4 |
| [YUK-509](https://linear.app/yukoval-studios/issue/YUK-509) | Backlog | WASM-in-browser — calibration-native polySigmoidBatch 接进 SPA（trust upgrade，非必需 spike） |
