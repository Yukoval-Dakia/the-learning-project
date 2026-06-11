# M4：能动 + 工作台 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。

**Goal:** 夜链（dreaming/coach/maintenance/ReviewPlan→流编排臂）入新容器；提议生命周期契约真身（actions.ts 的 applier 按 kind 进包）；工作台（today 重生）+ 收件箱上 SPA。验收口径（spec line 339）：「夜间跑完，早上工作台有交班条与待审提议」。YUK-318（边提议已决状态缺服务端过滤）并入收件箱范围收口。

**Architecture:** 总 spec REV 2 §4-M4 + §2.3 包菜单：新建 `agency` 包（spec line 210「夜间编排：dreaming/coach/maintenance + agent-notes 内部信道 + 路径维护（learning_item AI 全权）」）+ 新建 `shell` 包（line 215「工作台（交班台组装）+ 导航 + 主题 + 备份恢复入口」——M4 只落工作台+收件箱，导航/主题/备份是 M5）。kernel 第一实例时刻：manifest 加 `jobs` 与 `proposals` 两契约字段（manifest.ts:3 注释预留的时机）。UI 按 claude design 设计稿（`screen-today.jsx` / `screen-mistakes.jsx` 之 ScreenInbox / `screen-agentnotes.jsx` 之 AgentNotesBoard）在 web/ 重建。采伐配方沿 M1-M3 三联（随迁测试绿 + typecheck + 零残留 grep）。

**Linear:** YUK-319（Closes）+ YUK-318（Closes，T5 收口）。分支 `yuk-319-m4-agency-workbench`。

**红线：** 每 task typecheck 绿；UI 任务（T6）须 pre-flight 预批（本 plan §UI pre-flight 即预批材料）；「科目是视角不是结构」；被裁功能的表不删（墓碑注释）；gate 命令用重定向模式（`cmd > /tmp/x.log 2>&1; echo "exit=$?"`）；commit 标题含 YUK-319、footer Co-Authored-By。

**出范围（M4 不动）：** coach 周报页 + `GET /api/review/weekly`（留旧栈，M5 收编）；`/api/cost/today`（AI 成本域随 Copilot/M5）；`/api/today/copilot-summary`（Copilot 域，M5）；Copilot 工具贡献制（M5）；shell 的导航/主题/备份恢复入口（M5）；embedded_check_generate handler（D6 死刑候补，M5 统一删）；prune 类 / ingest 链 / outbox / memory brief / session_summary / attribution_followup 等未迁域 job 注册（留 handlers.ts 渐缩簿）；NoteRenderer/block-tree 留任审查（M3 遗留，若 learning-items 旧页仍引用则继续留 M5）。

---

## 裁决记录（Map 阶段确认点）

| # | 问题 | 裁决 | 理由 |
|---|---|---|---|
| 1 | agent-notes 包是否并入 agency | **并入** | spec line 210 明示 agency 含「agent-notes 内部信道」；M4 正是建 agency 包的时刻，当下并入避免留尾巴。纯机械搬迁：git mv + manifest 合并 + 组合根/router/文档 repoint，`/api/agents/notes` 路径不变 |
| 2 | review_plan 归属 | **practice 包 jobs/** | spec M4 行明示「ReviewPlan→流编排臂」；它只读 FSRS、产出排程喂 composeDailyStream，是 practice 域的编排输入。链式触发形态不变（coach_daily 成功后 boss.send，无独立 cron） |
| 3 | goal_scope_propose_nightly + goal_scope applier 归属 | **agency 包** | goal 域是 coach/dreaming 的输入面，cron 紧跟 coach_daily（03:50 读 same-night goals） |
| 4 | learning_item / completion / relearn / defer / archive applier 归属 | **agency 包** | D10：learning_item 路径维护 AI 全权，用户工作台审批纠偏——路径维护正是 agency 的第三职责 |
| 5 | record_links / record_promotion applier | **不迁——D11 墓碑** | 学习记录域已裁（study-log 410 墓碑壳）；applier 原样挪入 `src/server/proposals/legacy-record-appliers.ts` + 文件头 D11 墓碑注释（dev 库可能存历史 pending record_* 提议，decide 通路保持可用），M5 拆除采石场统一删 |
| 6 | jobs 契约形态 | manifest 声明 + 组合根注册器 | `JobDecl = { name, schedule?, queue, load }`；load 懒 thunk 沿 ApiRouteDecl 先例（manifest 纯元数据，unit 分区不被污染）。注册器 `registerCapabilityJobs` 从组合根收集，handlers.ts 渐缩为未迁域注册簿 |
| 7 | proposals 契约真身形态 | manifest 声明 kind 归属 + actions.ts 瘦身为纯 dispatch | 反过度工程：不建动态 registry。switch 骨架留 actions.ts，14 个有 apply 通路的 case 一行委托各包导出 applier（M3 已有先例：knowledge_node/mutation/edge、note_update 即委托形态）；manifest.proposals 声明归属，validateComposition 校验 kind 全局唯一，composition test 断言归属覆盖 schema 枚举防漂移。**dispatch 留中央的 spec 依据**（Critic 维持后补论证）：spec line 170 自言「收件箱查询、accept/dismiss、行锁、幂等内核统一做」——生命周期壳中央化是 spec 自己的设计，「按 kind 进包」指的是落地器（applier），不是 dispatch |
| 8 | 收件箱/decide API 归属 | **shell 包** | spec line 199「proposal kind 由各包 manifest 贡献，shell/copilot 只组装」——收件箱正是组装 proposal kinds 的 surface。`GET /api/proposals`（服务端 status 过滤，YUK-318 收口）复用 `listProposalInbox` 投影（排序 cooldown_active DESC, acceptance_rate ASC, created_at DESC 不变）。**decide 与 retract 拆两条路由**（Critic C1 修订）：`POST /api/proposals/:id/decide` 只承担 **pending 态决定**（accept/reverse/change_type/dismiss，body `{ decision, new_relation_type? }`——合并旧 accept+dismiss 两路由）；retract 是**撤销已接受提议**的独立生命周期操作（不要求 pending、写 correct 事件、body `{ reason_md?, affected_refs? }` 驱动 side-effect 回滚，actions.ts:2062），保留独立 `POST /api/proposals/:id/retract`，不并入 decide——等价平移红线下不得静默改 retract 契约 |
| 9 | 工作台聚合 API | shell 包 `GET /api/workbench/summary` 单次聚合 | 旧 today 页 9-API 瀑布是反面教材；聚合内部 import 各包导出的 read 函数（包→包单向读，M3 node-page→notes-read 先例）。**新栈避开 `/api/today` 前缀**——`/api/today/copilot-summary` 须继续走旧栈 proxy 兜底，前缀让开避免分流冲突 |
| 10 | 工作台 KPI 数据边界 | 只取已迁域 | due/会话（practice）、待审提议（inbox 投影）、agent notes（agency）、AI 改动（notes）、7 天热力（practice attempt 聚合）；mistakes/learning-items 等未迁域不进 M4 工作台 |
| 11 | today/ai-changes 数据面 | 迁 notes 包 | 数据是 artifact AI 改动（M3 已有 per-artifact ai-changes API）；全局近 24h 列表作为 notes 包新 decl `GET /api/artifacts/ai-changes/recent`，旧 `/api/today/ai-changes` 壳随 T7 拆 |
| 12 | coach 周报页 | 留旧栈不拆 | spec M4 行不含 coach 周报 UI；夜链 job 迁走不影响旧页读 `/api/review/weekly`（proxy 兜底），M5 收编 |
| 13 | 夜链验收方式 | 手动触发等价验收 | 不等真夜跑：tsx 脚本 `boss.send('dreaming_nightly')` / `coach_daily` 打进新容器（RW_WORKER=1），确认消费 + agent-notes 写入 + review_plan 链式触发 + 工作台交班条显示 |

**schema kind 全集（17）与 actions.ts switch（14 case）的差集**（Critic M3 重框）：`defer` / `archive` / `judge_retraction` 不是「无通路孤儿」——三者**有 producer 在产**（producers.ts:262 defer、producers.ts:307 + knowledge/server/review.ts:191 archive、producers.ts:454 judge_retraction），只是 accept switch 无 case，accept 时落 default throw `unsupported_proposal_kind`（actions.ts:646，YUK-44 持有剩余 producer 语义）。**归属与 applier 存在性解耦**：归属按 producer 域定——`archive` → knowledge（review.ts 在产）、`defer` → agency（D10 路径维护域）、`judge_retraction` → practice（judge/rejudge 域）；三者 manifest 声明照写，accept 通路保持 default throw 现状（M4 不补造 applier，YUK-44 收口），各归属包 proposal-appliers 注释注明。对账测试断言的是**归属覆盖 schema 枚举**，与 accept-applier 是否存在无关。

---

### Task 1: kernel 契约扩展（jobs + proposals 第一实例）

**Files:**
- Modify: `src/kernel/manifest.ts`（加 `jobs?` / `proposals?` 字段 + validateComposition 校验）
- Modify: `src/kernel/manifest.unit.test.ts`（合成 manifest 测 job 名/kind 全局唯一冲突抛错）
- Modify: `src/capabilities/composition.unit.test.ts`（**Critic M5 修正路径**——它才 import 真实 capabilities 数组；kind 归属与 schema 枚举对账断言放这里）

**形态（与 ApiRouteDecl 同构的懒 thunk）：**

```ts
/** pg-boss job handler 工厂——与现 buildXHandler(db) 形态一致 */
export type JobHandlerFactory = (db: unknown) => (job: unknown) => Promise<void>;

export interface JobDecl {
  name: string; // boss queue 名，如 'dreaming_nightly'
  /** cron 调度；无 schedule 的是链式/按需 job（如 review_plan） */
  schedule?: { cron: string; tz: string };
  /** 队列档位 → handlers.ts 三档 opts（EXPIRE_LLM / EXPIRE_AGENT / FAST_QUEUE_OPTS） */
  queue: 'llm' | 'agent' | 'fast';
  load?: () => Promise<JobHandlerFactory>;
}

export interface ProposalKindDecl {
  kind: string; // AiProposalPayload kind，如 'learning_item'
}

export interface CapabilityManifest {
  // …现有字段
  jobs?: { handlers: JobDecl[] };
  /** 本包拥有的 proposal kind（applier 实现在包 server/，dispatch 见 actions.ts 瘦壳） */
  proposals?: { kinds: ProposalKindDecl[] };
}
```

**Steps:**
- [ ] manifest.ts 加字段 + 文件头注释更新（第一实例时机已到）；validateComposition 加 job name、proposal kind 两个全局唯一校验（与 routes 同构）
- [ ] 组合测试加两断言：①job/kind 冲突抛错（manifest.unit.test.ts 合成 manifest 覆盖）②全包声明的 proposal kinds 并集 == `AiProposalPayload` schema kind 枚举全集 **减去 D11 豁免集**（composition.unit.test.ts；豁免机制 = **subtract-from-expected**：`record_links`/`record_promotion` 从期望集合中减除并注 D11，绝不加进声明侧——防止豁免名单悄悄变成第二归属表）
- [ ] `pnpm test:unit` 组合测试绿 + typecheck → commit

### Task 2: agency 包创建（吞并 agent-notes + 夜链三 job + goal_scope 链）

**Files:**
- Create: `src/capabilities/agency/manifest.ts`、`src/capabilities/agency/CONTEXT.md`
- Move: `src/capabilities/agent-notes/**` → `src/capabilities/agency/`（server/api/ui 子目录原样并入；manifest 合并进 agency manifest，events action `experimental:agent_note` 与 `GET /api/agents/notes` decl 不变）
- Move: `src/server/boss/handlers/{dreaming_nightly,coach_daily,coach_weekly,goal_scope_propose_nightly}.ts` + **`goal_scope_dedup.ts`（sibling dep，Critic M2——handler:42 import `./goal_scope_dedup`）** + 各自测试 → `src/capabilities/agency/jobs/`
- Move: **`src/server/goals/**`（accept.ts/queries.ts/scope.ts/scope.test.ts）→ `src/capabilities/agency/server/goals/`**（Critic M1：goal 域是 agency 输入面（裁决 #3 既定），留 src/server/ 会让 T2 的 handler 与 T4 的 applier 反向深 import 旧树，违反 spec line 196 规则 #1；迁移前 `grep -rln "server/goals" --include='*.ts*'` 记基线，全部引用方 repoint）
- Modify: `src/capabilities/index.ts`（agentNotesCapability → agencyCapability）
- Modify: `web/src/router.tsx`（AgentNotesPage import 路径 repoint，`/agent-notes` 路由不变）
- Modify: 域外 import 改道（dreaming/coach 的引用方：handlers.ts 注册行 T3 处理；AI tools / orchestrator 引用实施时 grep）

**Steps:**
- [ ] 改道前 `grep -rln "@/capabilities/agent-notes\|boss/handlers/dreaming_nightly\|boss/handlers/coach\|boss/handlers/goal_scope\|server/goals" --include='*.ts*'` 记基线（含 tests/ 与注释路径）；另 `grep -n "from './" src/server/boss/handlers/{dreaming_nightly,coach_daily,coach_weekly,goal_scope_propose_nightly}.ts` 兜底同目录 sibling deps 全集（M2 教训：move list 漏 sibling 是执行者撞墙点）
- [ ] git mv agent-notes → agency + 组合根/router/文档（ARCHITECTURE / CONTEXT 索引若引用）repoint；manifest 合并须保留原 `GET /api/agents/notes` decl 与 `experimental:agent_note` action 原样；typecheck 绿
- [ ] git mv 夜链 handler + goal_scope_dedup + `src/server/goals/**` + 测试入位（unit 测试沿 M2/M3 先例重命名 `*.unit.test.ts` + vitest.shared.ts fastTestInclude 删旧条目）；import 全仓改道至基线归零。注：goal_scope handler 现有 `@/capabilities/knowledge/server/tree` 深 import（loadTreeSnapshot）——pre-existing，等价平移不改，原处加一行注释标记 M5 读 seam 收口
- [ ] agency manifest 写 jobs 声明：dreaming_nightly（15 3 * * * / agent 档）、coach_daily（45 3 * * * / llm）、coach_weekly（30 4 * * 0 / llm）、goal_scope_propose_nightly（50 3 * * * / llm，singleton 语义注释保留）；proposals kinds 声明留 T4 填
- [ ] 随迁测试绿（unit + db 分区各跑）+ typecheck → commit

### Task 3: jobs 注册改组合根收集 + review_plan → practice

**Files:**
- Move: `src/server/boss/handlers/review_plan.ts` + 测试 → `src/capabilities/practice/jobs/`
- Create: `src/server/boss/register-capability-jobs.ts`（从组合根收集 manifest.jobs：createJobQueue 按 queue 档位 + boss.work(load 解析) + boss.schedule）
- Modify: `src/server/boss/start-worker.ts`（registerHandlers 之后追加 registerCapabilityJobs(boss, db, capabilities)）
- Modify: `src/server/boss/handlers.ts`（删除已迁 job 的注册行/动态 import：dreaming/coach×2/goal_scope/review_plan + M3 已迁包内的 knowledge×4、notes×4 注册行——后者的 jobs 声明同步补进 knowledge/notes 两包 manifest）
- Modify: `src/capabilities/knowledge/manifest.ts`、`src/capabilities/notes/manifest.ts`（补 jobs 声明：knowledge_propose_nightly 0 2 * * *、knowledge_edge_propose_nightly 30 2 * * *、knowledge_maintenance_nightly 0 3 * * *、attribution 类按实际核对；hub_auto_sync_nightly 45 2 * * *、note_generate、note_verify、note-refine——cron/链式形态照 handlers.ts 现状一字不改）
- Modify: `src/capabilities/practice/manifest.ts`（jobs: review_plan + **rejudge**——两者均无 schedule 链式触发；rejudge 已住 practice/jobs/ 但注册仍在 handlers.ts inline（handlers.ts:166-172），本 task 一并改 manifest 声明保持一致性，Critic 遗漏扫描裁定；coach_daily 内的 boss.send 调用点 import 路径随 T2 改道）

**Steps:**
- [ ] register-capability-jobs.ts：遍历 capabilities → 有 load 的 decl 逐个建队列 + `boss.work(name, (await decl.load())(db))` + 有 schedule 的 `boss.schedule(name, cron, {}, { tz })`；无 load 的 decl 是纯归属元数据不挂载（ApiRouteDecl 同构语义）。**队列建法分档（Critic m3）**：`llm`/`agent` 档走 `createJobQueue`（先建 `<name>_dlq` 再建主队列，handlers.ts:141-144 顺序保持）；`fast` 档走 `createOrUpdateQueue` **无 DLQ**——注册器不得统一建 DLQ
- [ ] handlers.ts 渐缩：删已迁注册行，文件头注释改写为「未迁域 job 注册簿（M5 拆除采石场清账）」+ 现存清单。**两条保活确认（Critic 遗漏扫描）**：①`registerMemoryHandlers` 调用（handlers.ts:187，memory 域 M5）不得随渐缩误删；②`embedded_check_generate` 队列注册保留——note_verify（T3 迁 notes manifest）成功后 `boss.send('embedded_check_generate')`（handlers.ts:394 链），目标队列仍须在渐缩簿注册，否则链式发送落空
- [ ] 双拓扑验证：`pnpm rw:api` 冷启（RW_WORKER=1）日志确认全部队列注册无 23505 崩溃；`pnpm test:db` 中 boss 相关测试绿
- [ ] 夜链等价验收（裁决 #13）：tsx 脚本 boss.send('dreaming_nightly', {}) + boss.send('coach_daily', {})，确认新容器消费、agent_note 事件写入、coach_daily 成功后链式 review_plan 入队消费
- [ ] typecheck + 零残留 grep（`boss/handlers/review_plan\|boss/handlers/coach\|boss/handlers/dreaming`）→ commit

### Task 4: 提议生命周期契约真身（applier 按 kind 进包）

**Files:**
- Modify: `src/server/proposals/actions.ts`（2151 行 → 纯 dispatch 瘦壳：switch 各 case 一行委托；applier 实现体迁出）
- Create（迁入目标，每包一个 appliers 入口模块）:
  - `src/capabilities/practice/server/proposal-appliers.ts` ← variant_question（actions.ts:1623-1693）、question_draft（1813-1890）；**judge_retraction 归属声明**（judge/rejudge 域，有 producer（producers.ts:454）无 accept-applier，default throw 现状保留注 YUK-44）
  - `src/capabilities/agency/server/proposal-appliers.ts` ← learning_item（763-831）、completion（958-1046）、relearn（1049-1122）、goal_scope（620-632，委托 T2 已迁入 agency 的 server/goals/accept）；**defer 归属声明**（D10 路径维护域，同上无 applier 注 YUK-44）
  - `src/capabilities/ingestion/server/proposal-appliers.ts` ← block_merge（1525-1607）、image_candidate（委托 image-candidate-accept.ts，789 行随迁 ingestion）
  - knowledge_node/mutation/edge、note_update：M3 已是委托形态，本 task 只把 manifest.proposals 声明补上；**archive 归属 knowledge**（Critic M3：knowledge/server/review.ts:191 在产，归属按 producer 域定，无 accept-applier 注 YUK-44）
- Create: `src/server/proposals/legacy-record-appliers.ts` ← record_links（1225-1318）、record_promotion（1353-1508），文件头 D11 墓碑注释（裁决 #5）
- Modify: 各包 manifest 补 `proposals.kinds` 声明（kernel 对账测试此时转绿）
- Move/Split: `src/server/proposals/actions.test.ts`（2500 行）按 kind 随迁各包（`*.db.test.ts` 命名分区）；dispatch 层公共测试（状态机/权限/链式 event 写入）留 actions.test.ts 原位瘦身

**Steps:**
- [ ] 先核对差集三 kind（defer/archive/judge_retraction）的 producer 通路与 default throw 现状（见裁决表下差集段），结论写进 actions.ts 头注释；另 `grep -rn "kind: 'defer'\|kind: 'judge_retraction'\|kind: 'archive'" --include='*.test.ts'` 确认是否有现存测试依赖 default throw 行为，有则原样保留
- [ ] 逐包搬迁 applier（**一包一 commit，强制**——T7 的「单 commit 可整体 revert」同等粒度，practice/agency/ingestion/legacy 四段分明，中途任一段红可独立 revert）：函数原样移动 + actions.ts case 改一行委托 + import 改道；**搬迁不改逻辑**（等价平移红线，行为变更零容忍）
- [ ] **import 环 invariant（Critic M4）**：各包 `proposal-appliers.ts` 模块作用域**禁止** import `@/server/proposals/{producers,writer,actions}`（环现为潜伏态——applier 不引 producer 已 grep 实证；此 invariant 防搬迁时引入）；gate：`grep -rn "server/proposals/\(producers\|writer\|actions\)" src/capabilities/*/server/proposal-appliers.ts` 必须为空，写进本 task 验收
- [ ] record_* 入 legacy 墓碑文件 + 对账测试 subtract-from-expected 豁免注 D11（T1 既定机制）
- [ ] actions.test.ts 拆分随迁；`pnpm test:db src/capabilities/` 与残余 `src/server/proposals/` 测试全绿
- [ ] typecheck + `wc -l src/server/proposals/actions.ts` 记录瘦身后行数（预期 <500）→ commit

### Task 5: proposals API 上 Hono（shell 包后端 + YUK-318 收口）

**Files:**
- Create: `src/capabilities/shell/manifest.ts`、`src/capabilities/shell/CONTEXT.md`
- Create: `src/capabilities/shell/api/proposals-list.ts`（`GET /api/proposals`：query `status` / `kind` / `limit` / `cursor`，**status 过滤在服务端**——复用 `listProposalInbox`（inbox.ts），缺省 status=pending）
- Create: `src/capabilities/shell/api/proposal-decide.ts`（`POST /api/proposals/:id/decide`，body `{ decision: 'accept'|'reverse'|'change_type'|'dismiss', new_relation_type? }`——**只合并旧 accept+dismiss 两路由**（共享 pending 前置条件），dispatch 进 actions.ts 瘦壳的 acceptAiProposal/dismissAiProposal）
- Create: `src/capabilities/shell/api/proposal-retract.ts`（`POST /api/proposals/:id/retract`，body `{ reason_md?, affected_refs? }`——**独立路由**（裁决 #8 C1 修订）：撤销已接受提议、写 correct 事件、affected_refs 驱动回滚，语义照 retractAiProposal（actions.ts:2062）原样）
- Create: `src/capabilities/shell/api/workbench-summary.ts`（`GET /api/workbench/summary`：KPI + 进行中会话 + 提议摘要（按 kind breakdown）+ 7 天热力，内部 import practice/notes/agency 包导出 read 函数；agent-notes 数据沿用现有 `GET /api/agents/notes` 不重复聚合）
- Modify: `src/capabilities/notes/api/`（新增 decl `GET /api/artifacts/ai-changes/recent`——近 24h 全局 AI 改动，复用 M3 ai-changes 查询拓宽窗口；裁决 #11）
- Modify: `src/capabilities/index.ts`（登记 shell 包）
- Modify: `web/vite.config.ts`（proxy 加 `/api/proposals`、`/api/workbench` → 8787；**`/api/today` 不动**——copilot-summary 继续兜底旧栈）
- Modify: `src/capabilities/knowledge/ui/knowledge-api.ts`（`getEdgeProposals` 换源：`GET /api/events` → `GET /api/proposals?kind=knowledge_edge&status=pending`——**YUK-318 收口**）
- Modify: `src/capabilities/knowledge/ui/KnowledgePage.tsx`（服务端过滤后删页内 `decided` Set hack——KnowledgePage.tsx:52-55 注释描述的复显问题不复存在；NodeDrawer onDecided 改 invalidate query 即可）

**Steps:**
- [ ] shell 包骨架 + 四条 api decl（kernel v2 签名 `(req, params)`，load 懒 thunk）+ 组合根登记；typecheck 绿
- [ ] proposals-list/decide/retract 路由测试（db 分区）：status 过滤断言「decide 后 refetch 不复返已决提议」（YUK-318 回归测试）+ decide 各 decision 链式 event 写入 + **retract 回归断言「已接受提议可被 retract 撤销（非 pending 态拒绝路径）」**（C1 红线验证）
- [ ] knowledge-api.ts 换源 + KnowledgePage decided hack 删除 + 相关测试更新；**换源等价断言（Critic m1）**：同一组种子边提议下，新源 `GET /api/proposals?kind=knowledge_edge&status=pending` 返回集 == 旧 events 查询（outcome ∈ success|partial 过滤）返回集——inbox 投影的 rubric_rejected 派生已天然排除 rubric 拒绝项，测试固化这一等价
- [ ] workbench-summary 聚合 + 测试（空库形态 + 种子数据形态）
- [ ] postman/api-endpoints.json 加新条目 + `pnpm gen:postman`
- [ ] `pnpm test:db src/capabilities/shell/ src/capabilities/knowledge/` 绿 + typecheck → commit

### Task 6: 工作台 + 收件箱 UI（pre-flight 见下节，预批模式）

**Files:**
- Create: `src/capabilities/shell/ui/TodayPage.tsx`（工作台 host）+ 块组件 `ui/blocks/{LoomHero,KpiRow,SessionsStrip,AiChangesStrip,ProposalStrip,AgentNotesBoard,WeekHeat}.tsx` + `ui/workbench-api.ts` + `ui/shell.css`
- Create: `src/capabilities/shell/ui/InboxPage.tsx` + `ui/ProposalCard.tsx` + `ui/inbox-api.ts`（KIND_META 静态表：17 kind 的 label/tone/icon）
- Modify: `web/src/router.tsx`（`/` redirect 改 `/today`；登记 `/today`、`/inbox` 路由，navigate prop 注入沿例）
- Modify: `src/capabilities/agency/manifest.ts` 等各包 `ui.todayBlocks` 声明（纯元数据标识；TodayPage 静态 import 块组件——反过度工程，无动态 registry）

**Steps:**
- [ ] TodayPage 布局骨架（hero → kpi-row → 今日之线 → dash-grid 双列 → AgentNotesBoard → 本周编织，对照 ScreenToday L203-241 结构）+ workbench-api 数据接线
- [ ] 各块组件落地：AiChangesStrip 撤销走 M3 undoAiChange 链；ProposalStrip 去裁决 → navigate('/inbox')；AgentNotesBoard 折叠态 + localStorage open 态 + 未读 Badge（对照 screen-agentnotes.jsx L89-159）；空/加载/错误三态每块都有（设计稿 Stateful 语义）
- [ ] InboxPage：summary 行 + 科目/类型 FilterRow + 分 kind lane + ProposalCard（kind-tag/SubjectTag/ai-tag/动作组/置信条/EvidenceReadable 白话来源行）+ 裁决后 resolved 戳记 + 全清空态
- [ ] router 登记 + `/` redirect 切 `/today`；`pnpm rw:web:build` 绿
- [ ] 包内 unit 测试（KIND_META 全覆盖断言 / dfs 类纯逻辑若有）+ typecheck → commit

### Task 7: 拆旧壳（单 commit 可整体 revert）

**Files（Delete）:**
- `app/(app)/today/page.tsx` + 同目录组件 + **同目录测试**（Critic m2 点名：page 测试与 `/api/today/{proposals,ai-changes}` 的唯一消费者一起删，无 orphan）
- `app/(app)/inbox/page.tsx` + `proposal-shared.tsx` + `inbox.test.tsx`
- `app/api/proposals/route.ts` + `route.test.ts` + `[id]/{accept,dismiss}/route.ts`（被 shell decide 替代）+ `[id]/retract/route.ts`（被 shell retract 独立路由替代，C1 修订后语义原样）
- `app/api/today/proposals/route.ts`、`app/api/today/ai-changes/route.ts`（被 shell/notes 新 decl 替代）
- handlers.ts 已迁注册残行（T3 已删则核对零残留）

**留下（再确认不误删）：** `app/(app)/coach/`、`app/api/review/weekly`、`app/api/cost/today`、`app/api/today/copilot-summary`。

**Steps:**
- [ ] 删除清单逐一 git rm；全仓 grep 旧路径零残留（含 tests/、注释、postman）
- [ ] step9 不变量审计白名单 repoint（M3 教训）；postman spec 删旧条目 + `pnpm gen:postman`
- [ ] `/` 首页 redirect 已切 `/today`（T6 done）——旧 Next today 页死链核对
- [ ] typecheck + `pnpm test` 全绿 → 单 commit

### Task 8: Review + 全 gate + 视觉环

**Steps:**
- [ ] code-review skill 审全 diff；P1/P2 修复
- [ ] 全 gate（重定向模式逐条）：typecheck / lint（全仓 biome——M3 教训：批量 repoint 后 import 排序漂移）/ audit:schema / audit:partition / audit:profile / `pnpm test` / `pnpm build` / `pnpm rw:web:build`
- [ ] 视觉环：dev 双进程（rw:api + rw:web）+ 种丰富测试数据（多 kind 提议 ≥3 种、agent notes ≥4 条、进行中会话、AI 改动数条）；playwright 截图 /today 与 /inbox 对照 screen-today.jsx / ScreenInbox **先判整体形态**（hero+kpi+双列 dash/分 lane 收件箱）再核元素；用完全家清
- [ ] PR（Closes YUK-319 + Closes YUK-318）→ 双 bot 收敛 → 停等用户 merge

---

## UI design pre-flight（T6 预批材料）

**组件类型声明：** `/today` 与 `/inbox` 均为 **page**（SPA 路由页）；工作台内块组件为 page 内 card/strip 族（非 drawer/modal）；AgentNotesBoard 为可折叠 card。

**设计稿逐字引用：**

1. 工作台布局骨架——`docs/design/loom-refresh/project/screen-today.jsx` L203-241（ScreenToday）：
   > `<LoomHero …/>` → `<div className="kpi-row stagger">` → `<SectionLabel count="3 缕">今日之线</SectionLabel>` + threads-grid → `<SectionLabel>进行中 · 待裁决</SectionLabel>` + `<div className="dash-grid">`（左列 SessionsStrip+AiChangesStrip / 右列 ProposalStrip+CostRibbon）→ `<AgentNotesBoard …/>` → `<SectionLabel>本周编织</SectionLabel>` + WeekHeat 卡。
   > **M4 偏差声明：** CostRibbon 数据源 `/api/cost/today` 属 M5 未迁域（裁决 #10/出范围）——右列以 ProposalStrip 为主，CostRibbon 位置 M4 渲染占位空态（「成本面随 M5 Copilot 收编」quiet-empty 一行），不伪造数据。
2. Hero——screen-today.jsx L29-36：
   > `<div className="eyebrow"><span className="dot-sep">●</span>TODAY · {date} · phase 1c</div>`、`<h1 …>{greet}，{user}。</h1>`、`<p className="page-lead">昨晚 Dreaming agent 跑过；下面是它想让你看的几件事，再加你自己排的复习队列。</p>`、三 CTA `开始今日复习 / 录入 / 打开 Copilot`。
   > **M4 偏差声明：** 「打开 Copilot」M5 才有——按 M2/M3 先例占位 toast；lead 句中 dreaming 是否真跑过以 workbench summary 的最近 dreaming 时间为准（无则改述「夜间编排尚未跑过」），不写死假话。
3. 提议摘要块——screen-today.jsx L127-151（ProposalStrip）：
   > card-head `提议收件箱` + `去裁决` ghost Btn → `prop-summary`：总数大字 + `KIND_META` chips breakdown；空态 `没有待审提议。`
4. AI 改动块——screen-today.jsx L94-125（AiChangesStrip）：
   > `AI 改动 · 近 24h` + badge `可回滚`；行 = `{agent} 改了 {target}` + mono 行 `{ops} ops · {delta} · {ver} · {when}` + 撤销 Btn → 撤销后 `已撤销` Badge。
5. 交班条——`screen-agentnotes.jsx` L89-159（AgentNotesBoard）：
   > 空态「单 faint 行，无 section label 无 card：`暂时没有 AI 间的观察信号。`」；非空 = SectionLabel `AI 观察` + 可折叠 card（`an-head-toggle` + 未读 `{n} 新` Badge + `看全部→/agent-notes`）；展开 feed 前 3 条 + foot `只读旁观 · 过期信号自动消失`；收起 peek 行 `{from} → {to} 提到「{signal}」`。
6. 收件箱——`screen-mistakes.jsx` L128-203（ScreenInbox）：
   > page-head eyebrow `INBOX · AI 提议 · 按科目 / 类型筛选`，lead `每条 AI 提议都带一句白话来源说明，逐条 accept / dismiss。每次裁决写入一条事件，下次不再露面。`；summary card（`{n} 条待裁决` + breakdown + 累计 cost）+ FilterRow 科目/类型；分 kind lane（SectionLabel + grid）；空态双形态（有筛选 → `没有匹配的提议`/清除筛选；无 → `收件箱已清空` + 去看错题本——**M4 偏差：** mistakes 页未迁，CTA 改 `去看知识图`→/knowledge）。
7. 提议卡——screen-mistakes.jsx L60-124（ProposalCard）：
   > head = kind-tag + SubjectTag + `AI · {from}` ai-tag + title + resolved 戳记；body 文案；knowledge_edge 附 edge-preview（rel-pill + a→b chips）、block_merge 附 merge-preview（primary/并入双块 + 连续性 reason）；动作组 edge=[接受/改方向/改关系/忽略]、merge=[接受合并/忽略]、base=[接受/忽略]；foot 置信条（conf-track 百分比）+ cost；EvidenceReadable 白话来源行（`源自「…」的一次答错 / 源自录入《…》/ 源自笔记《…》/ 源自一次 AI 判定` + `查看事件链 →`——**M4 偏差：** /events surface 未迁，链接 M4 指向相关实体页或占位 toast）。

**Touch 文件清单：** 创建 = Task 6 Files 全部（shell/ui 下 ~12 文件）；修改 = `web/src/router.tsx`、各包 manifest 的 `ui.todayBlocks`。样式沿 M2/M3 模式包内 css（shell.css）+ 复用 `src/ui/primitives/*`（Btn/Badge/Card/EmptyState/LoomIcon/MasteryRing）与 design tokens。

---

## Plan-Critic 修订记录（2026-06-11 Cross-统合）

独立 Plan-Critic（opus）裁定 REVISE；Cross-统合全盘接受 C1+M1-M5 与遗漏项，逐条已织入正文：

- **C1（Critical）**：decide 路由不再吞并 retract——retract 是撤销已接受提议的独立生命周期操作（不要求 pending、写 correct 事件、affected_refs 驱动回滚），保留独立路由。裁决 #8、T5、T7 已改。
- **M1**：`src/server/goals/**` 整目录迁 agency（T2），否则 agency 的 handler/applier 反向深 import 旧树。
- **M2**：`goal_scope_dedup.ts` sibling dep 入 T2 move list + sibling 兜底 grep 步骤。
- **M3**：差集三 kind 重框——「有 producer 无 accept-applier」非「无通路」；归属按 producer 域定（archive→knowledge、defer→agency、judge_retraction→practice），对账测试断言归属覆盖、与 applier 存在性解耦；default throw 现状保留（YUK-44）。
- **M4**：T4 加 import 环 invariant + grep gate（appliers 禁止模块作用域引 producers/writer/actions）。
- **M5**：对账断言落 `src/capabilities/composition.unit.test.ts`（import 真实 capabilities 数组的那个），非 kernel 合成测试。
- **遗漏项**：rejudge 补 practice manifest decl（一致性）；fast 档无 DLQ / llm+agent 走 createJobQueue 先建 DLQ；registerMemoryHandlers 与 embedded_check_generate 队列注册渐缩时保活；record_* 豁免 = subtract-from-expected；T4 一包一 commit 强制。
- **维持项**：裁决 #1（agent-notes 并入 agency）、#5（record_* D11 墓碑而非直删）、#7（switch 留壳一行委托——spec line 170 自证生命周期壳中央化）均维持，#7/#8 理由列已补论证。
