# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-09-25：sweep-4/5 派生 follow-up 批清完——1031/1032/1034/1035/1036 五 merge，1033 owner 裁决暂缓（等 1007 面板）；审计与评审派生 YUK-1037（verify-enroll 合成根 FSRS 卡 bug）/1038（生成链 reference pair 缺口）。本批未部署，生产仍为 `c89079b68`。另：YUK-1038 owner 认可五层模型方向、裁决全量迁移/任意题目/一次切换（拒绝 LIGHT 分批）；source-only implementation grounding 已落盘 `docs/planning/2026-09-24-question-assessment-implementation-grounding.md`；**D1–D19 已全部批准**，D12 Jev smoke 与 D19 只读 census 已完成；**Q20 UI preflight 与 Q21 ticket 拆分 2026-09-25 已批准**——已建 17 张依赖票 **YUK-1043–1059**（parent=YUK-1038，`ready-for-agent`，blockedBy 已落）；仅剩 ~~final implementation-ready confirmation~~ **已批准（2026-09-25）**，实施 lane 已启动（final implementation-ready confirmation 2026-09-25）：**YUK-1046 契约基座 merged** `c663147c5`（#1465）；**YUK-1044 schema merged** `93e787df6`（#1466，9 表+migrations 0104–0107+备份锁步+restore GUC 通道）；**YUK-1048 捕获/分类 merged** `76e50121b`（#1467）。**YUK-1045** 激活契约 merged `aec2aa404`（#1472，oracle 6 P1 全修+`activateEvaluation`+releaseIssuanceClaim）；**YUK-1047** 判分收敛 merged `1337dfa8f`（#1471，evaluateSubmission 纯内核+8 入口漏斗）；**YUK-1041** 日级 dump merged `f9df47739`（#1473，TCC 外卷 I/O 根因）；**YUK-1055** 启动 fences merged `ad2109057`（#1474，epoch guard+job 分类+订阅翻译+CLI；修 postgres-js timestamptz→string 返回 + handlers.test fence wrapper 断言）；**1042** DLQ census merged `feffcd8c2`（#1470）。**批量 triage**（imp-25）落盘 `docs/triage/2026-09-25/`：18 票全 grounding，labels+评论已应用，拆票 YUK-1082/1083/1084 已建，owner 问题集 questions.md（8 组）。**新一批 5 lane 已并行启动**（各独立 worktree/branch，implementer×4+designer×1）：**1049** Jev typed 执行器 `tlp-wt-yuk1049-jev-typed-executor`；**1051** 作答面 UI 组件族 `tlp-wt-yuk1051-response-ui`（designer）；**1052** 提交持久化 `tlp-wt-yuk1052-submission-persistence`；**1053** 学习结算 `tlp-wt-yuk1053-settlement`；**1056** 备份/导出/常量 `tlp-wt-yuk1056-activation-read`。下一批等 merge 解锁：1054←1053、1057←1055+1056、1058←1057+1047、1059←1058。

## NOW

- 09-24 **YUK-1038 题目契约迁移 grounding + 裁决收口**：realworld 调研 + 独立复核已归并；owner 认可模型方向，明确**全量迁移、任意题目、统一切换，不分批上线**（旧 LIGHT/LIGHT-1 推荐已被取代，保留为决策历史）。grounding 落盘 `docs/planning/2026-09-24-question-assessment-implementation-grounding.md`（§1–§19）；**D1–D19 已全部批准**（`docs/planning/2026-09-24-question-assessment-decisions.md`）。**D12 Jev smoke 已 FINAL**：2/2 paid calls、无 retries、**$0.00003024**（wire/auth/cost only，无 accuracy）。**D19 只读 census 已完成**（REPEATABLE READ READ ONLY、无写入）：**114 questions / 0 physical parts / 0 answers rows / 9 judge events**；pgboss outstanding 27 全为 DLQ recovery。**作答面 UI preflight 已批准**（`docs/design/2026-09-24-assessment-ui-preflight.md`，Q20 2026-09-25 批准）；**Q21 ticket 拆分已批准**——17 张依赖票 **YUK-1043–1059** 已建（blockedBy 按 §17 DAG；YUK-1055 关联 YUK-766，YUK-1049 关联 YUK-438，YUK-1056 关联 YUK-1041/1042）。之后 **final implementation-ready confirmation 仍待 owner**。两个 operational finding 已捕获：**YUK-1041**（daily backup STALE，`loom-daily-20260913.dump`，09-13 后无成功，launchd 疑似停止）与 **YUK-1042**（pgboss 27 DLQ backlog，切换前需处置策略）。provider 偏好 **OpenRouter**（公开文档已核验）；**D18 ≤$5 独立评测预算已批准但未运行**。**无业务实施、schema/数据迁移或部署**；YUK-310 独立交付仍待 review，不混入本线。
- 09-24 **follow-up 清批 5 merge + 1 暂缓**（sweep-4/5 派生票清零）：
  - **YUK-1031** #1455 `b6ef28643`：dependabot `typescript`+`@typescript/native` semver-major ignore——alias 结构保证的 stale-base major PR 噪声根除，minor/patch 轨不动。
  - **YUK-1032** #1456 `a31ce98a0`：历史题绑定只读审计（Mac 生产库，BEGIN READ ONLY）→ `docs/audit/2026-09-24-question-binding-audit.md`。结论：4 道 seed-root 绑题（jyeoo 09-14 批）+ 3 道空绑（intervention_diagnostic 设计内契约）；**抓到活 bug**：verify-enroll 对 `seed:*:root` 建 FSRS 卡（`material_fsrs_state('knowledge','seed:math:root')` 到期卡已在产），题可经 due/stream 服务但 `?subject=math` 不可见 → 派生 **YUK-1037**；处置建议 4 条待 owner 批。
  - **YUK-1034** #1459 `08c1f9135`：`item_prior_backfill` feature 路径 opt-in `reps` median 聚合（默认 1 不变，`MAX_REPS=9`）；270-call 复测 median SD 0.361→0.173、Spearman 无损；证据 `docs/planning/2026-09-24-item-prior-reps-eval.md`。生产启用 `reps:3`（+$0.0004/题）待 owner 拍。
  - **YUK-1035** #1457 `20d5e7791`：detail family/parts 投影补 `parent_question_id`，UI 层 `kind === 'question_part'` 判定清零。
  - **YUK-1036** #1460 `84f67271a`：unit_dimension 路由改判 judge 输入契约（`metadata` 携带 `reference_value:number + reference_unit:string` pair）+ 老标签祖父化兜底——owner 拍的派生信号方案；写路径 parity 钉死；Codex P1（生成链产不出 pair，既有 producer 缺口）派生 **YUK-1038**。
  - **YUK-1033** 暂缓（owner 裁决）：学段纠正入口等 YUK-1007 配置面板一并做，届时裁决粗档 vs 年级细分。
- 09-23 **sweep-4/5 七 merge**（Linear 均 Done，exact-head CI Gate 全绿后 squash）：
  - **Astra 链**：spec 落盘 #1447 `47dd353f9` → **YUK-1027 P1** #1451 `de83dce59`（`openai/gpt-6-astra` 经 pi builtin catalog + `openai-responses` driver 接通 `/v1/responses`；15 个契约测试钉 wire 行为——effort 五档/272k 费率边界/call_id 往返/abort；MiMo→Astra→MiMo durable session 切换 DB 测试；`x-opencode-session` 收窄至 opencode-go 防泄漏）。**YUK-1028 P2 owner 叫停回 Backlog**（零产出，重启基线=main）；YUK-1029 仍 `needs-info`。
  - **YUK-1030** #1449 `6c339ac9d`：`docs/architecture/ai-pipeline.md`/`.dot`/README 对齐 pi 现实（TaskSpec 分布修正、provider lane 清单、Tavily→Exa、`cost_ledger` 表名）；从 42e9a5a3d 恢复缺失设计稿 `docs/design/2026-09-18-pi-agent-execution-adapter.md` + 调研底稿（994 fixture 打捞时漏合）。
  - **YUK-1009** #1450 `d9f1d3530`：`goal.declared_stage` nullable enum 持久化（migration 0103，event-sourced 三面同步）+ Jyeoo 供给消费（高中→grade 11；非高中 `skipped:'jyeoo_declared_stage_out_of_band'` fail-closed；不进 θ̂）；「纠正学段→下一次供给翻转」DB 测试钉住；派生 YUK-1032（历史绑定只读审计）/ YUK-1033（学段纠正用户入口，挂 1007 面板）。
  - **YUK-910** #1448 `ecb86479a`：TS7 评估——main 已跑 `@typescript/native` tsc@7.0.2（`typescript` 包走 typescript6 线保 JS API），决策=已上无变更，dependabot #1232 为 stale-base 噪声；派生 YUK-1031（typescript 家族 ignore/cooldown）。
  - **YUK-376** #1452 `05f3841c0`：LLaSA opt-in 变体（`ItemPriorLlasaTask`，catalog 51→52）+ 180-call actual-output 评测——**负结论**：噪声 2.2×、排序效度 0.23 vs 0.58、失败率 7.8%、单次成本 5.8×，采纳门槛未满足，默认 feature→b 不变；证据封存 `docs/planning/2026-09-23-llasa-prior-eval.md` + evidence JSON；派生 YUK-1034（feature→b rep-median 降噪）。
  - **YUK-386** #1453 `15e2ed89a`：kind 轴收尾刀——`question.kind` 闭集退役为展示自由字符串（schema 层 z.enum 拆除），行为分支全走 answer_class/结构信号/`parent_question_id`；Step1 sentinel 残留清零（`kind='question_part'` 不再有 branch-authority 读）；`question-kind.ts` 映射层、`SubjectQuestionKind` 词表、`CANONICAL_QUESTION_KINDS` prompt 闭集全部收编；派生 YUK-1035（detail 页 family 投影回退）/ YUK-1036（unit_dimension kind 字面量判定，owner 决策）。
  - 顺手修复：`runner.ts` runTask 注释「Claude Agent SDK」→ExecutionAdapter（YUK-1025 后 stale）；agency `AGENTS.md` copilot tools 计数 5→8。
  - 部署状态：生产仍 `c89079b68`；本批 7 merge + sweep-3 未部署批待下次部署。
- 09-18~21 **YUK-921 多 provider 执行适配器迁移 P0–P4 全交付 → epic Done**：设计稿 `docs/design/2026-09-18-pi-agent-execution-adapter.md`；`PiAgentAdapter`（pi-ai/pi-agent-core，opencode-go 通道 openai-completions）承接全部执行面——P0 seam #1424 `a6d0b1a8e` / P1 单发 #1428 `d8213a7c6` / P2 工具循环 #1431 `4ef86f8a1` / P3 copilot+嵌套子代理+compaction+piHooks 桥 #1432 `e2bbf80c7`（session 改 durable-turns 本地回放、`pi:` cursor 复用 `agent_sdk_session_id` 槽、nativeCompaction→transformContext、steering/follow-up ctx 面接线零消费方）/ **P4 SDK 退役 #1435 `26b7545d9`（YUK-1025）**：`@anthropic-ai/claude-agent-sdk` 依赖+Dockerfile `sdkdeps`+runtime-preflight+SDK Options 字段面（mcpServers/canUseTool/outputFormat/maxBudgetUsd/env 灰度 pin）全退，`sdk-types.ts` 剪为 pi 归一化帧词表，测试基建迁 `__setPiAdapterForTests`+piCustomTool 面，lint baseline 锁 306。actual-output 证据封存 opencode-go/deepseek-v4-pro 双 durable turn。灰度 env pin 面已随 P4 删除——provider/model pin 走 `modelBinding` 参数。
- 09-18~19 **YUK-454 错因 epic 全票清 → Done**：454-A #1425 / 454-B overlay 词表层 #1426 / 454-C flag 裁决 #1427（promote 开待 recreate、hard-confirm OFF、recurrence NO-GO 证据不足）/ 跟进 #1429 #1430。遗留 YUK-1020（secondary misc 显示）Backlog 可独立排期。
- 09-21 **YUK-1023 CI DB lane 提速** merge #1433 `9692b5396`：LPT 时长分桶（committed baseline `scripts/ci/db-test-durations.json` + median 兜底）替代 vitest count-mod `--shard`；DB matrix 2→4；顶层 `scripts/*.json` 归 audit-tooling 不再误触全量；本 PR 自身 full lane 验收 **24min→5m13s（4.6×）**。回流刷新 follow-up = YUK-1024（Backlog）。
- 09-21 Linear 产品票 sweep：YUK-921 标题校准+P4 补票、YUK-454→Done、YUK-346/856 grounding 更新（pi lane 落地后前提变化）；Triage/Todo/In Review 全空，Backlog 50 票 census 无其它状态漂移。
- 09-17 sweep-3 六票全 merge（Linear 均 Done，exact-head CI Gate 全绿后 squash）：
  - **YUK-1005+1008** #1418 `d5f7c0bf4`：MathJye HTML/sprite→LaTeX 转换器 + `insertSourcedDraft` 单缝清洗（prompt/choices/reference 三面+留痕）；作答面 PfSolo/PfPaper/PfRetro/HintLadder 全接 MathMarkdown+`notation` 投影；learning-intent 3a 新根挂 `seed:<domain>:root`。生产修复走正道：`概率论基础` genesis-reanchor（修 event-less retag 造成的 fold/live drift）→reparent accept 挂 `seed:math:root`；2 条 MathJye 脏题 backfill 清洗全表 0 残留。
  - **YUK-1010** #1419 `7812f0f09`：生产处置 merge 条件概率 dup + reparent 2 混写节点 + archive 3 canary 子图（含 6 draft+2 mastery）；`kc_dedup_nightly` `recent_auto` 窗口扩至 propose_new/split 铸造路径，窗口键改 `materialized_id_index.created_at`（mint 时间，OCR 修正——pending>7d 再 accept 不再漏扫）。
  - **YUK-1002** #1420 `b89c93077`：write_quiz 关闭 archive↔/retract↔ 同型竞态——artifact tx 内 proposal decision advisory locks（hashtextextended，sorted）→inbox pending 重折叠→全量 question 行 FOR UPDATE→tombstone/uncovered 重检，与 dismiss/accept 同锁序；3 个真实并发回归（含 retractAiProposal）。
  - **YUK-287** #1421 `744c5b2076`：`QuestionSupplyTarget.difficultyBand` 端到端穿透 dispatcher→supply_execute/quiz_gen payload→`requested_difficulty_band` 软目标；jyeoo 侧真消费 `difficultyInBand` post-filter；band→难度映射对齐 canonical（below→1-2/near→3/above→4/stretch→5）。`composite_parent_only` 数据缝已备好、生成 phase-deferred（记录于票内）。
  - **YUK-1006** #1422 `0b3ea39b3`：`getTaskSystemPrompt` 唯一漏斗统一追加 `LEARNER_LOCALE_PIN`（50 task 全覆盖，用户可见文本一律简中，JSON/枚举/代码/LaTeX 除外）；双 oracle 正道重生（gen:prompt-hashes + audit:judge-prompts --write）。per-user locale 属 YUK-1007 范围。
  - 部署状态：生产仍 `c89079b68`；本批 6 merge 待下次部署批次。
- 09-17 生产部署 `c89079b68`（sweep-2 全批 13 merge 上线：费用来源/图题/阈值/quiz 强化/judge 契约+路由诚实化/dismiss 竞态/spawn 超时/remote evidence basis/DegradeBanner/设计回写）。OrbStack 构建网络 flake → `--build-arg HTTP_PROXY=proxy.orb.internal:8305` 解法存档。回滚备份 `runtime-sweep2-image.override.yml.rollback-d9ca89e5`。
- 09-17 placement e2e 真实 UI 验收全通（YUK-571 Done）：goal 创建→placement/start→8/8 题作答→θ̂/mastery 落库→/profile 起始档案非空。截图 `/tmp/placement-e2e/`。中途抓出两缺陷即修：YUK-1003 exact 判分「（C）选项+解析」reference 盲区（#1415，`extractAnswerHead` 裸答案头提取 + 全半角括号 choice 前缀 + `isExactCapableReference` 写路径 demote 守卫 + sourcing prompt 契约 + oracle 重生）；YUK-1004 `general` 兜底身份写成 knowledge.domain（#1416，根因=prompt 把 `profile.id` 注进 domain 示例；四层修复：prompt→valid_domains 契约、plan `resolveSelectableSubjectId`/`sanitizeProposedNodeDomain` 归一、accept 同谓词、写缝 alias canonicalise + 'general' 硬拒）。
- 09-17 新立 Linear：YUK-1005/YUK-1006 已于 sweep-3 Done（见上）；YUK-1007（统一配置面板：per-task 模型/系统偏好/语言，P4，owner 需求）、YUK-1009（学习者画像）、YUK-1010 处置后残留 dedup 嵌入空窗说明已记票内。

- 09-16 Linear sweep 第二批 8 lane 并行 Done：542 landing DegradeBanner（#1406，持久化 session warnings 落 A8 落地卡）；831 opencode advisories（#1408，bun 子树 scoped override @babel/core→7.29.7，audit 清零，SECURITY.md 可达性证据+复查 2026-10-28）；374 judge routes 诚实化（#1409，FUTURE→UNIMPLEMENTED_JUDGE_ROUTES，rubric/ai_flexible 无 runner 实证 fail-closed；顺手删除已达成 resolves_when 的 4 条 material_fsrs_state allowlist）；998 spawn 超时按 caller 拆分（#1410，in-band 120s 反卡死保留，backfill 三层回退 max×90s）；996 judge 契约走 subjectProfile 实际路由（#1411，修复双向误拒/误放）；340 设计回写（#1412，设计源+globals.css 351 处 <13px→var(--fs-caption)=14px；手稿体/info-line 已由 #1284/#1293 落地，本 PR 验证收口）；995 write_quiz↔dismiss 竞态（#1413，artifact tx 内 sorted FOR UPDATE 重读 tombstone）；993 remote evidence basis（#1407，executed_remote_evidence→判官词表+schema enum+gate 条件 remote_tool_evidence 非空且≥1 条带 output，pool 侧 fail-closed by non-consumption 审计）。
- 09-16 过程事件：7 个 lane agent 曾被 connection error 批量杀掉，993/374 残留 diff 经审查续作成功，其余重发；GitHub 一度丢 #1407 的 pull_request 事件（空 commit retrigger 恢复）；main 上 material_fsrs_state allowlist 09-15 到期曾致全分支 CI 红——已由 #1409 删除条目（写路径 src/server/fsrs/state.ts 实证存在，非续期）。
- 09-15~16 部署前运维：YUK-571 placement flag 核实已 live（.env.local + docker-compose.mac.yml app/worker 均 PLACEMENT_PROBE_ENABLED=true，自 07-06 持久化）；day-zero census 存档（event=778/answer=0/question=72/KC=12/mastery=2/placement_starter_attempt=0）；POST /api/placement/start 显式 knowledgeIds 实测开 session 服务题（sourcingNeeded=false）；探测 session 已 abandoned。剩 owner 真实跑一次完整会话（作答→θ̂→mastery→/profile）方可关票。QUESTION_SUPPLY_REFILL_ENABLED / MISCONCEPTION_PROMOTE_ENABLED 未动。
- 09-16 follow-up 已立 Linear：YUK-1000（tsx 层 ~30+ 处 <13px 散件字号）、YUK-999（matcher live caller 后 axis C 复测，条件触发）。YUK-1002 已于 sweep-3 Done（#1420）。YUK-1001 立后复核前提过时已 Canceled（FSRS writer 早已落地）。
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

- YUK-1045 初审遗留（非阻塞待归票）：claim 冲突路由未翻译 409 `claim_conflict`（question-restore.ts:49–55，当前 500/泛 conflict）；source_verify 对 part 走 child→root 锁序，与 publisher root→child 反向可能死锁（source_verify.ts:699–717）；1043 lane 已知缺口 `publishQuestionGroup` 不调 `validateStructure`（material_id 重复不被拦）。
- 两处judge直调已核实为照片作答/独立解答一致性，不为调用形式统一机械删除，无新缺陷证据。
- 全历史ADR审计仍未完成，不冒充全量通过；971仅覆盖三份已确认冲突的现役指引。
- 951按ADR0063明确保留历史表/native投影及live remote ToolOperations；不是待做通用表名合并。
- 921多provider、572夜间教研、832HOLD不解锁。
- Astra P2/P3 叫停：YUK-1028 回 Backlog（重启基线=main，`attempt-cost.ts` 已有 openai→estimated 归因初版）、YUK-1029 needs-info 等 owner 拍 LIGHT/FULL scope + actual-output 预算。
- 计费、重试、prompt/skill、复杂parser、并发/回滚/恢复、UI安全测试仍保留，不按数量硬删。

## BLOCKED-ON

- Mac本地生产已授权直接操作；NAS部署/数据操作仍未授权，不执行。
- 09-09新$10已明确授权；逐wire先预留再调用，未知费用不回收，禁止批量重烧旧failed/DLQ。
- 原始the-learning-project脏main始终不动；实施使用独立工作树。
