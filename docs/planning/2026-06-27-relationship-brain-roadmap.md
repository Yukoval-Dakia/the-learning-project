# 私人教研团 全脑 ulw 执行路线图

> 综合自三轮 scout（Map 1 现状 / Map 2 NOW 可建 / Map 3 gated organs）。日期基线 **2026-06-27**。Repo: `the-learning-project`，Linear team `Yukoval/YUK`。
> 路线图按 owner 四原则排序：**felt-first（备课台 pull）→ foundation-trust-first（conjecture 问责先于规划/教学法）→ cold-start-first → defer-flip-not-build**。
> 三脑 = 感官之上的 meta 层：**关系脑（Phase 0，信任上游）/ 规划脑（Phase 2）/ 教学法脑（Phase 3，最依赖 judge，最后）**。

---

## 1. 现状快照

| 脑 / 层 | 子件 | Linear | 状态 | drift 旗 |
|---|---|---|---|---|
| **关系脑·量化半** | A1 SRT / A2 hier-Elo / A3 MFI | YUK-433/434/435 | **LIVE** | — |
| | B1 三轴 + `item_calibration` + 4 诊断器 + 慢热自校准 | YUK-348 | **LIVE**（BKT soft-track 已实例化但 **dark**，n=1 红线不喂决策） | — |
| | inc-A fixed-anchor 写路径 / 上游 auto_rate 修复 | YUK-453 / YUK-432 | **LIVE** | — |
| | A4 grid-Bayes θ / A9 LLM step-grading | YUK-436 / YUK-438 | **IN-FLIGHT** | — |
| | A5 graph-Laplacian / A6 prereq 传播 | YUK-441 / YUK-442 | **Backlog（已解锁）** | ⚠️ 依赖 YUK-344 已 Done → 静默解锁 |
| | A7/A8/A10–A15 + A1 精修簇 | YUK-437/443/444/445/446/447/439 等 | **DESIGN** | — |
| **关系脑·定性半（A13 conjecture engine）** | Phase 0 conjecture + 例会 job + 备课台 | **YUK-406** | **IN-FLIGHT（PR-1 worktree `tlp-wt-a13`，未 push）** | ⚠️ Linear=Todo，应 In Progress |
| | A13 prediction-grounding + typed KC ledger | **YUK-440** | **IN-FLIGHT（PR-1 引用，未 push）** | ⚠️ Linear=Backlog，应 In Progress |
| | 错因 catalog + retrieve-rerank L1 | YUK-454 / YUK-462 | **LIVE（rerank dark，soft-track）** | — |
| **规划脑·B3** | daily-stream merge engine（retire `review_plan`） | **YUK-349** | **IN-FLIGHT（~13d）** | ⚠️ `/api/review/plan` 仍注册，retire 未落；核对 code 再排期 |
| **规划脑·panel** | 单 Opus 审议 panel（SELECT-not-fuse） | **无 issue**（doc only） | **DESIGN** | 🚩 **tripwire ③ 缺 issue/expected_by** |
| | cross-provider de-bias panel | YUK-416 | **DEFERRED**（等第 2 frontier lane） | — |
| **教学法脑** | 8-method palette + `policy()` + B5 verify | **无 issue**（capstone §0） | **DESIGN（零代码，`src/core/pedagogy/` 不存在）** | 🚩 **tripwire ③ 缺 issue/expected_by** |
| | B5 unified verify contract（Verifier Router） | YUK-350 | **IN-FLIGHT（W0 done）** | — |
| **支持·备课台** | felt-core anti-guilt surface | YUK-406 | **LIVE shell**（需 conjecture ≤3 reframe） | — |
| **支持·proposal/drafts** | proposal-as-event + /drafts 池 | YUK-403 | **LIVE**（PR #455） | — |
| **支持·记忆基质** | KG timeless + consistency/reconcile ring | YUK-344 | **LIVE**（PR #467/#474/#477） | — |
| **支持·Jury** | 异构 panel（唯一真并行） | YUK-416 | **DEFERRED** | — |
| **元层·Reflection-Tree** | meta-conjecture | YUK-418 | **Backlog（Med，resurrected）** | issue 显式要 expected_by |
| **元层·Auto-Quest** | goal-anchored 长程 | YUK-419 | **Backlog（Low）** | 依赖 goal entity YUK-143（IN-FLIGHT） |
| **元层·Reconstruction** | 生成式 method（非 organ） | YUK-407 | **Backlog（Low）** | 仅 Phase-0 日志红线 NOW |
| **冷启链** | goal/onboarding/seed/placement/auto-promote | YUK-472/473/477/468/475/479 | **LIVE** | U upload YUK-478 IP；P4/self-desc/scope YUK-476/480/481 Backlog |
| **ADR-0046** | 确定性数值核 = Rust SoT（θ/PFA/scoring）；`scorePrediction`→flip Rust-owned + deferred | — | merged | Rust beachhead YUK-493 Done；同构核 YUK-495 IN-FLIGHT |

**净 drift 结论**：① YUK-406/440 状态滞后（push PR-1 后自动修正）；② YUK-349 retire 未落，排 Phase 2 前必须 code-核对；③ **规划脑 panel + 教学法脑 都无 Linear issue → 直接违反 tripwire ③**（本路线图第 5 节强制开单）；④ YUK-344 Done 已解锁 A5/A6（旧 doc 仍当 pending gate，作废）。

---

## 2. NOW — 立即 ulw 前沿（关系脑 Phase 0 + A13 loop）

> 这是 owner **第一轮 ulw** 要打的全部。9 个 PR 大小的单元，分 3 条 lane。每条 lane = 独立 worktree（per `feedback_omc_isolation_actually_manual`：team-lead 预先 `git worktree add` + worker prompt explicit `cd` 绝对路径）。所有 PR 用 `Refs YUK-406` / `Refs YUK-440`（**非 Closes**——全 Phase 0 scope 跨 9 单元，只有最后一单 `Closes`）。

### U0 —（owner 动作，非 ulw）push PR-1 + 开 PR

`tlp-wt-a13` 分支 `yuk-440-a13-prediction-grounding` HEAD `6b55aecf`（+`cd2dedf9`），gate-green，propose-half 完整、accountability wired、FLIP deferred（ADR-0046）。**push 即把 YUK-406/440 自动翻 In Progress**。这是后续一切的隐式前置。

### 单元表（依赖 / gate / ulw-就绪 / lane）

| # | 单元 | 交付物 | 依赖 | gate | ulw | lane |
|---|---|---|---|---|---|---|
| **U1** | 日志契约（YUK-407 plan Task 7） | `ReconstructionSignal` enum + optional `reconstruction_signal` payload，两个 live 写点 stamp `'unknown'` | 无 | `test:unit`（event round-trip）+`typecheck`；无新列 → audit:schema 不动 | ✅ | **A（独立，先落/并行）** |
| **U2** | accept applier（plan Task 5） | `acceptConjectureProposal`（accept-not-confirmed `weakness_confirmed:false`，edit→mem0 CORE seam，reject→digest，幂等）；**把 `'conjecture'` 加入 `acceptSupportedProposalKinds`，翻转 PR-1 的 deliberate exclude** | PR-1 schema | `test:db`（accept/edit/reject/幂等）+`test:unit`（inbox-meta 分区再平衡）+`typecheck` | ✅（prompt 须带：原子翻转 `acceptSupportedProposalKinds ∪ unsupported === aiProposalKinds` guard；**accept 路径绝不写 FSRS**，ND-5） | **B（顺序）** |
| **U3** | probe one-shot 生命周期（plan Task 6）= **A13 dark-loop 产出者** | `serveProbeOnce`/`answerProbe`/`countActiveProbes`；served-once、`draft_status='draft'`（池不可见）、≤3 并发、**绝不写 FSRS**；发 probe-outcome 事件 | PR-1 + U2 | `test:db`（one-shot/池不可见/≤3 cap/recurrence regression-lock 断言不在 `due-list.ts`）+`audit:draft-status`+`typecheck` | ✅（**载重跨 doc 修正：事件名 canonical = `experimental:probe_result`，带 `{conjecture_event_id, outcome:0|1, resolution, retrievability_at_judge}`**——新 doc 赢，旧 plan 的 `probe_served/answered` 作废；probe 必须走既有 practice/attempt 答题路径，不另起 UI） | **B（顺序，关键汇聚点）** |
| **U4** | 备课台 read model + owner-decision route + handoff doc（plan Task 8） | `loadPrepDeskConjectures`（salience sort、cap 3、**wire 上 strip `confidence` 数字**）+ `GET /api/prep-desk/conjectures` + handoff doc。**无 `.tsx`/`.css`** | PR-1 + U2 | `test:db`（read-model + route-registration）+`gen:postman` manifest 对账 +`typecheck` | ⚠️ **backend ✅；felt 备课台卡片 UI 是 design-gated（claude design），不在本 PR**。U4 只出 read model + route + 触发 design pass 的 handoff doc | **B（顺序）** |
| **U5** | `kc_typed_state` 表（5 面登记） | pgTable 镜像 `mastery_state`：`typed_state{no-evidence\|confused-with-X\|mastered}`/`confused_with_kc_id`/`lifecycle{open\|resolved}`/`evidence_event_ids`/`last_evidence_at`；uniq+idx | 无 | `audit:schema`+`test:migration`+`reverse_lockstep.db.test`+`backup-import.db.test`+`constants.test`（FK_ORDER） | ✅（**5 面 per `reference_new_pgtable_registration_surfaces`：schema / migration / audit:schema / export constants.ts FK_ORDER+SCHEMA_VERSION bump / db.ts ALL_TABLES。漏 ④⑤ → reverse-lockstep 崩整个 backup 测试 collection，audit:schema 抓不到 → pre-flight 必含 export/backup 测试**） | **C（独立）** |
| **U6** | `upsertKcTypedState` single-writer | advisory-lock 串行（**独立 lock 命名空间 `kc_typed:knowledge:<id>`，不撞 mastery_state**）、纯 event-derived；§修正-4 gate：`confused-with-X` 须 `discriminating:true` AND `recurrence_count≥2`，否则落软 `open` | U5 | `test:db`（并发串行/确定性转移/evidence wiring） | ✅（`mastery_state` single-writer 即模板） | **C（顺序）** |
| **U7** | `scorePrediction` stub（ADR-0046）+ public `retrievabilityForKc` | 纯 3-scalar→4-scalar stub（`brierModel/brierBaseline/logLossModel/skillScorePoint`，无 DB/cohort，n=1-safe，header 标 Rust-first placeholder）；practice fsrs 加 public `retrievabilityForKc` wrapper | 无（scoring 纯）；retrievabilityForKc 依赖 practice fsrs 内部 | `test:unit`（公式/clamp/n=1；R∈[0,1]）+`typecheck` | ✅（**唯一风险：A13 doc §修正-6 假设 ts-fsrs v6 `get_retrievability`，但 repo 钉 `^5.4.1`——ulw 必须先 context7 核 v5.4.1 签名，别信 doc 的 v6；且不得 deep-import 私有符号，加 public wrapper**） | **C（独立）** |
| **U8** | reconcile loop wiring（predict→outcome→score→update；**FLIP deferred，LOG only**） | 把第 6 步接进 `research_meeting_nightly.ts`：读 prior conjecture + `probe_result` → `scorePrediction(stub)` → append `experimental:prediction_score` → `upsertKcTypedState`（仅 probe-resolution 写）；**claim-survival FLIP 不接，score 永不动 label/`mastered`** | U3 + U5 + U6 + U7 | `test:db`（predict↔outcome join by KC+window、append-only、kc_typed 仅 probe-resolution 写、**断言 score 不翻 label**、R(t) 不进 written state） | ✅（U3+U5+U6+U7 落齐后） | **B+C 汇聚** |

### PR 批次（每个 = 一条 ulw lane）
- **PR-2a = U1**（tiny，先落/并行）
- **PR-2b = U2 → PR-2c = U3 → PR-2d = U4**（Track A felt，顺序）
- **PR-3a = U5 → PR-3b = U6**；**PR-3c = U7**（与 U5/U6 并行）**→ PR-3d = U8**（汇聚）
- ⚠️ **不要** 按 A13-doc §7 把 U5–U8 打成单 PR——表+writer+scoring+reconcile 对一条自治 lane 太宽，4 拆给干净 checkpoint 且隔离 ts-fsrs 风险（U7）和 schema 风险（U5）。

### 并行拓扑（第一轮 ulw 可同时起 3 worktree）
```
Lane A:  U1 ───────────────────────────────────────┐
Lane B:  PR-1✓ → U2 → U3 ──────────────┐            │  全部 merge
                       └→ U4(UI design-gated)        │  到 wave 分支
Lane C:  U5 → U6 ─┐                      │            │  → PR → owner merge
         U7 ──────┴──────────→ U8 ←─ U3 ─┘            │
```
**U3 是汇聚点**——既是 Phase 0 felt probe，又是 A13 dark-loop outcome 产出者。**先把 U2→U3 排早**：U3 同时解锁 U4（felt loop）和 U8（typed loop）。Lane A 与 Lane C 起步即可与 Lane B 并行；U8 等 U3+U5+U6+U7 全落。

---

## 3. 有序 roadmap（阶段 P0 → P5）

### P0 — 关系脑 Phase 0：备课台 felt loop + A13 问责闭环 〔NOW〕
- **目标（felt capability）**：「为你而备、你不在也在转」——owner 打开备课台看到 ≤3 条带 provenance 的 conjecture（「它真替我想过了」），可 采纳/改/不要；夜间例会 job 自动产出，probe 一次性验证，prediction-score 落账（**只 LOG，不翻 flag**）。这是**信任上游**——A13 问责度是规划脑/教学法脑质量的前置。
- **交付物**：U1–U8（见第 2 节）+ design-gated 备课台卡片 UI（claude design，handoff doc 由 U4 触发）。
- **Linear**：YUK-406（parent 关系脑）+ YUK-440（A13 typed-ledger）+ YUK-407 日志红线（U1）。
- **依赖**：B1（YUK-348 Done）、PR-1 push（U0）。
- **gate**：全单元各自 gate（第 2 节）+ wave 分支全量 `pnpm test`/`typecheck`/`lint`/`audit:*`/`build`。
- **expected_by**：felt thin-slice（U1–U4 + UI）**2026-07-11**；A13 typed-ledger（U5–U8）**2026-07-18**。
- **2-week alive/kill 窗**：**2026-07-11 → 2026-07-25**（跑在 live felt loop 上，backend-only 不启动时钟）。
- **ulw-就绪度**：✅ **全部 buildable now**（U1–U8 都有 grounded plan task-body 或 template 先例）；唯一 ⚠️ = 备课台卡片 UI（design-gated，走 claude design，不进 ulw lane）。

### P1 — 规划脑·B3 daily-stream merge engine 〔可与 P0 并行〕
- **目标**：一个 AI 编排引擎吃 FSRS-due + frontier（prereq-gating 递归 CTE）+ mastery p(L) + mem0 prior + AI 判断 → 今日 stream，物化进 `practice_stream_item`，**retire `review_plan`**。硬约束确定性内嵌（due-must-review / orphan-draft 排除），**只 merge what+mix，FSRS `when` 数学留独立真相源**。
- **交付物**：merge-and-retire 步骤（substrate 已在：`stream-composer.ts` + MFI 三层 ADR-0042）；`/api/review/plan` 退役。
- **Linear**：YUK-349（IN-FLIGHT）。
- **依赖**：B1（YUK-348 Done）——**唯一硬 blocker 已清**。
- **gate**：`test:db`（merge 正确性 + due-must-review 不变量）+ 退役 `review_plan` 的 route/coach 引用全清 + `gen:postman` 对账。
- **expected_by**：**2026-07-18**。
- **ulw-就绪度**：✅ **最 ulw-ready 的 later-organ 交付物**。设计锁定、substrate 在场、blocker 已清。**唯一前置：先 code-核对 YUK-349 ~13d In-Progress 的真实落点**（`/api/review/plan` 仍注册 → retire 未落），跑 `writing-plans` pass 后即可 ulw。可作为第一轮 ulw 的**独立第 4 lane**（与 P0 的 A/B/C 三 lane 并行，无 conjecture 依赖）。

### P2 — 规划脑·deliberative panel（单 Opus，SELECT-not-fuse）
- **目标**：从「单引擎组流」升级到「教研团审议」——A(巩固)‖B(前沿) prompt-prior diversity、devil's-advocate critic 攻 leading draft、组长 SELECT-not-fuse（非融合）、single-round N=2、确定性 gate（仅 B1↔practice 冲突 / B3 结构变更 / cycle 重写时触发）、`PLANNING_PANEL_BUDGET.maxAgentCalls=4`、三层渐进披露、OAuth-down→降级单 planner（绝不假 dissent）。挂在 `research_meeting_nightly`/`coach_weekly` 内。
- **交付物**：slice G 清单（budget+gate / 注册 `planning_panel`+`planning_critic`+`planning_judge` agents + 只读 allowlist / `runPlanningPanel` / deliberation payload + degrade / 3 层披露 / seam 测试）。SDK 原生 subagent（per `feedback_agent_impl_sdk_native`，实现前查 SDK docs）。
- **Linear**：🚩 **无 issue → 必须开单**（建议挂 YUK-405，见第 5 节）。YUK-416（de-bias）是 deferred 变体，**非本 panel 的 gate**。
- **依赖**：① B3 落地（panel trigger gate 键 off B3 结构变更信号 + 读 B3 frontier/mastery）；② Phase 0 conjecture（capstone §2 喂 conjecture 进规划输入）。
- **gate**：seam 测试 + 确定性 gate 单测（panel 只在指定条件 fire）+ degrade 路径测试 + budget cap 断言。
- **expected_by**：**panel MVP 2026-08-22；规划脑 organ-complete 2026-08-31**。
- **ulw-就绪度**：⚠️ **scaffolding 可建 / value 须等**。slice G 具体可建，但应在 **B3 落地后 + Phase 0 conjecture 后** 起 lane。按 defer-flip：wire it live + behind 确定性 gate，defer the act 到 gated weeks。

### P3 — 教学法脑（palette + `policy()` + 3 locks + panel-SELECT step）〔最依赖 judge，最后〕
- **目标**：方法选择审议——append 到规划 panel 的一步（**非新系统/非并行 panel**）：三段 ① 确定性 `policy()` 按 type 收窄合法候选（`misconception_present`→`more_drill` 进不了候选），仅键 `θ̂ band / precision band / misconception_present / kc_is_rule_based`；② panel 在候选内 SELECT（A/B 提议、devil's-advocate 攻 `contraindicated_when`、组长 SELECT-not-fuse）；③ B5 verify 拦禁忌；方法标注落 `draft_status` proposal 进备课台，参数化 `teaching-skill.ts`/`resolveNoteSkill`。
- **交付物**：8-method 闭枚 palette `src/core/pedagogy/method-library.ts`（`worked_example`/`completion_problem`/`open_problem`/`contrasting_cases`/`refutation`/`interleaving`/`reconstruction`/`socratic`，每个 `indicated_when`/`contraindicated_when` StateGuard + `evidence_refs`）。**v1 不学 efficacy**（n=1 under-fed；schema 锁未来 method×bucket Beta）。**3 个机械 anti-learning-styles 锁 = v1 红线 gate**：① type lock（StateGuard 只键 state）② 新 `audit:no-learning-styles` CI denylist 接进 `pnpm test` ③ unit lock。
- **Linear**：🚩 **无 issue → 必须开单**（建议挂 YUK-405，见第 5 节）。
- **依赖**（三，全脑需全到）：① 规划 panel 存在（教学法是其续步）；② **misconception 信号可信**——conjecture engine（YUK-406/440）firm-up + misconception promotion 成熟，否则 R-PREC 永久塌进保守集（「always worked_example」= kill line → 回落 `teaching-skill.ts` turn-KIND only）；③ B5 verify（YUK-350，plan-then-generate + Verifier Router）。
- **gate**：`policy()` 确定性单测 + `audit:no-learning-styles` denylist + palette StateGuard 单测 + B5 禁忌拦截测试。
- **expected_by**：**全脑 2026-09-30**；**确定性 `policy()`+palette+3 locks 安全脊柱可早落 ~2026-08-29（并行，无 judge 依赖）**。
- **ulw-就绪度**：⚠️ **thin slice ✅ / brain 须等**。`policy()`+`method-library.ts`+3 locks **现在可建**（design 锁定 capstone §0，无 judge 依赖）——作为安全脊柱早 ship；panel-SELECT step gated on panel；efficacy/verify gated on YUK-350 + misconception 成熟。

### P4 — 元层（Reflection-Tree / Auto-Quest）
- **P4a · Reflection-Tree（YUK-418，Med，Phase 1）**
  - 目标：递归层——meta-conjecture 的 `evidence_refs` 指向**已确认 conjecture**（如「你的错主要是表征失败而非知识缺口」）。复用整套 conjecture 机制，零新机制。
  - 依赖：Phase 0 累够 owner-confirmed conjecture（≥N 底层确认）——**真数据 gate**。按 defer-flip：**proposal kind 现在 build+wire，只 defer flip（the rise）到 ≥N 确认**。
  - kill line：owner 罕确认 meta（觉得 over-read）→ 砍树层留扁平。
  - **expected_by 2026-09-19**（Phase 0 confirmed-conjecture 累 ~6–8 周后）。
  - ulw：✅ proposal kind 可现建（defer flip）。
- **P4b · Auto-Quest（YUK-419，Low，Phase 2+）**
  - 目标：owner 设目标 → 团队拆有序 quest arc + 维护/重排 → 规划脑 panel 填每段近期步骤。规划脑的长程生长层。
  - 依赖：规划 panel + B1(Done) + B3(YUK-349) + **goal entity YUK-143（IN-FLIGHT，~13pt 残）**。最深 distal-feedback / 最难挣信任层。缓解：quest 健康折进近期 `predicted_*`/credit，每近期步 reconcile = quest 体检；quest 永远 owner-steered proposal，绝不 autopilot。
  - kill line：owner 常 re-route / 不信月级 arc → 回落 near-term-only 规划脑。
  - **expected_by 2026-10-31**（panel ~Aug + YUK-143 成熟后）。
  - ulw：🔒 blocked-on goal entity YUK-143 + panel。**YUK-143 作独立长杆与 panel 并行推进**。

### P5 — Reconstruction-as-method（YUK-407，Low，Phase 3）
- **目标**：「不给现成题，从父节点重新派生」= **教学法脑 palette 的一个 entry**，与 matcher/retrieval 平级，由教学法脑按人/时机选。**不删题库**（「删 pre-AI organ」北极星已撤回为 novelty-purism，vision §12/§13）。
- **依赖**：`method-library.ts` 存在 + 一条**非阻塞、Phase 0 NOW 起的红线**——北极星日志红线（U1，记录可/不可从哪些 derivation-path 重构，否则未来 method 无法 backfill；保 KG 依赖结构足够丰富）。
- **expected_by**：palette entry 随教学法脑 **2026-09-30**；完整生成式 method 现实 ~**2026-11**；**Phase-0 derivation-path 日志红线 = NOW（U1，不可 defer）**。
- **ulw-就绪度**：✅ U1 日志红线现建（已在 P0）；🔒 生成式 method gated on 教学法脑 palette。

---

## 4. 关键路径 + 可并行 lane

```
B1/item_calibration (YUK-348) ✅ DONE
   │
   ├──────────────► [P1] B3 merge engine (YUK-349) ── ulw NOW ── exp 07-18 ── 独立 lane
   │                         │
[P0] 关系脑 Phase 0 (YUK-406+YUK-440)               │  (this session: PR-1 @ tlp-wt-a13)
   │   │  felt thin-slice exp 07-11 / typed-ledger exp 07-18
   │   └── confirmed conjectures 累积 ──► [P4a] Reflection-Tree (YUK-418) ── exp 09-19
   │   │                     │
   │   └── conjecture 喂输入 ┤
   ▼                         ▼
[P2] 规划脑 deliberative PANEL (单Opus; 无issue→开单) ── exp 08-22 / organ 08-31
   (gate: B3 落地 + Phase-0 conjecture; 非 gated on YUK-416)
   │                                   │
   │                                   └──► goal entity (YUK-143, IN-FLIGHT, 独立长杆)
   │                                            └──► [P4b] Auto-Quest (YUK-419) ── exp 10-31
   ▼
[P3] 教学法脑 (palette+policy()+3locks+panel-SELECT; 无issue→开单) ── exp 09-30
   (gate: panel 存在 + misconception 可信 + B5 verify YUK-350)
   │           ▲
   │           └── B5 verify Router (YUK-350, IN-FLIGHT, W0 done) ── 独立长杆
   ▼
[P5] Reconstruction-as-method (YUK-407) ── palette entry 09-30 / 生成式 ~Nov
   (Phase-0 derivation-path 日志红线 = NOW, U1, 不可 defer)
```

**关键路径（串行主链）**：`P0 关系脑信任上游 → P2 panel → P3 教学法脑`。**信任上游 = conjecture engine 问责度（A13）**——它 gate 规划脑/教学法脑的**质量**（不是 build，是 trust）：misconception 信号不可信 → 教学法脑 R-PREC 塌成「always worked_example」kill line。

**可并行 ulw lane（独立 worktree）**：
- **第一轮 ulw（NOW）**：Lane A（U1）‖ Lane B（U2→U3→U4）‖ Lane C（U5→U6 + U7 →U8）‖ **Lane D（P1 B3，核对 YUK-349 后）**——4 条并行。
- **长杆并行**（贯穿 Aug-Oct，与主链解耦推进）：**B5 verify Router（YUK-350）** + **goal entity（YUK-143）** + **教学法脑安全脊柱（`policy()`+palette+3 locks，~08-29，无 judge 依赖）**。
- **唯一真并行 organ（异构 Jury）= YUK-416 DEFERRED**——D2 stays Opus self-consistency + judge-only cap；panel 重 base 到单 Opus，不被 YUK-416 阻塞。

**不建 swarm 约束**：全程 centralized single-writer orchestrator + sleep-time pg-boss jobs（`research_meeting_nightly` / `coach_weekly`）。除 Jury（deferred）外无真并行 organ。ulw 的并行是**实现期 lane 并行**，非运行期 agent 并行。

---

## 5. tripwire 看板（expected_by + defer-flip + harness）

> vision §12 tripwire ③：**规划脑 + 教学法脑 必须带 expected_by，否则「demo 成功把惊艳永久挤出 roadmap」**。两者当前**都无 Linear issue** → 第一轮 ulw 前 owner 必须开单。

### expected_by 表（grounded dates，基线 2026-06-27）

| 组织 | Linear | expected_by | 备注 |
|---|---|---|---|
| Phase 0 felt thin-slice（U1–U4 + UI） | YUK-406 | **2026-07-11** | 启动 2-week 时钟 |
| A13 typed-ledger loop（U5–U8） | YUK-440 | **2026-07-18** | — |
| 2-week alive/kill 窗 | YUK-406 验收 | **2026-07-11 → 2026-07-25** | 跑在 live felt loop，backend-only 不启动 |
| 规划脑 B3 | YUK-349 | **2026-07-18** | — |
| **规划脑 panel MVP** | 🚩 **开新单（挂 YUK-405）** | **2026-08-22** | organ-complete 08-31 |
| **教学法脑（全脑）** | 🚩 **开新单（挂 YUK-405）** | **2026-09-30** | 安全脊柱可早落 ~08-29 |
| Reflection-Tree | YUK-418 | **2026-09-19** | — |
| Auto-Quest | YUK-419 | **2026-10-31** | — |
| Reconstruction（生成式 method） | YUK-407 | **palette entry 09-30 / 生成式 ~11** | 日志红线 = NOW |

**🚩 两个必开 Linear issue（第一轮 ulw 前，per capture gate + tripwire ③）**：
1. **规划脑 deliberative-panel MVP**——仅活在 `docs/superpowers/specs/2026-06-18-jiaoyantuan-deliberative-panel-design.md`（slice G）。YUK-416=deferred de-bias 变体、YUK-349=只 B3 半。**真正构成「规划脑」的单 Opus panel 无单 = 无法挂 expected_by = tripwire ③ 破。** 开 Phase-2 panel issue 挂 YUK-405，`expected_by 2026-08-22`（panel doc 决策 F.5「现开 epic vs 等 B3」——B3 现可执行，故现开）。
2. **教学法脑**——capstone §0 定义，**零 YUK-XXX**。tripwire ③ 显式点名 Pedagogy 须带 expected_by → 不存在 issue = 必破。开 Phase-3 pedagogy issue 挂 YUK-405，`expected_by 2026-09-30`，scope 含 v1 红线（`audit:no-learning-styles` gate + 3 机械锁）。

### defer-flip 项（build-now / flip-later + flip harness）

| 项 | 现在 build+wire | defer 的 act（the flip） | 翻转 harness |
|---|---|---|---|
| A13 prediction-score → claim-survival | U7 stub + U8 reconcile 全接 live，append `prediction_score` 事件 | score → 翻 `mastered`/label | **Rust bit-exact scoring kernel（ADR-0046）+ owner-data harness** 读 ≥N anchor 后翻；U8 测试断言 score 不动 label = 红线守卫 |
| BKT soft-track（B1 YUK-348） | 已实例化、写 `item_calibration` | soft-track 喂 θ̂/决策 | **calibration-maturity harness**（`audit:calibration` V-A1-fwd retro-validation）；n=1 红线在 owner 翻 flag 前 dark |
| 错因 retrieve-rerank L1（YUK-462） | rerank live、soft-track | rerank 喂 θ̂/p(L)/FSRS | ADR-0035 数据门 + retro-validation harness |
| 规划脑 panel | slice G wire 进 `research_meeting_nightly`、behind 确定性 gate | gate 在 gated weeks 才 fire act | 确定性 `shouldRunPlanningPanel` gate + B3 结构信号 |
| Reflection-Tree meta-conjecture（YUK-418） | proposal kind 现建 | meta 的 rise（≥N 底层确认） | Phase-0 confirmed-conjecture 计数 harness |

**dark-loop tripwire（A13 §修正-2，非协商）**：若 U3 probe-outcome 产出者被 defer，reconcile 跑空集、`prediction_score` 永不累积 = collect-without-power = 死循环，违反 `feedback_defer_flip_not_build`。**U3 是 U8 的强制前置。**

**Anki-export tripwire（YUK-406 验收，非协商）**：conjecture-with-provenance（claim + `evidence_refs` back-link + unrun probe）必须是**不可导出**的 artifact。若能完整导成 flashcard → 系统退化成「带旁白的 SRS」→ KILL。

---

## 6. ulw 启动清单

### 第一轮 ulw（NOW 前沿）—— 交给 ulw 的具体内容
**owner 前置动作（非 ulw）**：
1. **push PR-1**（`tlp-wt-a13` `6b55aecf` → 开 PR `Refs YUK-406 / Refs YUK-440`）——翻 YUK-406/440 为 In Progress。
2. **开两个 Linear issue**（规划脑 panel `exp 08-22` + 教学法脑 `exp 09-30`，挂 YUK-405）——满足 tripwire ③。
3. **预先 `git worktree add` 4 条 lane worktree**（per `feedback_omc_isolation_actually_manual`），worker prompt 第一动作强制 `pwd + git toplevel + branch` verify cwd（per `feedback_worker_first_action_verify_cwd`）。

**ulw 4 条并行 lane（每条独立 worktree + branch）**：
- **Lane A** = PR-2a（U1 日志契约）——tiny，先落。
- **Lane B** = PR-2b→2c→2d（U2 accept → U3 probe → U4 prep-desk backend）——顺序；**prompt 必带 3 个载重修正**：① U2 原子翻转 `acceptSupportedProposalKinds` exclude；② U3 canonical 事件名 `experimental:probe_result`（非旧 plan 的 `probe_served/answered`）；③ accept/probe 路径绝不写 FSRS（ND-5）。
- **Lane C** = PR-3a→3b（U5 表→U6 writer）+ PR-3c（U7 scoring，**prompt 必带：先 context7 核 ts-fsrs v5.4.1 `get_retrievability` 签名，别信 doc 的 v6**）→ PR-3d（U8 reconcile，**prompt 必带：FLIP inert，测试断言 score 不翻 label**）。**U5 pre-flight 必含 export/backup 测试**（reverse-lockstep 守卫 module-load throw，audit:schema 抓不到）。
- **Lane D** = PR（P1 B3 merge engine）——**入口前置：先 code-核对 YUK-349 ~13d In-Progress 真实落点 + 跑 `writing-plans` pass**。

**统一 gate（每 lane merge 前 + wave 分支）**：`pnpm typecheck` + `lint` + `audit:schema` + `audit:partition` + `audit:profile` + `audit:draft-status` + `test` + `build`（per `feedback_fanout_lane_full_gate`：子 lane 全量非 targeted，否则 PR CI 必红）。每 lane 完成派独立 opus reviewer 审 diff（per `feedback_separate_reviewer_per_task`）。所有 PR `Refs`（非 `Closes`）；只有 Phase 0 最后一单 `Closes YUK-406`/`Closes YUK-440`。

### 后续每轮 ulw 的入口条件（entry condition）

| 轮 | 阶段 | 入口条件（必须先满足） |
|---|---|---|
| 2 | **P0 收尾 + 备课台 UI** | 第一轮 4 lane 全 merge；触发 claude design pass（U4 handoff doc）；2-week 时钟从 UI 落地起算（07-11） |
| 2′（并行） | **P1 B3 验收** | Lane D merge；`/api/review/plan` 退役验证；reconcile YUK-349 状态对齐 code |
| 3 | **P2 规划脑 panel** | ① B3 落地 ② Phase 0 conjecture loop live（U8 merge）③ panel Linear issue 已开 ④ 查 Claude Agent SDK subagent docs（`feedback_agent_impl_sdk_native`） |
| 3′（并行长杆） | **B5 verify Router（YUK-350）+ goal entity（YUK-143）+ 教学法脑安全脊柱** | 独立可起，无 conjecture 依赖；脊柱 = `policy()`+palette+3 locks（含 `audit:no-learning-styles` 接进 `pnpm test`） |
| 4 | **P3 教学法脑（全脑 panel-SELECT step）** | ① 规划 panel 存在 ② misconception 信号可信（Phase 0 firm-up + promotion 成熟，否则回落 turn-KIND）③ B5 verify 完成 ④ pedagogy Linear issue 已开 |
| 5 | **P4a Reflection-Tree** | Phase 0 累 ≥N owner-confirmed conjecture（proposal kind 可提前在轮 4 并行 build，只 defer rise） |
| 5′ | **P4b Auto-Quest** | 规划 panel + goal entity YUK-143 成熟 |
| 6 | **P5 Reconstruction 生成式 method** | 教学法脑 `method-library.ts` 在场；U1 derivation-path 日志已从 P0 起累积（红线，已在轮 1 落） |

**2-week alive/kill 判据（P0 后，跑 live felt loop）**：ALIVE = 备课台开 ≥4 次 / ≥1 conjecture「真懂我怎么想」/ 永不像待清 backlog / confirm-rate ≥70% / 改·不要 ≥2× / ≥10 anchor 非退化。KILL = confirm-rate <50% / 开 <3 次 / owner 开始 optimize 数字（anti-guilt 破）。

---

**源 doc**：plan `docs/superpowers/plans/2026-06-18-phase0-relationship-brain.md`（8-task body）；A13 blueprint `tlp-wt-a13/docs/design/2026-06-27-a13-ts-half-design.md`（PR-1/PR-2 split + 6 critic 修正）；`docs/superpowers/specs/2026-06-18-jiaoyantuan-deliberative-panel-design.md`（panel §C/§D/§G）；`docs/superpowers/specs/2026-06-18-jiaoyantuan-integration-and-build-start.md`（capstone §0/§2/§3）；`docs/superpowers/specs/2026-06-18-private-teaching-research-team-vision.md` §11–§13（heart ruling + tripwire ③）；`docs/design/2026-06-14-product-rethink-decisions-ledger.md` §1 B1–B5；ADR-0035/0037/0038/0046。