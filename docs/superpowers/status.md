# Project Status — 滚动总览

> 长期文档，区别于一次性 `RESUME.md`。
> 这里记的是 **项目走到了哪、下一站去哪、为什么这么走**，不是 commit log。
> 维护规则：每完成一个 Phase 就 update 一次；不维护周度进度。

**🎉 v1 closeout — scenario A 达成（2026-05-29）**：YUK-88 block-tree note 全栈 **P0-P7** + Layer 8 critical path（Drawer/Coach/tool_use promote）+ Living Note v0 + cross_link/反链/hub auto-sync + cytoscape 诊断图谱 全 ship。8 波 + Foundation A/B/C/D + Product Track 1/2 闭环。详见 [`audits/2026-05-29-v1-closeout.md`](audits/2026-05-29-v1-closeout.md)；v1 之后去向 [`../planning/v0.5-maintenance-roadmap.md`](../planning/v0.5-maintenance-roadmap.md)。

**最后更新**：2026-06-05（**U 序列 drive 进行中**：U0-U5 落 main，见下方「U 序列 drive」；本条随 U5 post-merge 落地）；2026-06-01（**数据激活 drive ✅ DONE**：Station 1 合成数据 + 2A brief writer + 2B goal cron + 3 端到端验证（8 slice 全绿，零集成 bug）→ Layer-8 端到端可观测；详见上方「数据激活 drive ✅」+ closeout。下一站 Strategy D 真实 ingestion，开工前 surface 用户。）；2026-05-31（**P5 open-questions chain ✅ 全 7 阶段 merge → origin `82ba1df1`**；详见「P5 chain ✅」+ closeout。）；2026-05-30（**Wave 7 ✅ → origin `28dd48d6`**（P5 反链/cross_link/hub auto-sync YUK-95 + T-KG cytoscape 诊断图谱 YUK-142 + fix-pass + closeout）；**Wave 8 ✅ 实现完成**（末波 = P6 read-view+节点页 YUK-96 + P7 tests YUK-97 + P2-polish slash/drag-drop YUK-150 + 两轮用户 review-fix + T-PD 收尾 + v1 closeout，全 7 lane 各独立 opus reviewer + 完整 wave-gate 绿：145 test files / 1153 tests + 1 todo / migration 11 / build 55 pages），**Wave 8 已 merge 到 main**（2026-05-29，PR #193 rebase-merge，保留 per-commit Closes），其上叠了 scenario B 第一批。上一波 Wave 6 `a419b2e6`。）
**当前 Phase**：**YUK-203 U 序列 drive（2026-06-04 起，用户授权全自主）** —— 三份 codex 设计（coach review engine v2 / profile studio / agent framework）经 29-agent 可行性审计 + U0 grill 裁决（D1-D11，ADR-0029）后按统一序列落地。**U0-U5 ✅**，U6（三 chat 合并）→ U7（Studio MVP）排队（U8 已随 U3 提前落地）。

**U 序列 drive（2026-06-04，进行中）**：
- **U0 裁决 ✅**（PR #292/#293）：审计报告 [`../audit/2026-06-04-design-feasibility-audit.md`](../audit/2026-06-04-design-feasibility-audit.md) + 决议 [`../design/2026-06-04-u0-decisions.md`](../design/2026-06-04-u0-decisions.md) + **ADR-0029**（复习引擎落在既有原语上：零必建新表）+ ADR-0028 上 main + 三 spec 修订 + CONTEXT.md 8 词条。
- **重绘 wave-2 ✅**（PR #294/#296，YUK-169）：copilot composer（AF S0 真 chat）+ mistakes/sessions+events/coach/items（D11 健康条）+ legacy CSS −524 行；7A/7B 同日先行（#290/#291）。
- **U2 ✅**（PR #295）：P3 知识级 FSRS（ADR-0028 全五决定 + migration 0027 forward-only）从 codex checkpoint 提取 backend slice 落地；双 bot 9 发现全修（2 P1）。**调度单元自此 = 知识点**。
- **U3 ✅**（本 PR）：Copilot 去 Today 化（CopilotDock）+ 会话持久化（learning_session conversation envelope + experimental:copilot_reply + GET /api/copilot/turns replay）· U8 leave_agent_note 带外 hint 通道（ExperimentalEvent，零 schema）+ Dreaming/Maintenance readers + quiz_verify producer · agent objective cards（docs/agents/objectives.md）+ ADR-0004 product-shape supersede 注记。
- **U4 ✅**（PR #298，plan：[`plans/2026-06-04-u4-reviewplan-pipeline.md`](plans/2026-06-04-u4-reviewplan-pipeline.md)）：Coach brief → ReviewPlanTask 流水线（D5/D7：coach_daily 链式触发、零记忆、4-tool `review_plan` 窄面 + `write_review_plan` exactly-one）· D6 judge 版本钉（result.capability_ref + telemetry 双 override）· `search_memory_facts` domain tool（coach/dreaming/copilot）。双 bot 6 轮 16 发现全修：TOCTOU advisory-lock 事务、planner 输出信任边界（draft/archived/coverage/duplicate 全 REJECT）、pg-boss retry 幂等（job.id 键 + resume 短路）。伴随 PR #299：loom-prototype 设计快照（含练习页）入 `docs/design/loom-prototype/`。
- **U5 ✅**（PR #301，plan：[`plans/2026-06-05-u5-paper-model.md`](plans/2026-06-05-u5-paper-model.md)）：paper 模型落地——ToolStateT v2 sections + migration 0028（answer 复活/artifact_id/手写 partial index，零新表）+ 独立 paper judge event（D6 stamp + derived 可见性 + attribution_pending 解堵归因）+ `/practice` 练习一级页与做卷答题页（草稿 autosave/顺序提交/缓冲反馈/完成揭示回顾）。**双 bot 6 轮 46 findings：44 修 + 2 有据驳回**（1 Critical 冻结行竞态、5 P1 含缓冲判分泄漏/flat 卷不可提交/归因堵塞）；三轮视觉环（真实 fixture + playwright）另抓 5 题。**双 bot 收敛判据自此入流程**（P1 清零 + 末轮全 P2 边角即收口，不追零 finding——用户 2026-06-05 纠正）。Follow-up：YUK-211（pre-existing beacon 401）/ YUK-212（part 收窄平台缺口）。
- **流程升级（用户定 + 实战教训）**：phase workflow = Map→Plan→Plan-Critic→**Cross-统合**→Implement→独立Review→Fix→集成gate(orchestrator亲跑)→视觉环→PR→双bot(召唤+窗口)→merge；视觉环（playwright+原生视觉）启用；verify-by-reconstruction；post-merge smoke。
- Strategy D（真实 ingestion）仍是 U 序列后的下一章。

**数据激活 drive ✅ shipped（2026-06-01，main `8ed672fa` → Station 3）**：详见 [`audits/2026-06-01-data-activation-closeout.md`](audits/2026-06-01-data-activation-closeout.md)。背景=P5 closeout §4 勘察（采集层早已全接线；卡点=冷启动数据荒漠 + 两 wiring-gated linchpin）。用户拍板:合成数据先行 + pre-product + goal cron-trigger。
- **Station 1** 合成数据 generator（`scripts/seed-synthetic.ts`，走生产 writeEvent 路径，#231，YUK-184）· **Station 2A** brief generate-writer（T-37，注入 generateBrief 替 throwing default，#232，YUK-185）· **Station 2B** goal-scope propose cron（D1，复用 runGoalScopeAndWrite，#233，YUK-186）· **Station 3** Layer-8 端到端验证（`layer8_e2e.db.test.ts`，8 slice 全绿，**零真集成 bug**——各层组合干净，YUK-188）。
- **现可观测**：seed → brief regen / goal cron→accept→Coach goal_strand + Dreaming goal-aware + review goal-bias / proposal_signals digest + L2 tighten / FSRS due / active-subject 检测——整个 flywheel 端到端转起来，e2e 测试守护回归。
- **deferred backlog**：YUK-187（goal dismiss-churn，P-low）· Strategy D 真实 ingestion（下一章）· goal chip/UI（随 UI redraw）· Mem0 OPENAI_API_KEY + worker XIAOMI_API_KEY（部署 config）。
- **流程教训**：CI 只跑 CodeQL/Analyze 不跑 pnpm test → SCHEMA_VERSION/schema 改动必须本地手动全量 `pnpm test`；bot review 屡抓 gate 兜不住的真 bug（P1 dotenv-ESM / HIGH prod-fence / brief outcome 列 / Mem0 storm / goal watermark）。

**P5 chain ✅ shipped（2026-05-31，main `b143ecd9` → `82ba1df1`）**：7 阶段全 rebase-merge 到 main，详见 [`audits/2026-05-31-p5-chain-closeout.md`](audits/2026-05-31-p5-chain-closeout.md)。
- **P5.1** Context Budget（`budgets.ts` 单源 + Copilot throttle + soft-stop，YUK-143）· **P5.2** activity-gated brief refresh（PR #218，YUK-143）。
- **P5.4** proposal-quality rubric：L1 enforce（#219）+ L2 adaptive accept-learned bias（#220 spec / #221 impl，YUK-174）。
- **P5.6** suggestion semantics（#225，YUK-178）· **P5.5** tool-eval fixtures Phase 1（#227，YUK-180）· **P5.8** wenyan eval fixture / semantic judge route（#228，YUK-182）· **P5.3** long-term brief freshness score（#229，YUK-183）。
- **关键决策/发现**：P5.3 archive→render-annotation 重构（generate 每次重写段落，归档不自洽）；**brief LLM generate writer 生产未接线**（`handlers.ts:50` 不传 → `defaultGenerateBrief` throw）—— P5.1/5.2/5.3 是先建层后接线，是数据激活的最高杠杆缺口；bounded-impl 纪律（禁 loop-until-green）；本 drive 特批 self-merge loop。
- **deferred**：YUK-181（P5.5 Phase 2，已被 P5.8 解锁）/ YUK-179 / YUK-175/176 / P5.3 Phase-C / reading-note 产品澄清 / T-37 generate-writer 接线。

> 历史「scenario B 第一批」记录见本行下方（2026-05-30 baseline）。

**scenario B 第一批 ✅ shipped（2026-05-30，main `81856564` → `b143ecd9`）**：
- v1 scenario A 收尾（PR #193）：YUK-96 P6 node page / YUK-97 P7 / YUK-150 P2-polish / YUK-160 artifact-panel dead-link / YUK-151 closeout。
- **YUK-148** Redis cross-process editing presence（PR #195，**ADR-0023**）—— 解 §7「跨进程 editing-guard 失效」高危债。
- **YUK-161** node-page primary-atomic dead-link + archived-domain（PR #196）。
- **T-OC / YUK-145**：slice1 generalized capture（PR #197，**ADR-0024**）/ slice2 VLM StructureTask + multi-page YUK-144 rootfix（PR #199）/ slice3 TaggingTask+WorkflowJudge+flag-gated-OFF auto-enroll（PR #202，**ADR-0026**）。DEFERRED：slice-2b figure-matching YUK-163；slice-3b auto-enroll wiring + OC-5 review UI YUK-164。
- **North-Star / YUK-143**：W9 core goal+GoalScopeTask+Coach goal_strand+ND-5（PR #198，**ADR-0025**）+ Dreaming goal-aware（PR #201）+ review soft-bias（PR #206，YUK-167）。DEFERRED：W10 UI（goal cards/views/KG lens）blocked on design pre-flight。
- **T-QP / YUK-165** `question_part` ActivityKind（PR #203）—— ADR-0014 §1/§5 stub 实装 + scheduler-capability 半边。DEFERRED：parent-level 聚合 / part review UI / 自动拆分。
- **T-CS / YUK-168** cross-subject scheduling v1 round-robin（PR #207）。
- **T-AR / YUK-170** acceptance-rate signal + additive Dreaming feed（PR #209）。DEFERRED：T-MR deep maintenance-ranking（data-gated on ≥100 proposals）；dismiss-reason UI。
- infra/follow-up：.env REDIS_URL fix（PR #200）；UI redraw brief（PR #208，WR umbrella YUK-169）；review-findings fix YUK-171（PR #210，learning_item 1:1 invariant + Redis fail-safe）。
- **新 ADR**：0023 / 0024 / 0025 / 0026（文件名已统一 bare `NNNN-`，W15 doc sweep）。**新 Linear**：YUK-160..171。
- **scheduler / intelligence track 已 coherent**：goal core → Dreaming/Coach goal-aware → review soft-bias → question_part → cross-subject → acceptance signal 链路打通。
- 下一步 continue-to-scenario-B 余下（按 feature 价值重切，待 grill 拍板）。
**主分支**：`origin/main` = **数据激活 drive（Station 1/2A/2B/3）已 merge**，2026-06-01（Station 2B baseline `8ed672fa`；P5 chain baseline `82ba1df1`）。走 PR 不直推（2026-05-29 用户定）。
**路线图源**：[`docs/planning/v0.3-generalized-ai-learning-framework.md`](../planning/v0.3-generalized-ai-learning-framework.md) §1.5 是当前执行清单；root `PLANNING.md` v0.12 Phase 1-4 已标 historical

---

## 1. Phase 路线图（Foundation → Product Track → Later，2026-05-19 重排）

### Shipped baseline（v0.12 时期落地，事实保留）

```
✅  0     Bootstrap                Next 15 App Router + Postgres + Drizzle + R2
✅  0z    Self-host                OrbStack 本地 + NAS 部署（Cloudflare Tunnel ingress）
✅  0d    Provider Manager         xiaomi/mimo Anthropic-compat；7 个 task 全切
✅  1a    Subject MVP（文言文）    wenyan 数据集 + FSRS 复习闭环
✅  1b    AI surface               /api/ai/[task] 仅保留 ReviewIntentTask；profile/tool/manual-rescue 任务走领域入口
✅  1c.1  Event-driven core        event 表替代 mistake/review_event/dreaming_proposal
✅  1c.2  UI main                  /record /mistakes /knowledge /learning-items（read + write + Vision）
✅  1d    Observation surface      /events/[id] / 成本带 / ADR-0013 session lifecycle / /coach 周报
✅  2A    Review Orchestrator      规则优先 + ReviewIntentTask
✅  2B    Learning Intent          我想学 X → hub+atomic LearningItem + NoteGenerateTask
✅  2C    Active Teaching          /learn/[id]/chat → TeachingTurnTask 循环
✅  错题闭环                     attribution_followup pg-boss handler
✅  Variant generation             variant_gen handler + cause-targeted prompt + 3 层防繁殖
```

### Foundation A — Unified Activity + Capability Registry（ADR-0014 §1/§2/§4 + N+1）

```
✅  ActivityRef / ActivityKind schemas          src/core/schema/activity.ts
✅  CapabilityManifest / CapabilityRef          src/core/schema/capability.ts
✅  CapabilityRegistry + 默认 registry          src/core/capability/registry.ts
✅  exact + keyword judges 注册为 capability    src/core/capability/judges/{exact,keyword}.ts
✅  JudgeResultV2 (score + scoreMeaning + ref)  src/core/schema/capability.ts
✅  JudgeRouter v2 delegates to registry        src/server/ai/judges/router.ts
✅  老代码路径 question_id → ActivityRef shim    review plan/due/submit 已接入 activity_ref；question_id/mistake_id 仅作 compat/storage
✅  subject identity normalization 完成度回查    src/subjects/profile.ts + tests/subjects/profile.test.ts
```

### Foundation B — SubjectProfile + Frontend Subject Awareness（ADR-0014 §3/§10 + N+1）

```
✅  SubjectProfile 扩展（version, causeCategories, renderConfig, schedulingHints, judgeCapabilities）
                                                src/subjects/profile.ts + wenyan/profile.ts
✅  Build-time profile validator                src/core/capability/validate-profile.ts
✅  Frontend 读 renderConfig 渲染               PR #63 — 前端字体 / metadata / API 不再硬编码 wenyan
✅  API 暴露 subject profile（review / learning-item）  PR #63
✅  剩余 high-use AI task prompt 抽 profileFragments  attribution / graph proposal / variant / teaching / summary / knowledge review 已走 SubjectProfile
✅  非 wenyan 第二科目 profile（math）作为 pressure test  math profile + KaTeX renderConfig + steps@1 + partial credit UI 已收口（#77/#80/#81/#82/#83/#84）
✅  第三科目 profile（physics）Foundation B acid test 1  PR #91（`13485be`）已 ship — `src/subjects/physics/profile.ts` 落地 + `src/subjects/profile.ts` 注册 + `KNOWN_SUBJECT_IDS += 'physics'` + 8 profile tests + 5 e2e smoke + framework diff = 0（acid test 1 ✓）
✅  `unit_dimension@1` P1/P2                         YUK-35 / YUK-36 已 ship — capability skeleton、router contract、mathjs accelerator、LLM fallback、4-path score 组合与 regression tests 落地
```

**M1 closeout archeology（YUK-12）**：

Lane A prompt/profile coverage audit: [`docs/audit/2026-05-25-prompt-profile-coverage.md`](../audit/2026-05-25-prompt-profile-coverage.md)。

Profile LOC snapshots checked with `git show ${sha}:src/subjects/math/profile.ts | wc -l`: `903009c` 94, `da906a4` 101, `b42c03a` 101, `77b969c` 103, `fda9785` 103, `a23694a` 103, `dff8f34` 103, `9191c160` 111, `main` 111. Per-PR numstat below counts text additions/deletions only; no binary or rename rows appeared in the selected output.

| SHA | PR | math/profile.ts LOC | Subject-private | Schema extension | Framework hook | Subject-driven framework feature | Note |
|---|---:|---:|---:|---:|---:|---:|---|
| `903009c` | genesis | 94 | +94 / -0 | +173 / -0 | +0 / -0 | +0 / -0 | `SubjectProfile` schema + math profile introduced together. |
| `da906a4` | #77 | 101 | +408 / -0 | +0 / -0 | +118 / -0 | +305 / -1 | Math seed/fixtures plus multimodal ingestion/question-contract support. |
| `b42c03a` | #80 | 101 | +0 / -0 | +0 / -0 | +135 / -15 | +0 / -0 | Registry/prompt and question-contract cleanup before vision judge. |
| `77b969c` | #81 | 103 | +29 / -1 | +7 / -0 | +323 / -0 | +0 / -0 | `steps@1` capability skeleton and profile regression coverage. |
| `fda9785` | #82 | 103 | +324 / -2 | +12 / -0 | +92 / -11 | +564 / -0 | `steps@1` vision judge implementation plus derivation fixtures. |
| `a23694a` | #83 | 103 | +182 / -1 | +0 / -0 | +0 / -0 | +697 / -18 | KaTeX, partial-credit UI surfaces, and appeal flow. |
| `dff8f34` | #84 | 103 | +0 / -0 | +0 / -0 | +0 / -0 | +3 / -0 | M3 closeout UI polish. |

Conclusion: Foundation B schema extension and math profile were introduced in the same commit (`903009c`), so YUK-12's old "math profile <=50 lines and 0 framework changes" acceptance was not a realistic audit target. Math MVP across six PRs added 2256 lines of framework changes (668 framework-hook + 19 schema-extension + 1569 subject-driven-feature) and 943 lines of math-private code. The acid test of true generalization is physics PR #91: physics landing produced framework diff = 0 (per this Foundation B section), proving the hooks + extensions really generalize.

### Foundation D — Copilot Orchestrator + DomainTool Registry（v0.4 §3 第 8 层）

```
✅  DomainTool interface + registry           src/server/ai/tools/{types,registry}.ts (YUK-79)
✅  tool_call_log 表 effect / error_reason /  drizzle/0014 schema extension; runner.ts + bridge writers (YUK-79)
    mirrored_event_id 列
✅  query_mistakes read tool                  src/server/ai/tools/query-mistakes.ts (YUK-80)
✅  debug endpoint POST /api/_/tools/[name]   admin-only, exec→tool_call_log (YUK-80)
✅  in-process MCP bridge                     src/server/ai/tools/mcp-bridge.ts — generic wrap (YUK-81)
✅  query_events / get_attempt_context        2 more read tools using bridge contract (YUK-81)
✅  experimental:tool_use event mirror        ToolUseExperimental schema enforced; policy resolver + caller introspection (YUK-82)
✅  remaining 10 read tools                   M2 — graph / records / question / review_due / learning_item / memory_brief readers (YUK-102)
⬜  Copilot drawer MVP                        M3
✅  propose / write DomainTools               M4 — Wave 3 T-D4 shipped in PR #170 (YUK-107..112)
⬜  Phase 3 Global Coach Orchestrator         M5
✅  experimental:tool_use → KnownEvent promote M6 — T-D7 / YUK-126, 2026-05-28 (ADR-0011 §1.1; stabilization 时序 gate user-waived 2026-05-28)
```

M1 closeout audit: [`docs/audit/2026-05-26-copilot-tools-foundation.md`](../audit/2026-05-26-copilot-tools-foundation.md).

### Wave 1 — Master roadmap scenario A 第一波（2026-05-27 同日 ship）

```
✅  T-37 brief writer integration                    caccd97 (PR #159) — src/server/memory/{client,brief,scope_tagger,triggers}.ts + ADR-0017 + drizzle/0015+0016 + Mem0 spike findings
✅  T-RA RatingAdvisor UI wiring                     aaa534c (PR #160) — rating-advisor.ts + RatingAdvisor.tsx + advice route + 14 boundary tests
✅  T-66 teaching ask_check question persistence     c320446 (PR #161) — question.source=teaching_check + attempt→mistake→variant 链 + arch.md cleanup
✅  T-88 P0 TipTap block-tree spike                  719c2b7 (PR #162) — 4 invariant snapshot + ADR-0020 split-id-preserve 微调建议，per design 不进 main
✅  W-A post-ship: brief writer event ingest wire    f5e27ef (YUK-99)  — writeEvent → enqueueEventMemoryIngest + .env.example + README + regression test (修 W-01/W-04/W-06)
✅  W-B post-ship: RatingAdvisor cause SoT wiring    013a9ad (YUK-100) — advice + submit route 读 effectiveCauseCategoryForFailureAttempt 并 thread ctx + integration test (修 W-05)
```

Wave 1 closeout doc：[`plans/2026-05-27-wave1-ready-to-launch.md`](plans/2026-05-27-wave1-ready-to-launch.md) §8 ship outcome。Post-ship audit-drift：[`docs/audit/2026-05-27-wave1-postship-drift.md`](../audit/2026-05-27-wave1-postship-drift.md)。

### Wave 2 — YUK-88 P1/P2-basic + Foundation D M2 readers（2026-05-27）

```text
✅  T-88 P1 schema + ADR-0020 block-tree contract     cde1ff4c (YUK-91) — body_blocks / knowledge_ids / artifact_block_ref / correction block_id rewrite
✅  T-88 P2-basic TipTap block-tree editor            803901b0 (YUK-92) — lazy editor, JSON read renderer, block save API, ADR-0022
✅  T-D2 DomainTool read tools full coverage          YUK-102 — 10 M2 readers registered; 13 read tools total with M1 bridge
```

T-D2 landed `get_subject_graph_overview`, `query_knowledge`, `expand_knowledge_subgraph`, `find_knowledge_paths`, `query_records`, `get_record_context`, `get_question_context`, `get_review_due`, `get_learning_item_context`, and `query_memory_brief` in `src/server/ai/tools/{knowledge-readers,context-readers}.ts`, covered by DB + MCP bridge regression tests.

### Wave 3 — DomainTool propose/write tools（shipped 2026-05-28）

```text
✅  T-D4 M4 milestone shipped                          YUK-107 parent + YUK-108/YUK-109/YUK-110/YUK-111/YUK-112 lanes
✅  YUK-108 graph proposal tools                       propose_knowledge_edge + propose_knowledge_mutation
✅  YUK-109 mistake attribution + variant action tools  attribute_mistake + propose_variant
✅  YUK-110 learning item proposal tools                propose_learning_item_completion + propose_learning_item_relearn
✅  YUK-111 record link/promotion proposal tools        propose_record_links + propose_record_promotion
✅  YUK-112 T-D4 closeout                               allowlist policy + docs/status/roadmap + Wave gate evidence
```

Implementation anchor：`src/server/ai/tools/proposal-tools.ts` registers 8 proposal/action DomainTools through `src/server/ai/tools/bootstrap.ts`; `src/server/ai/tools/allowlists.ts` pins the spec task/surface allowlist matrix; proposal schema/UI were extended for `record_links` and `record_promotion`.

Validation anchor：proposal DB tests, registry/MCP/allowlist unit tests, proposal writer/inbox/accept regressions, `pnpm typecheck`, and Wave closeout audits. T-D4 driver：[`plans/2026-05-28-td4-propose-write-tools-driver.md`](plans/2026-05-28-td4-propose-write-tools-driver.md)。

### Wave 4 — YUK-88 P3 AI pipeline + Dreaming lane（shipped + closeout 2026-05-28）

```text
✅  YUK-93 / T-88 P3 AI pipeline rewrite             body_blocks canonical output + NoteGenerate type switch + LearningIntent 0-M long + tool_quiz embedded refs
✅  YUK-114 / T-DR Dreaming Lane                     DreamingTask + dreaming_nightly pg-boss producer + DomainTool MCP bridge + dreaming allowlist
✅  Wave 4 closeout full gate                        post-merge clean pnpm install → typecheck / lint / audit:schema / audit:partition / audit:profile / `pnpm test` (1052 + 11 migration) / `pnpm build` all green
```

Implementation anchor：`src/server/boss/handlers/{note_generate,note_verify,embedded_check_generate,dreaming_nightly}.ts`, `src/server/orchestrator/learning_intent.ts`, `src/server/artifacts/body-blocks.ts`, `src/server/ai/tools/allowlists.ts`, and `src/server/boss/handlers.ts`.

Merge anchor：origin/main `d99c3bb1` ("feat(ai): launch Wave 4 AI lanes (YUK-93 YUK-114)").

Validation anchor：post-merge full gate ✅. Drift audit [`docs/audit/2026-05-28-wave4-closeout-drift.md`](../audit/2026-05-28-wave4-closeout-drift.md) — 0 contradicted, 2 undocumented (`NoteVerificationIssue.section_id` half-migration; legacy correction payload read shim), 2 phase-deferred (hub auto-sync nightly → Wave 7, P2-polish slash/drag/mention → Wave 6+). Wave driver：[`plans/2026-05-28-wave4-ready-to-launch.md`](plans/2026-05-28-wave4-ready-to-launch.md)。

### Wave 5 — Copilot Drawer /today MVP // Global Coach（shipped 2026-05-28）

```text
✅  T-D6 Phase 3 Global Coach Orchestrator    CoachTask + TodayPlan schema + coach_daily/coach_weekly pg-boss handlers (YUK-118/119/120)
✅  T-D3 Copilot Drawer MVP on /today          <CopilotDrawer> + <ToolUseCard> 三段式 + 30s dwell + copilot-summary + CopilotTask chat route (YUK-122/123/124)
```

Layer 8 vision 兑现起点：`/today` 有真 Drawer + Coach 每日/每周 cron 出 plan proposal。详见 master-roadmap §5.1 Wave 5。

### Wave 6 — Living Note v0 + experimental promote（shipped 2026-05-28..29，origin/main `a419b2e6`）

```text
✅  T-88 P4 Living Note v0                     NoteRefineTask + block-level patch ops (replace/insert/remove) + editing heartbeat/idle flush + undo surfaces + 5 Living Note triggers (YUK-127/128/129/130/131)
✅  T-D7 experimental:tool_use → KnownEvent    PR #183 (YUK-126)
✅  T-PD8 modules doc sweep                     PR #184 (YUK-132)
```

单 owner：`src/server/artifacts/note-refine-apply.ts`（AI-side block-patch apply）。注：editing 心跳为 in-memory，**跨进程 guard 缺口**（worker 看不到 web 心跳）见 §7 / YUK-148。

### Wave 7 — 反链 + cross_link + hub auto-sync + Knowledge graph（shipped 2026-05-29，本地 main `17280d51`，**未 push**）

```text
✅  T-88 P5 cross_link L2/L3 write-through      block-refs.ts 单 owner syncBlockRefsForArtifact + listBacklinks；artifact_block_ref.ref_kind 分 cross_link/embedded_check (YUK-95 Lane-0)
✅  T-88 P5 cross_link @-mention picker         CrossLinkSuggestion + @tiptap/suggestion (YUK-95 Lane-A)
✅  T-88 P5 backlink panel + read API           /api/artifacts/[id]/backlinks（不存在 artifact → 404）(YUK-95 Lane-B)
✅  T-88 P5 nightly hub auto-sync worker         hub_auto_sync_nightly @ BJT 02:45，iii-curated mesh + 乐观版本锁 + per-hub try/catch (YUK-95 Lane-C)
✅  T-88 P5 AutoLinks relation chips + dismiss   auto-link-chip + hub-dismiss 单 owner service + suppress event (YUK-95 Lane-D)
✅  T-KG 知识图谱 cytoscape 重建                 cytoscape + fcose 换掉手写 SVG verlet；mastery 配色 + 诊断(孤点/弱掌握/逾期) + 局部聚焦 + AI 提议边内联 accept/dismiss 画布 (YUK-142)
✅  commit-review fix-pass + closeout 修复       undo 版本冲突假成功 / 裸 NUL 源码 / backlinks 404 / hub-dismiss 单 owner 抽取（step9 invariant）
```

实现锚点：`src/server/artifacts/{block-refs,hub-dismiss,note-refine-apply}.ts`、`src/ui/KnowledgeGraph.tsx`(cytoscape)、`src/ui/block-tree/{CrossLinkSuggestion,auto-link-chip,tiptap-extensions}`、`src/server/knowledge/hub-mesh.ts`、`src/server/boss/handlers/hub_auto_sync_nightly.ts`、`app/api/artifacts/[id]/backlinks` + `app/api/hubs/[id]/dismiss-link` + `app/api/knowledge/review-due-summary`。
Validation：本地全 wave-gate ✅（144 test files / 1137 tests + 1 todo / migration 11 / build 55 pages）。Wave 计划：[`plans/2026-05-29-wave7-ready-to-launch.md`](plans/2026-05-29-wave7-ready-to-launch.md)。逐-commit 审查报告：[`docs/audit/2026-05-29-commit-review.md`](../audit/2026-05-29-commit-review.md)。

### Foundation C — Judge Result Contract + Correction Event（ADR-0014 §4/§6）

```
✅  JudgeResultV2 schema + scoreMeaning + coarseOutcome  随 Foundation A 落地
✅  Judge v2 light async service                `judgeAnswer` compiles question contract; exact/keyword local + semantic via `SemanticJudgeTask`
✅  CorrectEventPayload as KnownEvent（supersede / retract / mark_wrong / restore）
✅  Projection 层 consult correction events
✅  UI 撤回 / 标错 / 恢复入口
```

注：Codex R7 把 correction event 从 N+3 提到 N+2，因为 semantic / external judge 上线后 evidence 累积快，需要先有撤回机制。

### Product Track 1 — Review / Learning Item / Teaching Loop 收口（v0.3 Track A）

```
✅  NoteVerifyTask Pass 2           `note_verify` queue + artifact verification metadata landed; proposal-inbox rollback remains later
✅  Embedded check（atomic notes）  inline 选择题 / fill-blank / prose semantic check — `embedded_check_generate` persists judge contract；attempt route writes success/partial/failure without polluting mistakes on unsupported
✅  Note 编辑 / 阅读 UX 完善          markdown renderer / embedded check inline / verification badge / section edit-in-place 已 ship
✅  VariantVerifyTask Pass 2        variant 双 pass + variants_max=3 计数已 ship
✅  Learning-item proposal rollback UI
✅  Teaching session idle state machine
✅  Record → proposal evidence loop  /record 条目能 surface 为 graph / item proposal
✅  Review session UX polish         judge auto-rating / skip + pause/resume / attempt timeline / end CTA / subject marker / answer preview / intent banner / abandoned resume
✅  Phase 2C chat deploy + E2E       NAS rebuild + 3 轮 browser chat E2E，DB-level admin obs retest 由 YUK-65 跟踪
```

### Product Track 2 — Maintenance Agent + Proposal Inbox（v0.3 Track D）

```
✅  统一 AiProposalPayload          YUK-42 — `src/core/schema/proposal.ts` discriminated union (kind / target / reason_md / evidence_refs / rollback_plan / cooldown_key) + writer / inbox / producers / signals
🟡  Maintenance agent               YUK-48 cron ✅ (`knowledge_maintenance_nightly` BJT 03:00); accept UI uses unified proposal lifecycle；deep maintenance ranking (T-MR) data-gated on ≥100 proposals
✅  Dreaming lane                   YUK-114 `dreaming_nightly` BJT 03:15；DomainTool MCP bridge + unified proposal inbox；goal-aware bias (YUK-143/ADR-0025, PR #201) + acceptance-rate additive bias (T-AR/YUK-170, PR #209)
✅  Acceptance-rate / dismiss-reason 信号 → ranking   T-AR / YUK-170 (PR #209) — signal foundation + additive Dreaming feed；DEFERRED: dismiss-reason UI + T-MR deep ranking (data-gated)
⬜  Bad accepted proposal 显式 retraction / rollback 流程
```

### U 序列 — 三设计统一落地（YUK-203，2026-06-04 起）

> 机器可读 shipped 注册表：`pnpm audit:schema` 的 `resolves_when.kind='phase'` 按本 block 的 ✅ 行判定 phase 是否 shipped（脚本只解析 `## 1. Phase 路线图` 下 fenced block）。叙述性细节见顶部「U 序列 drive」。

```
✅  U0    审计 + 裁决              29-agent 可行性审计 → D1-D11 + ADR-0029/0028（PR #292/#293）
✅  U1    重绘 wave-2              composer + mistakes/sessions/coach/items loom 化（PR #294/#296，YUK-169）
✅  U2    知识级 FSRS              ADR-0028 调度单元 = 知识点（PR #295）
✅  U3    Copilot 持久化           会话 envelope + 去 Today 化 + agent objective docs（PR #297）
✅  U4    ReviewPlanTask 流水线    Coach brief → review_plan 窄面 + D6 judge 版本钉（PR #298/#299）
✅  U5    paper 模型 + 试卷 UI     ToolStateT v2 sections + migration 0028 + 独立 judge event + /practice 双页（PR #301）
⬜  U6    三 chat 合并             teaching/solve → Copilot（AF S4）
⬜  U7    Studio MVP               profile 编译 CLI + ProfileCriticTask + read-only /admin/subjects
✅  U8    leave_agent_note         随 U3 提前落地（ExperimentalEvent 带外 hint 通道）
```

### Later — Standalone MCP / Plugin / Multi-Subject 扩展

```
🚫  公共 MCP server / Plugin platform   v0.3 §6 Non-Goal；产品内 runtime tool 走 in-process MCP adapter
🚫  外部 MCP 消费                       延后到内部 loop 稳定 + 真有外部客户端需要
⏳  Multi-subject 扩展                  math + physics P0/P1/P2 已过；下一步是 Foundation A 单 invoker / broader call-site 收口，再决定下一个 subject pressure test
⏳  Source / Grounding / Multimodal     v0.3 Track F；presume Foundation A/B/C ready
```

**遗留迁移项**（独立于 Foundation/Track 顺序）：
- ⏳ Record model migration：`/record` 统一 LearningRecord，替代 `/study-log`（Phase 1c.2 后续）

---

## 2. 关键决策（ADR 索引）

| ADR | 主题 | 决议 |
|---|---|---|
| 0006 v2 | 数据骨架 | 全部走 `event` 表 + projection 投影；artifact 留 C 档 AI 产出 |
| 0007 | 单用户 | 不做 per-user auth；`x-internal-token` 中间件兜底 |
| 0008 | LearningSession | 多类型 session（review / record / conversation / dreaming）共用一张表 |
| 0010 | 知识 mesh | knowledge_edge 取代 prerequisite/tag 体系 |
| 0011 v2 | tool_use + suggestion + edge events | agent 的所有写入都过 event |
| 0012 | mastery view | DROP 双层 mastery；改用 derived view |
| 0013 | /review session lifecycle | eager 开 session + sendBeacon close + 6h orphan cron 兜底 |
| 0014 | Generalized Activity + Capability Registry | `ActivityRef` 取代 question_id；judge/renderer/scheduler 注册制；SubjectProfile 纯数据 + 完全 profile-driven 归因；JudgeResult v2 连续分数；correction event 一等公民；FSRS 是 scheduling policy 之一（2026-05-29 header proposed→accepted，T-PD11；2026-05-30 §1 question_part 实装 T-QP） |
| 0023 | 跨进程 editing presence via Redis | Living Note 编辑心跳落 Redis 共享态，web/worker 进程共读；解 §7 跨进程 editing-guard 失效（YUK-148） |
| 0024 | 泛化捕获 — 录入的 outcome 是 signal | T-OC slice 1：录入 outcome 不写死 mistake；`enrollCapturedBlock` 单一入库 owner（YUK-145） |
| 0025 | North-Star `goal` 实体 + Coach 共存契约 | YUK-143：goal 实体 + GoalScopeTask + Coach goal_strand；ND-5 不变式（Dreaming/Coach 只 additive bias，never suppress signal-driven proposals） |
| 0026 | WorkflowJudge 置信闸门 + flag-gated 保守自动入库 | T-OC slice 3：TaggingTask + WorkflowJudge confidence-gate；auto-enroll flag 默认 OFF（OC-4 / OC-5，YUK-145） |

新 ADR 模板见 `docs/adr/`（文件名统一 bare `NNNN-kebab-title.md`）。改弦更张前先翻当时的 ADR 别重新论证。

ADR-0014 配套：[7 轮讨论 + 10 决议 summary](../discussion/summary.md)、[N+1 实施计划（2125 行）](plans/2026-05-18-capability-registry-foundation.md)。

---

## 3. 三大 orchestrator 落地（Phase 2 MVP）

### Phase 2A — Review Orchestrator（A 档「今天复习什么」）
- `src/server/orchestrator/review.ts` —— 规则优先（cause-base + days_overdue + lapses bonuses，capped 5）
- 队列摘要 → `ReviewIntentTask`（mimo-v2.5-pro）→ 一句话 session intent
- `/review` 页面顶部展示 intent 字幕

### Phase 2B — Learning Intent Orchestrator（B 档「我想学 X」）
- `src/server/orchestrator/learning_intent.ts` —— 支持 3a/3b/3c proposal flow：缺 topic / 缺 children / 现有图均走 proposal → accept
- `LearningIntentOutlineTask` 出 1 hub + N atomic + 0-M long 拆分
- POST /api/learning-intents（plan）+ POST /api/learning-intents/[id]/accept
- accept 在 DB 事务里：1 hub LearningItem + N atomic + M long + 1 hub artifact(outline ready) + generated note artifacts(pending) + rate event
- 落库后入队 `note_generate` 异步 job → `NoteGenerateTask` 按 artifact_type 填 `body_blocks`
- `/learning-items` 页面顶部「我想学…」输入框 + inline proposal panel；accept → 跳详情页

### Phase 2C — Active Teaching Session（A+B 合成的教学循环）
- `learning_session(type='conversation', status='active'→'ended')`，`src/server/session/conversation.ts` 单 owner 写路径
- `TeachingTurnTask` 输入 { learning_item, parent_hub_summary, atomic_sections, messages } → 输出 `{kind: 'explain'|'ask_check'|'end', text_md, suggested_next}`；`ask_check` 可附带 `structured_question`，由 turn route 落 `question(source='teaching_check')`
- 4 routes：POST /api/teaching-sessions（start + 首 agent turn）、POST .../turn（user→agent）、POST .../end、GET ...（session + 消息列表）
- `/learn/[learning_item_id]/chat` UI：消息流 + 输入 + 结束按钮；⌘/Ctrl+Enter 发送
- 消息 = `event(action='experimental:teach_message', payload={role,text_md,turn_kind})`
- MVP 不做：streaming / tool call / VariantVerifyTask Pass 2 都留 Phase 3；inline ask_check 题目已走 `question(source='teaching_check')` + 现有 attempt/mistake 链路

### 错题闭环 + 变式生成（cross-cutting）
- `attribution_followup` pg-boss handler：失败 attempt → 异步 AttributionTask → judge event（替换原 `next/server.after()`）
- `variant_gen` pg-boss handler 串联到 attribution_followup：judge.cause ∈ 7 类目标 cause + 3 层防繁殖（depth≤1 / variant 不再生变式 / cause∈{carelessness,time_pressure,other} 跳过）→ 1 道 `source='mistake_variant'` 题入库

---

## 4. Provider Manager / xiaomi mimo

- `src/server/ai/providers.ts` —— `PROVIDERS` 映射 + `resolveTaskModel`
- 7 个 task 全切到 xiaomi (`https://api.xiaomimimo.com/anthropic/v1`)，model：mimo-v2.5-pro（文本）/ mimo-v2.5（多模态）
- Anthropic 订阅 OAuth 因 ToS 受限；mimo 是 Anthropic-protocol-compat 第三方，**ToS 干净** + 单用户体量 OK
- 浏览器代码不持 API key —— UI 调用具体领域 route；generic `/api/ai/[task]` 仅允许 `ReviewIntentTask`，server 端读 env

---

## 5. 当前可用 UI 路径

| 路径 | 功能 | 备注 |
|---|---|---|
| `/today` | KPI + 成本带 | BJT 每天 0 点重算 |
| `/record` | LearningRecord 统一录入：错题 / 例题 / 疑问 / 顿悟 / 反思 / 资源摘录 | 2026-05-18 设计改为一次性迁移；OCR 仍是 capture mode |
| `/mistakes` | 错题列表 + user_cause | cause 写为 experimental:user_cause event |
| `/learning-items` | 6 状态机 + 我想学 X 入口 | hub+atomic 树 + intent proposal |
| `/learning-items/[id]` | 详情 + artifact view + 父子链接 | atomic note sections 渲染 + 对话教学入口 |
| `/learn/[id]/chat` | **Phase 2C 对话教学** | TeachingTurnTask 循环 |
| `/knowledge` | 知识图谱（cytoscape + fcose）+ mesh + 手动建边 | 诊断(孤点/弱掌握/逾期)/局部聚焦视图 + 边提议 accept/reverse/change_type/dismiss + AI 提议边内联 accept/dismiss |
| `/knowledge/[id]` | 知识点详情 | edge proposals + 相邻边 |
| `/records` | 学习记录列表 / timeline | 替代旧 `/study-log`，实现待迁移 |
| `/events/[id]` | 事件链浏览器 | caused_by 上游 + 下游展开 + correction status/actions |
| `/review` | FSRS 复习闭环 | ADR-0013 session row + ReviewIntent 字幕 |
| `/learning-sessions/[id]` | 复习会话详情 + 总结 | SessionSummaryTask 落 summary_md |
| `/coach` | 周度报表 | 柱状图 + 易错知识点 + 归因分布 |

---

## 6. pg-boss 队列（生产 worker 在跑）

| 队列 | 触发 | 任务 |
|---|---|---|
| `knowledge_propose_nightly` | cron @ BJT 02:00 | 节点提议 |
| `knowledge_edge_propose_nightly` | cron @ BJT 02:30 | 边提议 |
| `hub_auto_sync_nightly` | cron @ BJT 02:45 | hub auto-link mesh 同步（iii-curated cross_link → AutoLinksContainer）+ 乐观版本锁 + per-hub try/catch（YUK-95 P5-C）|
| `knowledge_maintenance_nightly` | cron @ BJT 03:00 | KnowledgeReviewTask → tree / mesh maintenance proposals |
| `dreaming_nightly` | cron @ BJT 03:15 | DreamingTask + DomainTools → proposal inbox |
| `prune_job_events` | cron @ BJT 04:00 | 旧 job_events 清理 |
| `prune_orphan_review_sessions` | cron @ BJT 04:15 | 6h+ started 标 abandoned（ADR-0013） |
| `session_summary` | review session end | SessionSummaryTask → summary_md |
| `note_generate` | learning-intent accept | NoteGenerateTask → note artifact `body_blocks` |
| `note_verify` | note_generate ready | NoteVerifyTask → structural body-block verifier + artifact verification metadata / event |
| `embedded_check_generate` | note_verify pass | EmbeddedCheckGenerateTask → 1-3 embedded question rows + `tool_quiz` artifact ref |
| `attribution_followup` | 失败 attempt | AttributionTask → judge event |
| `variant_gen` | attribution_followup done | VariantGenTask → mistake_variant question |
| `tencent_ocr_extract` | /record vision 提交 | Tencent QuestionMarkAgent OCR |
| `echo` | E2E harness | golden 链路验证 |

---

## 7. 技术债 / 已知遗留

| 项 | 描述 | 严重度 |
|---|---|---|
| ~~Phase 2C UI 未真机验证~~ ✅ resolved | ~~本地 ship 完没 E2E 跑过浏览器；NAS 容器还是旧 build~~ —— **已解**：见上方 ✅「Phase 2C chat deploy + E2E」行——NAS rebuild + 3 轮 browser chat E2E 已 closeout（DB-level admin obs retest 由 YUK-65 单独跟踪，不阻塞本项） | ~~高~~ → resolved |
| ~~跨进程 editing-guard 失效~~ ✅ resolved | ~~`editing-session.ts` 模块级内存 Map：web 进程 API route 写心跳，`isArtifactIdle` 在 pg-boss **worker 进程**读不到 → 永远 idle~~ —— **已解**：editing presence 落 Redis 共享态，web/worker 共读（YUK-148，PR #195，ADR-0023；YUK-171 PR #210 加 Redis fail-safe）| ~~高~~ → resolved |
| user_cause 与 agent judge 合并策略 | YUK-51 锁定 shared projection：active user_cause 优先，否则 latest active agent judge；dreaming/maintenance 只能提议不能静默覆盖 | 中 |
| Full judge capability expansion | `semantic` 已通过 async service 可用；`rubric` / `steps` / `multimodal_direct` / `ai_flexible` 仍需独立 capability runner 和 score policy | 中 |
| Dependabot moderate 警告 | GitHub 报 5 条；未处理 | 中 |
| variants_max 计数表 | MVP 一道 parent 只生 1 道变式（per parent_variant_id 唯一性）；多道变式留 Phase 3 | 低 |
| `app/api/_/*` 不进 prod build | 私有路由需要从 UI 调用就得移出 `_` 前缀 | 低 |
| `.env.local` 是 symlink | `ln -s ~/.env.local`；不同机器需要重新建 | 低 |
| README / Linear 镜像漂移 | README 已刷新为 Next/Postgres/pg-boss 当前栈；Linear 只保留 catalog/link，后续镜像前仍需重跑 `pnpm docs:linear-manifest` | 低 |
| Linear 文档迁移 | Repo 仍是 SoT；Linear 仅迁 current status / roadmap summary / historical index；完整映射由 `pnpm docs:linear-manifest` 生成 | 中 |

---

## 8. 文档地图

| 看什么 | 去哪 |
|---|---|
| **当前路线图** | [`docs/planning/v0.3-generalized-ai-learning-framework.md`](../planning/v0.3-generalized-ai-learning-framework.md) §1.5 — Foundation A/B/C → Product Track 1/2 → Later |
| **Anchor 决议** | [ADR-0014 — Generalized Activity + Capability Registry](../adr/0014-generalized-activity-and-capability-registry.md) + [discussion/summary.md](../discussion/summary.md)（10 决议） |
| Phase N+1 详细实施 | [`plans/2026-05-18-capability-registry-foundation.md`](plans/2026-05-18-capability-registry-foundation.md) |
| Historical roadmap（v0.12） | root `PLANNING.md`（保留作历史决策记录，**不要按此顺序认领新工作**） |
| 项目能干什么 / 如何启动 | `CLAUDE.md` |
| 架构总览 | `docs/architecture.md` |
| 长期 orchestrator 设计 | `docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` |
| Agent runtime tool / graph + event + learning context 设计 | `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` |
| 学习记录 / `/record` 一次性迁移设计 | `docs/modules/records.md` |
| 知识图谱 / Subject Graph Guide / proposal rubric | `docs/modules/knowledge.md` |
| 单个模块详情 | `docs/modules/*.md`（每个文件开头有 §0 实施现状） |
| 设计决策 | `docs/adr/ADR-*.md` |
| Phase 计划 + 收尾记录 | `docs/superpowers/plans/*.md` + `docs/superpowers/brainstorms/*.md`（MVP 防漂移） |
| 工具命令 | `pnpm` script 见 `package.json`；`pnpm audit:schema` 防 schema 漂移 |
| 下次会话从哪接 | `RESUME.md`（一次性 scratch） |
| Linear 文档迁移规则 | [`docs/agents/linear-doc-migration.md`](../agents/linear-doc-migration.md) + `pnpm docs:linear-manifest` |

---

## 9. 维护规则

- **何时更新**：完成一个 Phase 阶段、推上 main、确认无回滚后。**不维护周度进度**——那是 git log 的事。
- **谁负责更新**：当前会话结束前由 AI 主动 propose update；用户确认后才落地。
- **不写什么**：commit list（git log 已经在做）、bug fix 细节（commit message 已记）、临时进度（用 `RESUME.md`）、设计论证（用 ADR）。
- **stale 信号**：「最后更新」距今 ≥ 1 个 Phase（即 commit 数 ≥ 20 后还没动），下次会话开头就该 propose 一次 update。
