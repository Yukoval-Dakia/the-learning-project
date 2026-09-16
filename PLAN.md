# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-16：Linear sweep 第二批 8 lane 全部收口（PR #1406–#1413 → main 0406f1605，各 exact-head CI Gate 绿；YUK-997 为外部仓 jyeoo-rs git init 无本仓 PR）。09-06~09-08 时代 NOW 交付记录已滚存 `.remember/plan-now-archive-2026-09-16.md`。

## NOW

- 09-16 Linear sweep 第二批 8 lane 并行 Done：542 landing DegradeBanner（#1406，持久化 session warnings 落 A8 落地卡）；831 opencode advisories（#1408，bun 子树 scoped override @babel/core→7.29.7，audit 清零，SECURITY.md 可达性证据+复查 2026-10-28）；374 judge routes 诚实化（#1409，FUTURE→UNIMPLEMENTED_JUDGE_ROUTES，rubric/ai_flexible 无 runner 实证 fail-closed；顺手删除已达成 resolves_when 的 4 条 material_fsrs_state allowlist）；998 spawn 超时按 caller 拆分（#1410，in-band 120s 反卡死保留，backfill 三层回退 max×90s）；996 judge 契约走 subjectProfile 实际路由（#1411，修复双向误拒/误放）；340 设计回写（#1412，设计源+globals.css 351 处 <13px→var(--fs-caption)=14px；手稿体/info-line 已由 #1284/#1293 落地，本 PR 验证收口）；995 write_quiz↔dismiss 竞态（#1413，artifact tx 内 sorted FOR UPDATE 重读 tombstone）；993 remote evidence basis（#1407，executed_remote_evidence→判官词表+schema enum+gate 条件 remote_tool_evidence 非空且≥1 条带 output，pool 侧 fail-closed by non-consumption 审计）。
- 09-16 过程事件：7 个 lane agent 曾被 connection error 批量杀掉，993/374 残留 diff 经审查续作成功，其余重发；GitHub 一度丢 #1407 的 pull_request 事件（空 commit retrigger 恢复）；main 上 material_fsrs_state allowlist 09-15 到期曾致全分支 CI 红——已由 #1409 删除条目（写路径 src/server/fsrs/state.ts 实证存在，非续期）。
- 09-15~16 部署前运维：YUK-571 placement flag 核实已 live（.env.local + docker-compose.mac.yml app/worker 均 PLACEMENT_PROBE_ENABLED=true，自 07-06 持久化）；day-zero census 存档（event=778/answer=0/question=72/KC=12/mastery=2/placement_starter_attempt=0）；POST /api/placement/start 显式 knowledgeIds 实测开 session 服务题（sourcingNeeded=false）；探测 session 已 abandoned。剩 owner 真实跑一次完整会话（作答→θ̂→mastery→/profile）方可关票。QUESTION_SUPPLY_REFILL_ENABLED / MISCONCEPTION_PROMOTE_ENABLED 未动。
- 09-16 follow-up 已立 Linear：YUK-1000（tsx 层 ~30+ 处 <13px 散件字号）、YUK-1002（write_quiz 同型竞态残留 archive↔/retract↔ 窗口）、YUK-999（matcher live caller 后 axis C 复测，条件触发）。YUK-1001 立后复核前提过时已 Canceled（FSRS writer 早已落地）。
- 09-14 Linear sweep 5 lane 并行 Done：977 零金额费用来源（#1400，各聚合粒度 reported/estimated_attempts 计数驱动展示，不凭金额推断，四验收用例 unit+db+浏览器钉住）；990 图题 commit 覆盖（#1401，4 db 测试钉重写/override/清理/竞态）；677 阈值重锚轻量案（#1402，YUK-396 孤儿引用→677，report-only 标定脚本 + docs/audit/2026-09-14-threshold-calibration.md，三阈值维持有依据，语料薄已标注；Codex 初审抓 2 P1 已修）；989 jyeoo-rs extract 全文 echo（producer 侧 loom.rs 修复，同题重抓 overlap 0.49→pass→active，本仓零 diff 无 PR）；308 quiz C→A 强化（#1403，draft 窄放行/dismiss tombstone+0101 backfill/契约校验/幂等守卫，query_questions 限流 wontfix；review 派生 YUK-995/996）。生产未部署仍 d9ca89e5；复验在共享 DB 落 4 条真实题（3 active+1 needs_review）；follow-up 三条登记中（Linear MCP 暂不可达，恢复后立票）：jyeoo-rs 版本化、JYEOO_SPAWN_TIMEOUT_MS 偏小、matcher live caller 后 axis C 复测。OCR runner upload-artifact 连续超时属 infra flake（advisory 不阻塞）。
- 994 Done（skill-fixture 打捞）：fixture base commit 卷入的真实工作全部落 main 2995dacdf。launch-phase 双镜像改 per-lane PR + exact-head CI Gate 编排、lane 状态机、merge-not-rebase 冲突策略；新增 delivery:evidence/delivery:note 收尾自动化（只读采集 git/CI/compose/API/DB/cron/migration/golden，本机实测 29 探针，env schema 补 DELIVERY_*）；docs/architecture AI pipeline 文档 + now.md 09-13 handoff 落盘；工具痕迹独立 commit 可摘。fixture 壳（.txt/VALIDATION）与 8-27 垃圾文件留在原分支，本地 main 仍落后——实施继续用 worktree。
- 837 Done（remote-MCP 执行证据进最终审阅）：PR #1395 squash → main d9ca89e5（exact-head CI 34762817056、main CI Gate 34764012413、Oracle gate PASS、真实 Exa 挂载实证 693 PostToolUse + 2 失败并固化 fixture）。finalization hooks 采集 remote-MCP tool_input/tool_response/failure：tool_use_id 去重、parent+copilot-researcher、排除 Loom；单次 64K/整轮 256K 有界，超限或采集异常 final review fail-closed（不静默截断），raw 不进 digest/receipt；判官输入 remote_tool_evidence（仅本轮、无历史）。Codex P1（admission basis）→ YUK-993（Backlog，ready-for-human）；OCR 4 条低置信复核为非阻塞并 resolve。
- 09-13 生产部署（980+837 同批）：镜像 the-learning-project-app:d9ca89e5（构建树与 commit 树 diff 空；镜像内两票标记已核）→ migrate exit 0（drizzle 无新增、legacy drain clear、traits 24 up-to-date、七实体 projection 零漂移）→ app/worker healthy、health200、未认证401、pgboss 29 条 cron 在位（supply_planner 50 5 / jyeoo reaper 40 3）。回滚：旧镜像 67d43df12 保留 + override 备份 runtime-988-image.override.yml.rollback-67d43df12。
- 980 Done（补验收 PR #1393，非仅 C1 原修复）：使用已发布 running boss，协调启动尾段与单一退出 owner；旧 wiring 两个中途停机场景 RED，最终 scoped 22 tests + lead 真实 SIGTERM QA 19/19。详见 docs/planning/2026-09-13-yuk980-startup-tail-verification.md；9s+30s 为预算，pool-close 卡死的硬截止不在已证明范围；09-13 已随 d9ca89e5 批次部署。
- 09-13 QoL C1 历史部署：PR #1391（67d43df12）。935 actions node24；187 dismiss 冷却14天；920 tool_finished SSE 带 tool_use_id。980 的部分注册窗口遗漏由 #1393 补齐，不能用原 C1 unit 通过替代验收。
- 清零复核续：837 已恢复并交付（见上，Done）；550 已恢复 Backlog（09-14 owner 裁决，P4 不排期；描述补 09-13 复核→09-14 恢复口径）。203/764 的关闭记录保留。
- 09-13 QoL C0 Done：992 日级 dump（launchd 07:15，14 日+月档保留，恢复演练 pg_restore 零错 42 题）+ verify raw head / quiz:reverify / gen:prompt-hashes / flags strict。生产 e1750de6b 健康。stranded draft jo3 重派 → pass+promoted（19 题 = 8 active + 10 人审）。
- 09-13 Exa 换装 Done：web 检索后端 Tavily→Exa（PR #1384，main 776a687d3，Mac 生产健康）。live-probed 挂载（web_search_exa/web_fetch_exa，x-api-key header），闸/消费面/schema/prompt/oracle 全面更名，旧 tavily 值保 parse。
- 09-13 首夜实证：planner 05:50 accepted 7 项（rationale 引用真实库存证据）→ executor（sourcing_web 跳 tavily_unavailable→quiz_gen fallback）→ quiz_gen 7/7 → 19 题 = 7 active + 12 draft（10 题数学全对仅 copy_safety=unknown 待 /drafts 人审；3 题判官输出解析失败留 draft 可重派）。

- 988 Done：供给执行面统一入 main 07df98a84（PR1381 exact CI 全绿；Oracle 初 FAIL 六 P1 → 修复批 → 验证审 PASS；migrate 热修 PR1382）。
  web-candidates 核（SourcingTask 收敛为工具内 LLM）+ web_fetch_candidates DomainTool + plan-executor 纯确定性路由派发 + supply_execute job（agent 队）+ pnpm supply:execute 手动 caller。
  路由：jyeoo/web 共 store_sourced_question 单 seam（source_route 参数化）；quiz_gen 派发现有 job；author/ingest/image_candidate 落 manual。dispatcher sourcing_web 重指向 supply_execute；supply_planner 门后第二阶段当晚执行；sourcing 单体 job 退休。
  六 P1 修复：逐 item executor_item 事件 + plan_event_id 幂等 + quiz_gen singletonKey 断点续跑；placementTrace + cloneSupplyTraceForRoute 按路由覆写；canary 下移核（executor 路径照计预算）；runWebRoute try/catch 续走；rejections 逐项留痕；phase-2 enqueue 重试 + 持久 failure 事件。
  部署热修教训：barrel 边（public.ts→plan-executor→…→Agent SDK）把 SDK 拉进 build:migrate 的 cjs bundle 崩 migrate 容器（server/worker 标 external 免疫）；修复=barrel 摘导出 + build:migrate 补 external。规矩：capability barrel 新增导出先查 SDK 链入 migrate bundle。
  Mac 生产 07df98a84：migrate exit 0 零漂移（traits 24 up-to-date），app/worker healthy，health200，pgboss supply_planner(50 5)+jyeoo_staged_asset_reap(40 3) 注册。
  985 epic 三片（986/987/988）全 Done，epic 关闭。未结 follow-up：989（producer extract 全文 echo）/990（图片覆盖）/992（日级自动 dump）。

- 987 Done：供给需求层 planner agent 入 main 454458ccd（PR1379 exact-head CI 全绿 / Oracle gate PASS 无 P0/P1）。
  SupplyPlanV1 schema + 纯机器门（活KC/词表/去重/预算声明≤剩余/空计划合法，镜像 quiz_gen_plan 范式）+ supply_planner cron 05:50 CST（llm 队；与 supply DAG 无硬边——扫描器安全网不被拖死）。
  accepted→run+demand(manual 留痕，E3 未落地)+shadow(planner vs scanner KC 集合同窗口对比) 三事件；拒 fail closed 零派发不烧 DLQ。
  census/deepening/catalog/prompt-hash oracle/边界基线钉值同步（49→50 tasks；practice→ai +2=runner/mcp-bridge 同型引用）；
  P2 幂等护栏（per-night 事件 id）已登记 YUK-988 约束。Mac 生产同 SHA：migrate 零漂移、app/worker healthy、health200、pgboss supply_planner cron 已注册。
  985 epic 续：988 executor palette 统一（sourcing_web/生成/jyeoo 共 commit seam）。

- 09-12 事故+恢复：OrbStack VM 崩溃（主机盘100%→vdb写失败）清空 docker 存储含生产 pgdata；
  从 loom-before-984.dump(09-08 21:40) 恢复+migrate重放，栈已在 75a1de01d 健康（app/worker/postgres healthy，health200，reaper cron已注册）；
  损失窗口≈4天（984后用户事件）；防复发：日级自动dump=YUK-992，build前盘空间闸/registry mirror 已存记忆。

- 986/991 Done：供题线复工第一刀——jyeoo agent-tool 化入 main 0ac945d2c（PR1373 exact5e26fb5d5/CI全绿/Oracle gate PASS含P1批）。
  jyeoo_fetch_candidates(read) + store_sourced_question(write，单 commit seam：活KC校验→hash合并→近重→draft→verify outbox) + 事件溯源日预算40/日 + staged-asset reaper cron + pnpm jyeoo:backfill 手动 caller。
  旧 jyeoo_fetch queue 路线全退（flag从未上线，零双轨）；jyeooSupply trait 声明退休（seeds v1.1→1.2 擦除升级）；行为测试全量移植 tool seam（vip行级闸/图片身份/出口分类）。
  实测 QA：dry-run 2候选0插入、JYEOO_DAILY_FETCH_BUDGET=0 短路、live 插入1题 coarse 归因科根+verify链事件齐；
  source_verify 对 jyeoo 题正确 fail-closed（extract 为锚点非全文→overlap0.13<0.15 拦 draft）——producer 修复票 YUK-989，P2 图片覆盖票 YUK-990。
  991 阻断清除：main CI 自 09-09 RED 于 audit:dependencies（sharp libheif + tiptap ReDoS 2 high），升 0.35.4/3.31.3 清零，PR1374 合并 main cb1c4b788。
  985 epic 续：987 planner agent + typed demand gate；988 executor palette 统一（web/生成共 commit seam）。

## NEXT

1. 951 Done：ADR0063已集成；887 canonical提案HTTP401/201/200和accept/retract零drift复验过，无paid。
2. 887命名矩阵已补Copilot真实响应后强杀/Stop/同job重投：唯一ambiguous_execution终态，1wire；原cancelled-only验收断言失败保留，另只读复核PASS。
   新$10reserve6.70/余3.30，unknown不回收；原AI日志待既有1h/boot/nightly清理器，非立即结算。977/980/982保持P2。
3. 录入完成/判分完成/知识合并三责任已独立复核；下一最终证据review/文档exact-head CI集成，不重烧通过样本、不以检查数量冒充业务封装。

## PARKED

- 两处judge直调已核实为照片作答/独立解答一致性，不为调用形式统一机械删除，无新缺陷证据。
- 全历史ADR审计仍未完成，不冒充全量通过；971仅覆盖三份已确认冲突的现役指引。
- 951按ADR0063明确保留历史表/native投影及live remote ToolOperations；不是待做通用表名合并。
- 921多provider、572夜间教研、832HOLD不解锁。
- 计费、重试、prompt/skill、复杂parser、并发/回滚/恢复、UI安全测试仍保留，不按数量硬删。

## BLOCKED-ON

- Mac本地生产已授权直接操作；NAS部署/数据操作仍未授权，不执行。
- 09-09新$10已明确授权；逐wire先预留再调用，未知费用不回收，禁止批量重烧旧failed/DLQ。
- 原始the-learning-project脏main始终不动；实施使用独立工作树。
