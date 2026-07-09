# YUK-577 — Copilot 主动开口触发线（事件驱动高置信时刻）设计

**Status**: APPROVED + owner 签字（coordinator 对抗面板 r1 + owner 决策，2026-07-07）——整体形态批准；MF1 + 关键 should 已并入；**owner 批准 nudge badge 呈现形态（UI pre-flight 过，§4）**。**cut-1（trigger ① ingestion）= 端到端含 badge UI + chat 首 turn wire**，进 TDD；cut-2（trigger ② streak）= 独立 Linear follow-up（coordinator 已建单），纯 additive。**cut-1 交付即 Closes YUK-577。** 绝不自 merge。
**Date**: 2026-07-07
**Lane**: I（worktree 独立 lane；PR branch `yuk-577-proactive-triggers`；base = origin/main `cf1ae85d`）
**Issue**: YUK-577（A3 handoff R-3 落地：事件驱动的高置信主动开口，取代盲 30s dwell timer）

**Scope（issue 硬要求复述）**：先接 2 个高置信时刻、触发偏紧——① ingestion session 完成 ② 练习同 KC 连错 ≥N。触发形态 = 前台 dock 轻提示（badge / 一行 nudge），**不弹窗不打断**，点击才展开成对话（首 turn 带触发上下文）。护栏：频控 + 静默窗；触发留痕 event（evidence-first，供 dismiss-rate 观测）；复用 YUK-178 proactive/corrective KPI 分离；**触发判定 = 确定性代码，不加 LLM 判断税**；开口内容才走 CopilotTask。

**面板 sequencing 裁定**：MVP = trigger ① only（ingestion，骑已写完成事件 + trivial 判定，近乎免费）；trigger ② streak（携 ~80% 净新风险 = 净新读模型 + partial-break + correction-exclusion + 它是练习中触发=静默窗争议本体）切 **cut-2 fast-follow**。这是**风险排序不是砍需求**——issue 的 2-3 时刻仍全交付，② 降为 fast-follow；cut-1 预留队列名常量 + 事件 schema 使 ② 纯 additive。② 时机 + UI 一起递 owner 复核。

---

## 0. 愿景锚（A3 handoff 逐字引用）

`docs/design/2026-06-28-form-axis-A3-handoff.md` R-3（:43-47）：

> ### R-3 · 主动开口=盲目 30 秒计时器，无内容驱动 nudge
>
> - 当前**唯一**的「主动开口」是 dwell 计时器：首次挂载 arm 一个 30s 计时，任意交互（鼠标 / 键盘 / 滚动 / 可见性）重置；计时到点无交互则 Drawer 自动浮开；再访立即开；本 session 内一旦 dismiss 不再自动开（`src/ui/lib/use-copilot-dwell.ts:1-16`）。
> - **反模式**：这是一个**与学习内容无关的盲目计时器**——它不知道 owner 练习卡住了、不知道刚录入完一份材料。synthesis §2.3 要的「单编排者主动性」是**内容驱动**的开口（编排者读 B3 信号判断「该说话了」），现状零实现。
> - 注：`accept-chip.ts:74` 里的 `proactive` 是 coach 后台提案的 KPI 标签（区别 corrective），**不是**前台对话的主动开口——别混淆。

同 doc §②「主动开口时机」（:81-88，功能约束的权威表述）：

> 1. **练习卡住 nudge**：owner 在练习流连续卡顿 / 长时间停留 / 反复错同一类 → 编排者主动开口提议（「要不要我换个角度讲讲这个？」/ 给提示）。……
> 2. **录入后提议**：owner 录入完一份材料（ingestion 完成）→ 编排者主动开口提议下一步（「我看了这份材料，要不要我建知识点 / 出套题？」）。
> 3. **克制约束（显式功能要求）**：主动开口必须**可忽略、不抢焦点、不强制确认**，且**单位时间有上限**（避免编排者话痨……）。owner 一旦在某场景 dismiss，同场景短期内不再主动开口。
> 4. **与被动开口的关系**：dwell 计时器（R-3）作为**保底**可保留，但内容驱动 nudge 是新的主动性主路径。两者都不得在 owner 正输入 / 正答题时打断。

同 doc :88 —— nudge **可区分形态**的显式约束（MF1 + should#7 的红线来源）：

> claude design 须给主动开口一个**与 owner 主动提问明显不同**的形态（譬如「编排者起的话头」与「我问的」在对话流里可区分），让 owner 清楚「这是它主动找我，不是我问的」。

同 doc「基础设施缺口」#1（:261）——本单的直接出处：

> 1. **内容驱动主动开口触发器**（对应 ②）：当前主动开口仅 30s dwell 盲计时器（`use-copilot-dwell.ts`）。要「练习卡住 nudge」「录入后提议」，需建 **编排者主动开口的触发信号源 + 单位时间熔断**（读 B3 信号 / ingestion 完成事件 → 决定「该开口」）。**零现实实现**。

---

## 1. 关键接地事实（grounding，全部 code-verified）

### 1.1 Ingestion 完成信号（触发时刻 ①，cut-1）

- **Session 概念**：ingestion 是 `learning_session` 的一种 type（`src/core/schema/learning_session.ts:11` + `:92`，`IngestionStatus` 独立状态机），多 asset 归属一个 session。
- **完成写点有两条路径、跨两个进程**：
  - **OCR 路径（worker 进程）**：pg-boss job `src/capabilities/ingestion/jobs/tencent_ocr_extract.ts:489` 调 `Ingestion.applyExtractionResult`（`src/server/session/ingestion.ts:196`），后者写 job_event `ingestion.extraction_completed`（`ingestion.ts:282`）+ 域 event `action='extract'`（`ingestion.ts:294`）。post-commit `boss.send` 落点 = `tencent_ocr_extract.ts:532`（core 挑战者核实的现成 fan-out 缝）。
  - **docx 路径（API 进程）**：`src/capabilities/ingestion/api/docx.ts` → `initiateDocxTextUpload`（`src/server/session/docx-ingestion.ts:65`），自写 `ingestion.extraction_completed`（`:190-195`）+ `action='extract'`（`:207`）。
- **计数诚实（should#3，两挑战者收敛）**：auto-enroll **默认 OFF**（`src/capabilities/ingestion/server/auto-enroll.ts:8`，`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` gate）。但**不能**用「收进 N 片段待复核」+ 冻结 block_count——auto-enroll flag ON 时高置信 block 会被 INSERT 成 enrolled question，「待复核」措辞 overcount，且两 job 并发 race。**采用 flag-invariant 提取事实措辞**：「我处理完《session 名》，提取到 N 个题目片段」——「提取到」断言 extraction 产出（永真，不随 enroll flag 漂移）。或读时按 `draft_status` 实算。**绝不「收进 N 题」**。「我注意到 X」是语义观察 → 需 LLM，违「确定性判定」红线 → 留给点击后的 CopilotTask 首 turn（§3.5）。

### 1.2 Attempt 事件流与同 KC 连错判定（触发时刻 ②，cut-2）

- **三个判分写点，全部同步在 Hono route 事务内**（无后台判分 job）：solo review `src/capabilities/practice/api/submit.ts:539`（`action='review'`，outcome `success|failure`）；tutor solve `server/solve-session.ts:381`（`action='attempt'`，含 `partial`）；paper submit `server/paper-submit.ts:549`（`action='attempt'`）。
- **KC 联结**：写入时把题目 KC 集冻结进 `payload.referenced_knowledge_ids`（`submit.ts:565` 等）；生产已有同形过滤先例 `knowledge-readers.ts:138-143`（`payload @>` containment）。event 表有 GIN `event_payload_idx`（`schema.ts:844-848`）——顶层 `payload @> '{"referenced_knowledge_ids":["kc"]}'::jsonb` 形式吃该索引。
- **无现成 streak 读模型**：`src/core/teaching.ts:8` 自己声明 consecutive-failure 是「future refinement requiring a new attempt-stream query」；既有 per-KC 读器（`loadRecentFailures`/`loadRecentFailureCounts`）是 failure-only 计数，看不见夹杂成功，且**漏 `action='review'`**；`mastery_state` 只累计无连错列。
- **判定可单查完成**（YES）：对某 KC 按 `created_at DESC` 取 `action IN ('attempt','review') AND subject_kind='question' AND payload @> …` 的 outcome 序列，数前导 `failure` 连长。`partial` 断流（面板 Q3 IN）。
- **静默窗信号**：`learning_session.status`（`schema.ts:745`），open 态按 type 分裂（`tutor:'active'`、`review:'started'`、`placement:'started'`……`src/core/schema/learning_session.ts:44-74`）——查「正在练习中」须按 type 白名单。

### 1.3 挂载层先例（YUK-377 方向 + enqueue-by-event + FAST 队列档）

- `src/server/boss/handlers/AGENTS.md`（YUK-377 复审后 31 条 cron 权威目录）专设「**事件触发链（enqueue-by-event，非 cron）**」一节（:48-54）：`note_generate→onReady→note_verify`、`attribution_followup→variant_gen`、`session_summary`（review session end 后 enqueue）、`copilot_run`（route dispatch → `boss.send('copilot_run')`）。同表 :44「idle=事件缺席，只能 poll」——**缺席才轮询，出现即事件驱动**。本单触发都是「事件出现」时刻 → 不开新 cron、不轮询，挂 enqueue-by-event。
- `boss.send` 双进程可用：API 进程经 getter 只 send 不 work（`src/server/boss/client.ts:93-101`）；worker 进程 handler 内 send 已有先例（`handlers.ts:207`、`quiz_gen.ts:180`）。
- **队列档 = FAST 非 AGENT（should#1）**：nudge 判定 handler 纯-DB 零-LLM；AGENT 档（`EXPIRE_AGENT` 2h + DLQ + `retryLimit=2`，`queue-config.ts`）是为**付费 LLM 记账**建的，不适用。用 **FAST 档**（`FAST_QUEUE_OPTS`，`queue-config.ts:63`；observability manifest `queue:'fast'` 先例 `manifest.ts:118`；`register-capability-jobs.ts:51` 映射）。FAST 无 retryLimit 但 pg-boss 仍在 expire/crash 时 redeliver → partial unique index 仍作 defense（§3.3）。**幂等理由不再引 AGENT 的 retryLimit 路径**。
- **跨包队列名 = queue-config.ts 导出常量（should#8）**：本单是首个 `producer(practice)+producer(ingestion)→consumer(copilot)` 三包队列，无同形先例（note_*/attribution_* 都 intra-package）；全仓 `boss.send` 均字面量、无 send-target 校验，copilot 侧改名/拼错 → job 投无 worker 队列静默 expire。**把队列名提为 `queue-config.ts` 导出常量 `COPILOT_NUDGE_EVALUATE_QUEUE`**（queue-tier 配置家，producer 与 handler 都 import，**不引 copilot server 故不违反被拒的 B**）；补启动/测试断言：所有 producer send-name ⊆ 已注册 handler 名集。

### 1.4 触发留痕 event 形态 = RESERVED + typed schema（should#2，非泛型 escape hatch）

- **升级理由（guardrail 挑战者）**：nudge event 是**承重非 report-only**——`GET /nudges` 读它驱动 user-facing 面，freq-control + expiry filter 依赖 payload keys。§先前把 YUK-573 的「report-only」条件悄换成「不进判分/mastery 主链路」是弱化了 bar。
- **机制（grading_checkpoint 先例）**：`parseEvent` union（`src/core/schema/event/index.ts:88`）里特化 experimental schema 排在通用 `ExperimentalEvent` 前；通用 hatch 的 `.refine` **排除** `RESERVED_EXPERIMENTAL_ACTIONS`（`experimental.ts:116`/:220）——故 reserved action **必须**有专属 typed schema，坏 payload 在 `parseEvent` 处 **fail loud** 而非静默退化。`experimental:grading_checkpoint`（`experimental.ts:129` + `GradingCheckpointExperimental`）是范例。
- **本单**：`experimental:copilot_nudge` 加进 `RESERVED_EXPERIMENTAL_ACTIONS` + 小 typed schema 锁承重键（见 §3.3）。dismiss/opened 两个用户侧 action 承重轻（只锚 nudge id），走通用 hatch 即可（不入 RESERVED）。
- **幂等 DB 强制先例（YUK-573 §4.2）**：partial unique index ON `event(...) WHERE action='…'`；event 表 `caused_by_event_id` 仅普通 index（`schema.ts:838`）。`audit:schema` 审列不审 index，零负担。
- **event 表当频控 ledger 先例（YUK-573 §3.2）**：`COUNT`/`NOT EXISTS` 反查——**零新表**。

### 1.5 YUK-178 proactive/corrective KPI 分离（现实现面）

- 判别子 `SuggestionKind = z.enum(['proactive','corrective'])`（`known.ts:590`）；`resolveSuggestionKind` absence≡proactive（`proposal.ts:544-552`）。排除机制 `signals.ts:185-235` corrective 对 accept-learned KPI **双侧全排除**（accept/dismiss 都不计数，cooldown 照写），rebuild 建 `correctiveProposalIds` Set 双侧跳过（`:355-436`）。accept-chip 写 `action='accept_suggestion'`（`accept-chip.ts:202-212`）。
- **对本单**：nudge 是新漏斗，**不写 `accept_suggestion`、不碰 proposal KPI**（signals.ts 不感知 nudge）——「复用分离」= 复用「kind 判别 + 独立聚合」模式，主动开口 dismiss-rate 独立指标（§3.6）。A3 R-3 注记原话就是警告别混淆两个「proactive」。

### 1.6 30s dwell timer 现状 + 点击注入既有通道

- `src/ui/lib/use-copilot-dwell.ts`：首访 30s 盲计时自动浮开；**再访 mount 即开**（localStorage visited flag）；session 内 dismiss 后不再自动开。CopilotDock 消费点 `CopilotDock.tsx:206`（dwell）+ `:549-572`（open-signal）。
- **既有跨树 open-with-context 通道**：`openCopilotWith(skillContext, prefill)` → Zustand store 发布 `CopilotOpenRequest { seq, skill_context, prefill }`（seq 单调防吞），Dock 订阅消费。
- chat wire：`POST /api/copilot/chat` 请求体 `triggered_by: 'chat' | 'chip'` + 可选 `skill_context` + `ambient_context`。**send() 把传入文本 push 成 `{role:'user', text}`（`CopilotDock.tsx:340`）**——MF1 的根因锚点：复用 chip 的 user_message 语义会把 agent 主动开口渲染成 owner 气泡，违 A3:88。

---

## 2. 设计总览（cut-1 实线；cut-2 虚线）

```
[cut-1] ingestion 完成写点(×2, worker/API)        [cut-2] 练习判分写点(×3, API)
   │ 完成后 post-commit                              ┊ outcome='failure' 时 post-commit
   └─ boss.send(COPILOT_NUDGE_EVALUATE_QUEUE, {kind:'ingestion_complete', session_id}) ┈┈┈┘
                              │（常量 import 自 queue-config.ts；无 copilot-server 依赖）
                              ▼
        copilot 包 pg-boss handler（按需 job，无 schedule，queue='fast'）
        └─ 确定性判定器 evaluateNudgeTrigger(db, input)  ← 纯 db-in / decision-out，零 LLM
           ├─ ingestion：COUNT session blocks → flag-invariant headline
           │  [cut-2] streak：单查同 KC 前导连错 ≥N（partial 断流）
           ├─ 频控（best-effort 软上限，非硬保证——TOCTOU §3.2）：event 表 NOT EXISTS/COUNT（零新表）
           ├─ 读 learning_session open 态 → payload.in_active_session（供读模型 backstop §3.2）
           └─ 通过 → writeEvent 'experimental:copilot_nudge'（RESERVED+typed；shadow flag §3.7）
                              │ caused_by_event_id → 触发源 event（evidence-first）
                              ▼
        GET /api/copilot/nudges（薄读模型：未过期未处置 + **排除 shadow=true** + 静默窗 backstop）
                              │ Dock 轮读（TanStack Query，UI 阶段，owner 签后）
                              ▼
        dock badge / 一行 nudge（不弹窗不抢焦点；绝不 auto-open drawer）
           ├─ dismiss → POST …/dismiss → 'experimental:copilot_nudge_dismissed'
           └─ click   → openCopilotWith 打开 Dock + POST 'experimental:copilot_nudge_opened'
                        → 首 turn POST /chat {triggered_by:'nudge', nudge_context:{nudge_event_id}}
                          **无 user_message**（MF1）→ 服务端回读证据 → **agent 侧生成首 turn**
```

红线：触发判定全程零 LLM；留痕 `caused_by_event_id` 链触发源；nudge 绝不 auto-open drawer；shadow 期照跑照写、只 gate surfacing。

---

## 3. 设计决策（面板判词已并入；标注裁定来源）

### 3.1 触发器架构（Q1：A 确认 / handler on FAST）

**挂载层 = enqueue-by-event（架构 A），queue='fast'。** C（读侧现算）丢「fired-but-never-surfaced」的 ignored KPI 可测性 + 退化成非幂等 GET 副作用 → 拒；B（跨包 import copilot 判定器）反向依赖 copilot server → 拒。

- **enqueue 条件**：ingestion 两完成写点各 send 一次（cut-1）；[cut-2] attempt 写点仅 `outcome='failure'` 时 send。payload 只带定位 id（`{kind, session_id}` / `{kind:'attempt_failure', attempt_event_id}`），判定事实由 handler 从 event 表回读——evidence-first + 防 payload 漂移。
- **必须 post-commit send**：`boss.send` 走自己连接，事务内 send 会让 job 跑在未提交数据前。send 放事务块之后。
- **登记面**：copilot manifest 增量——`jobs.handlers` +1（`copilot_nudge_evaluate`，`queue:'fast'`）、`events.actions` +3（§3.3）、`api.routes` +2（§3.6）。practice/ingestion 只多 send 语句 + import 常量，零登记面变化。
- **确定性判定函数测试面**：`src/capabilities/copilot/server/nudge-triggers.ts` 导出 `evaluateNudgeTrigger(db, input): Promise<NudgeDecision>`（`{ fire:false, reason } | { fire:true, event }` 判别式，reason 枚举利于测试/观测）。纯 db-in/decision-out，env 由 handler 注入 → db.test 直测：种子 event 序列 → 断言 fire/reason。

### 3.2 频控 / 静默窗（Q4 参数保留但先 SHADOW 校准；Q7 + should#4/#5）

**存储 = event 表当 ledger（零新表）。参数保留但值经 SHADOW 期校准后再 surface（§3.7）。**

> **诚实标注（should#5）**：DAILY_MAX / (cut-2) KC_COOLDOWN / dismiss-fuse 是 **SELECT-then-write 软上限**，queue 并发 + 重投下有 TOCTOU（两 job 都读 COUNT<max 都写 → 超 cap by 1）。单用户下 over-fire by 1 低危可逆，但**本 doc 明记为 best-effort 软上限，非硬保证**。**partial unique index 只保 per-source 幂等（同一 caused_by 不双写），不保频控。**

| 护栏 | 参数（默认，env） | 判定查询 | scope |
|---|---|---|---|
| 全局每日上限 | `COPILOT_NUDGE_DAILY_MAX=3` | 当日（Asia/Shanghai）`action='experimental:copilot_nudge'` 非 shadow COUNT ≥ max → 不发 | cut-1 |
| 同 ingestion session 去重 | 恒一次 | `caused_by_event_id` partial unique index（DB 强制） | cut-1 |
| dismiss 尊重 | ingestion=kind-wide 当日熔断 | 当日存在 `…_dismissed`→其 caused_by nudge 同 kind → 该 kind 当日不再发 | cut-1 |
| 过期自沉（A3「可静默消失」） | `payload.expires_at=+24h` | 读模型过滤过期；不删行（留痕永存供 KPI） | cut-1 |
| [cut-2] 同 KC 冷却 | `KC_COOLDOWN_HOURS=24` | 窗内同 KC nudge 存在 → 不发 | cut-2 |
| [cut-2] dismiss 尊重（streak） | **per-subject_id(per-KC)** 非 kind-wide（NIT 10.ii） | dismiss KC-A 不熔断其它 KC streak（守 A3「同场景」） | cut-2 |

**静默窗（Q7：don't-suppress-at-create + 呈现结构性不打断 + 读模型 backstop）**：
1. **不在创建侧抑制**——streak 天然发生在练习 session 中，创建侧「有 open session 就压制」会杀死练习中最高价值的 streak nudge，正面违 A3；A3 原话是「不得在 owner 正输入 / 正答题时**打断**」，badge 不打断。
2. **结构性保证**：nudge 只允许 badge/一行提示，**永不 auto-open drawer / 弹窗 / 抢焦点**（dwell 的 auto-open 通道不接 nudge）。db/route 测试断言 nudge 绝不 auto-open drawer。
3. **读模型 backstop（should#4，从旁注升为必须）**：判定器已算出的 `in_active_session` 必须被消费——`GET /nudges` 能对**练习中 + interrupt-sensitive kind** 做 defer/flag（读时按当前 open session 过滤或降级呈现），而非算了不用。cut-1 的 ingestion kind 非 interrupt-sensitive，但 backstop 机制随 cut-1 建好（in_active_session 写入 + 读模型 filter 骨架 + 测试），cut-2 streak 直接复用。

### 3.3 触发留痕 event 形态（should#2：RESERVED + typed）

`experimental:copilot_nudge` 加进 `RESERVED_EXPERIMENTAL_ACTIONS`（`experimental.ts:116`）+ 专属 typed schema（仿 `GradingCheckpointExperimental`，`index.ts` union 排通用 hatch 前）：

```ts
// typed schema —— 锁承重键（parseEvent fail-loud on bad payload）
NudgeExperimental = z.object({
  action: z.literal('experimental:copilot_nudge'),
  actor_kind: z.literal('agent'), actor_ref: z.literal('copilot_nudge_trigger'),
  subject_kind: z.enum(['learning_session', 'knowledge']),  // ingestion→session；[cut-2] streak→KC
  subject_id: z.string(),
  caused_by_event_id: z.string(),                            // 触发源 event，证据链
  payload: z.object({
    kind: z.enum(['ingestion_complete', 'kc_wrong_streak']), // 承重：读模型分派
    headline: z.string(),                                    // 承重：surfacing 文案（确定性模板，零 LLM）
    expires_at: z.string(),                                  // 承重：过期 filter
    shadow: z.boolean(),                                     // 承重：surfacing gate（§3.7）
    in_active_session: z.boolean(),                          // 承重：静默窗 backstop（§3.2）
    evidence: z.record(z.string(), z.unknown()),             // loose：session_id/block_count/[cut-2]streak_n/kc_id/attempt_event_ids
  }),
})
// dismiss / opened —— 承重轻，走通用 experimental hatch（不入 RESERVED）
{ action:'experimental:copilot_nudge_dismissed', actor_kind:'user', actor_ref:'self',
  subject_kind:'event', subject_id:nudgeEventId, caused_by_event_id:nudgeEventId, payload:{} }
{ action:'experimental:copilot_nudge_opened',    actor_kind:'user', actor_ref:'self',
  subject_kind:'event', subject_id:nudgeEventId, caused_by_event_id:nudgeEventId, payload:{} }
```

**幂等 = DB 强制（partial unique index）**：FAST 队列无 retryLimit 但 expire/crash 仍 redeliver + 无 singleton 并发投递 → handler 重跑会重写 nudge 行。手写 migration：

```sql
CREATE UNIQUE INDEX event_copilot_nudge_unique_idx
  ON event (caused_by_event_id)
  WHERE action = 'experimental:copilot_nudge';
```

写入捕 23505 当已发跳过。**[cut-2] multi-KC 幂等（should#6）**：一道 2-KC 题失败把 KC-A/KC-B 都推到 streak≥N 时，两条 nudge 的 `caused_by_event_id` 同一，第二条撞 23505 被静默丢。cut-2 二选一写死（doc 先记，实施时定）：**(a) handler「最高 streak KC 胜出」单选一 KC**（不靠 23505 兜）；或 **(b) 唯一键改 `(caused_by_event_id, payload->>'kc_id')`**。§6 补 multi-KC 共触发测试。cut-1 ingestion 单 session 无此问题。

`ingest_at` 预填 opt-out memory outbox（observe-only 先例）。

### 3.4 会话工作记忆前置的回应（A3 缺口 #4）

A3 把「刚 dismiss 哪条」列为克制承重前置（正式共写表）。本设计**不建该表、也不被它阻塞**：dismiss 本身是 event（§3.3），克制查询直接反查 event 表。正式表若日后落地（synthesis §2.3 delta ①），dismiss 记忆可平移；MVP 不为它扩 scope。

### 3.5 nudge 点击 → 首 turn 触发上下文注入（MF1 修复 + Q2）

**MF1（must-fix）**：§先前定「首 turn 用 `user_message=nudge headline`（与 chip 同构）」——但 `send()` 把传入文本 push 成 `{role:'user', text}`（`CopilotDock.tsx:340`）。chip 是 owner 主动点，nudge 是 **agent 主动开口**；复用 chip 语义会把 agent-initiated headline 渲成 owner 的 user 气泡，对话流首条变「owner: \<headline\>」——直接违 §0/§4① 逐字引用的 A3:88（编排者话头须与 owner 提问可区分），且 wire 抢跑了本该 design pass 决定的「可区分形态」还抢错方向。

**修正数据流（cut-1 实现：client-side agent 开场，无 chat.ts 服务端改动）**：
1. 点击「看看」→ UI 调既有 `openCopilotWith` 打开 Dock（badge→drawer 展开是用户主动动作，不违静默窗）+ POST 写 `…_opened`。
2. **nudge headline 由确定性触发器（`copilot_nudge_trigger` actor）authored——它 IS agent 的开场话头**，client 侧渲染为对话首条 agent 消息（**非 owner user 气泡**，满足 MF1 / A3:88）。**绝不**把 headline 当 `user_message` 发（MF1 根因：`send()` 会 push 成 owner 气泡，`CopilotDock.tsx:340`）。
3. Dock 把 ingestion session 注入既有 `ambient_context`（`focused_entity:{kind:'learning_session', id:session_id}`，`CopilotOpenRequest` +可选 `nudge` 字段携带）——用户**回复**时正常 chat 流带上下文运行，agent 知道这是关于刚录入的材料。
4. **cut-1 边界**：LLM 只在用户回复后被调（触发判定 + 开场 headline 均零 LLM，守得更严）。**服务端 `triggered_by:'nudge'` + first-turn LLM 主动 elaboration（「我注意到 X」由 agent 首 turn 主动说）= 高风险 chat 管线手术**（`user_message` 是 required `min(1)`，SSE/event 持久化全假设它在），**deferred 为 follow-up**——cut-1 不改 chat.ts。理由：MF1 的承重要求（无 owner 气泡 + agent 话头可区分）client-side 已满足；server-side 主动 elaboration 是增益非必需，低风险优先。
- `GET /nudges` 行的 `headline` = badge 展示 + client agent 开场文本，**绝不作 chat user_message**。
- `CopilotOpenRequest` +additive 可选 `nudge?:{ nudge_event_id, session_id }`——`use-copilot-dwell.ts` store 最小类型扩展。
- **one-shot 焦点（Codex P2-1 修）**：nudge 注入的 `learning_session` ambient focus **只作用于点击后第一轮**——首轮成功后清（失败保留供「重试」，同既有 one-shot skill clear 规则）。否则后续任何自由提问都会继续携带旧 session ref 直到关抽屉。逻辑抽为纯 helper `resolveTurnAmbientFocus` + `nextNudgeSessionAfterTurn`（`ui/nudge-focus.ts`，unit-tested）。

### 3.6 dismiss-rate 观测与 YUK-178 KPI 分离（Q5：admin 端点 CUT）

- **分离原则**：nudge 漏斗**不写** `accept_suggestion`、不进 proposal accept-learned KPI，主动开口 dismiss-rate 独立计（正如 corrective 被双侧全排除出 proactive KPI）。
- **指标**：per kind，`dismiss_rate = dismissed / (opened + dismissed)`；`ignored`（过期无处置）单列（A3「可静默消失」是合法结局）。全由三 action 的 event 聚合可得。
- **暴露面（Q5：admin 端点 CUT 出 MVP）**：n=1 下 dismiss_rate 从三个 event action 经既有 `query_events` copilot tool 或 SQL 可算，建 `GET /api/admin/copilot-nudges` 不 gate wire 且无数据可看。**MVP 不建端点**——首轮校准读用 `query_events`/SQL/shadow 行。端点留 §8 follow-up（数据攒够再建）。
- **companion 写幂等（Codex P2-2 修）**：`opened`/`dismissed` 写点 per-nudge 至多一条——网络重试 / 快速双击不得重复写 event（读模型用 EXISTS 隐藏 nudge，界面看不出，但 opened/dismissed **KPI 会重复计数**，违诚实计数红线）。手写 migration `0061` 加两条 partial unique index `ON event(caused_by_event_id) WHERE action='experimental:copilot_nudge_{opened,dismissed}'`（各一，因一 nudge 可合法既 opened 又 dismissed）；路由捕 23505 → 返回 `{ok:true, deduped:true}` 不新写。同 cut-1 nudge 幂等模式。

### 3.7 默认开关（Q6：SHADOW 不用 blind-OFF）

**`COPILOT_NUDGE_ENABLED` 只 gate user-facing surfacing，不 gate 判定/写入。**（theta-grid SHADOW 先例）
- OFF（默认）时：handler **仍跑** `evaluateNudgeTrigger` + 写证据 event，但打 `payload.shadow=true`。
- `GET /nudges` **必须排除 `shadow=true`**（免翻 flag 时倒出 24h backlog）。
- owner 读 shadow 行（SQL/query_events）校准 `STREAK_N`/`DAILY_MAX`/其它参数后，再翻 surfacing。
- **收益**：比「翻 flag 才发现参数一天触发 30 次或从不触发」强，且直接消解 dark-PR 的「建成不通电」隐患——**shadow 行 = 暗窗期 live consumer**。
- **频控与 shadow 的关系（澄清）**：§3.2 软上限（dailyMax / dismiss-fuse）只约束**可见**（`shadow=false`）写入——COUNT 也只数非 shadow 行。shadow 期**故意不施加**这些护栏，以便观测真实触发率；防 shadow 行本身暴涨靠 per-source partial unique index（同一 extract 不双写）+ owner 读 shadow 行校准参数后再翻 surfacing。若把 soft-cap 套到 shadow 期，要么永远不触发（COUNT 仍只数非 shadow），要么改成数 shadow 行——后者会压扁观测窗，违背 SHADOW 校准目的。

### 3.8 30s dwell timer 处置（demote 不 remove + should#9 共存决定）

- **demote 不 remove**：A3 §②4 逐字「dwell 计时器作为**保底**可保留，但内容驱动 nudge 是新的主动性主路径」+ 项目 Product 纪律「pre-AI 功能默认 demote 不 remove」。物理删 `use-copilot-dwell.ts` auto-open 是 owner 决策，不在本 lane。
- **共存 create-time 决定（should#9，现在定非 UI-phase 开放题）**：现状 dwell 是唯一 auto-open 面（它开 drawer，content nudge 只 badge）。**裁定：有 pending fresh nudge（未过期未处置）时，抑制盲 dwell 的 auto-open**——理由：既然有内容驱动的话头待读，盲计时器再把空 drawer 浮开是噪音叠加，且「内容驱动是主路径、盲 timer 是保底」意味着保底应让位主路径。实现层：dwell auto-open 前查 nudge pending（读既有 `GET /nudges`，UI 阶段接线，owner 签后随 badge 一起做）。这不删 dwell、不改其 30s/visited/dismiss 语义，只加一个「有话头则不空浮」的让位判断。

---

## 4. UI design pre-flight（CLAUDE.md 硬纪律）——**owner 已批准（2026-07-07）**

> owner UI pre-flight 过，nudge badge 呈现形态**批准**，进 cut-1。以下为 pre-flight 记录 + 落地约束。

**① design doc 覆盖（逐字引用）**：
- 可区分形态（A3:88，§0 已全文引）：「编排者起的话头」与「我问的」在对话流里可区分——nudge 走 agent-actor tone（非 alert 红），是**邀请不是错误**。
- 被忽略态（A3 故障态表 :122）：「**主动开口被忽略**……可静默消失，不堆积、不反复弹同一条。」——× dismiss 写 dismissed event；过期读模型静默过滤。
- 克制（A3:85）：可忽略、不抢焦点、不强制确认、单位时间有上限。
- **owner 批准的形态**（此前无视觉稿覆盖，owner 拍板轻实现）：见下③两落点 + 确定性文案模板。

**② 组件类型**：既有 drawer/dock 的**增量修饰**（launcher 角标 + summary 顶行 nudge 条 + 点击 wire）。非 modal / route / page / 弹窗。

**③ Lane H 隔离契约（should#7——真正的撞车面；owner 已锁定两落点）**：`:206`(dwell hook)/`:549-572`(open-signal) 本就与 Lane H 不撞；真撞面是 **badge JSX 渲染落点**。owner 锁定 nudge 呈现只落两处，**都与 Lane H 的 footer/composer(`615-668`)+进度区 disjoint**：
- ① **收起态 launcher Button(`:674-682`)** 的 count 角标/圆点（agent-actor tone，**非 alert 红**——邀请非错误）；
- ② **drawer 开时 summary slot 顶部(~`:577`，`daily_focus` 之上)** 一行可 dismiss nudge 条：**agent-tone 左边框 + 图标 + 一行 headline + 「看看」/「×」**。「看看」→ openCopilotWith 打开 + chat 首 turn（§3.5 MF1）；「×」→ dismiss（写 dismissed event）。
- **文案 = 确定性模板零-LLM**：ingestion「我处理完《{source_document.title}》，提取到 {n} 个题目片段」（title 空则降级「我处理完你上传的材料，提取到 {n} 个题目片段」，去《》）。**绝不「收进 N 题」**（should#3 flag-invariant）。
- **明令不碰** footer/composer(`615-668`) + 消息列表。**两 lane 触非相邻 hunk。⚠️ Lane H 正在重做（copilot 默认即 agent），其进度组件将长在消息渲染区/footer——本 badge 严格钉死 launcher 角标 + summary 顶，物理隔开，后合者 rebase 无冲突。**

**④ UI touch 文件清单（cut-1，owner 已批准）**：
- 修改 `src/capabilities/copilot/ui/CopilotDock.tsx`——badge 渲染（仅 ①②两落点）+ 点击→首 turn 发送 + dwell 让位判断（§3.8）。
- 修改 `src/ui/lib/use-copilot-dwell.ts`——`CopilotOpenRequest` 增可选 `nudge` 字段（类型层 additive）+ dwell auto-open 前查 pending nudge。
- 新建 `src/capabilities/copilot/ui/useCopilotNudges.ts`——TanStack Query 读 `GET /api/copilot/nudges`（新文件，零撞车）。

---

## 5. 改动文件清单

### cut-1（trigger ① ingestion，本 PR，后端 only）
**新增**
- 本 design doc（已在）
- `src/capabilities/copilot/server/nudge-triggers.ts` — `evaluateNudgeTrigger` + 频控查询 + flag-invariant headline 模板（ingestion kind）
- `src/capabilities/copilot/server/nudge-config.ts` — env 解析（`COPILOT_NUDGE_ENABLED` surfacing gate + `DAILY_MAX` + `EXPIRES_HOURS`，全默认值）
- `src/capabilities/copilot/jobs/copilot_nudge_evaluate.ts` — pg-boss handler（**不**首行 kill——shadow 期照跑；surfacing 由 event `shadow` flag + 读模型 gate）
- `src/capabilities/copilot/api/nudges.ts` — `GET /api/copilot/nudges`（排除 shadow + 静默窗 backstop）+ `POST /api/copilot/nudges/[id]/dismiss` + `POST …/[id]/opened`
- `drizzle/00XX_copilot_nudge_unique.sql` — partial unique index（§3.3）
- 各 `*.unit.test.ts` / `*.db.test.ts`

**修改**
- `src/core/schema/event/experimental.ts` — `experimental:copilot_nudge` 进 RESERVED + `NudgeExperimental` typed schema；`_dismissed`/`_opened` 走通用 hatch
- `src/core/schema/event/index.ts` — union 注册 `NudgeExperimental`（排通用 hatch 前）
- `src/server/boss/queue-config.ts` — 导出 `COPILOT_NUDGE_EVALUATE_QUEUE` 常量（should#8）
- `src/capabilities/copilot/manifest.ts` — events.actions +3、jobs.handlers +1（`queue:'fast'`）、api.routes +3（**Lane H 撞车面，additive 块，后合者 rebase**）
- `src/capabilities/ingestion/jobs/tencent_ocr_extract.ts`（`:550` auto_enroll send 旁）+ docx 完成收口处（`docx-ingestion.ts:224` fan-out 旁） — post-commit `boss.send(COPILOT_NUDGE_EVALUATE_QUEUE, {kind:'ingestion_complete', session_id})`（各 1-2 行；import 常量；独立 try/catch swallow+log，与 auto_enroll 失败隔离）
**UI（owner 已批准，§4）**
- 修改 `src/capabilities/copilot/ui/CopilotDock.tsx` — badge 两落点（launcher 角标 `:674-682` + summary 顶行 `~:577`）+「看看」→ openCopilotWith（headline 作 agent 开场 + 把 ingestion session 注入既有 `ambient_context`）+「×」→ dismiss + dwell 让位（§3.8）
- 修改 `src/ui/lib/use-copilot-dwell.ts` — `CopilotOpenRequest` 增可选 `nudge` 字段 + dwell auto-open 前查 pending nudge
- 新建 `src/capabilities/copilot/ui/useCopilotNudges.ts` — TanStack Query 读 `GET /api/copilot/nudges`
- 启动/测试断言：producer send-name ⊆ 注册 handler 名集（should#8）
- `postman/api-endpoints.json` + `pnpm gen:postman`

### cut-2（trigger ② streak，fast-follow，owner 签后）——纯 additive
- `nudge-triggers.ts` +streak 判定分支（单查 + partial 断流 + multi-KC 幂等 should#6）
- practice 三判分写点 post-commit send（`outcome='failure'`；**NIT 10.iv：hoist outcome/referencedKnowledgeIds 出事务闭包**，工时上调）
- `nudge-config.ts` +`STREAK_N`/`KC_COOLDOWN_HOURS`
- KC-cooldown query（**NIT 10.i：`subject_kind='knowledge' AND subject_id=kcId` 走 `event_subject_idx`**，非 `payload->>'kc_id'`——现 payload 里 kc_id 在 `evidence.kc_id` 下查不中且不走索引）
- streak dismiss-fuse **per-subject_id**（NIT 10.ii）
- correction/appeal 排除 **DEFER**（Q3 accepted risk，见 §7）

### （UI + chat 首 turn 已并入 cut-1——owner 2026-07-07 UI pre-flight 批准，见上）

**不碰**：`src/ai/registry.ts` / `src/server/ai/runner.ts`（Lane F 面）；`use-copilot-dwell.ts` 的 dwell 逻辑本体；judge/mastery/θ̂ 全链路。

## 6. 测试计划（TDD 先 RED）

### cut-1
- **判定器（db）**：ingestion COUNT blocks → headline 断言（flag-invariant 措辞、含 session 名 + block 数）；频控（daily max、session 去重 23505、dismiss kind-wide 熔断）各一 case；expires；`in_active_session` 计算正确；reason 枚举。
- **handler（db）**：ingestion_complete 端到端（种子 session+blocks → send payload → handler → nudge 行断言）；redeliver 双投不双写（unique index）；shadow flag 默认写 true（ENABLED 未设）。
- **红线（db）**：运行后除三 nudge action 外零新 event action；mastery/θ̂/FSRS/draft_status 零变化。
- **typed schema（unit）**：坏 payload（缺承重键）在 `parseEvent` fail-loud；RESERVED action 不被通用 hatch 收。
- **路由（db）**：GET 排除 shadow=true；GET 过期过滤；**GET 静默窗 backstop（in_active_session interrupt-sensitive kind defer）**；**GET 断言 nudge payload 无 auto-open 语义**；dismiss/opened 写行 + 幂等；chat `triggered_by:'nudge'` **无 user_message** + 注入含确定性证据（mock CopilotTask 断言注入文本 + 断言首条非 user headline 气泡）。
- **queue-name 断言（unit）**：producer send-name ⊆ handler 名集（should#8）。
- **migration**：`pnpm test:migration` 收 index DDL。
- 全量 gate：`pnpm typecheck / lint / audit:schema / audit:partition / audit:profile / audit:draft-status / audit:draft-status-reads / test / build`。

### cut-2（owner 签后补）
streak 恰 N/N-1；成功打断；partial 断流；跨题同 KC；review+attempt 双 action；**multi-KC 共触发幂等**；per-KC dismiss-fuse；KC-cooldown index 命中。

## 7. 面板判词 ledger（8 问已裁 + MF + should，本 doc 已并入）

- **MF1**：chat wire 去 user_message，agent 侧首 turn（§3.5）。✅并入
- **Q1**：架构 A + handler on FAST（§3.1 / should#1）。✅
- **Q2**：`triggered_by:'nudge'` + `nudge_event_id`，无 user_message（§3.5）。✅
- **Q3**：partial 断流 IN；**correction/appeal 排除 DEFER 出 MVP**（bounded harm ≤1 rate-limited nudge，不焊 `NOT EXISTS action='correct'` 进承重 streak query；随 ② 硬化补，**记为 accepted risk**）。cut-2。
- **Q4**：参数保留但**先 SHADOW 校准再 surface**（§3.2 / §3.7）。✅
- **Q5**：admin dismiss-rate 端点 **CUT 出 MVP**（§3.6）。✅
- **Q6**：**SHADOW 不用 blind-OFF**（§3.7）。✅
- **Q7**：don't-suppress-at-create + 非侵入 badge + **读模型 backstop 必须**（§3.2 / should#4）。✅
- **Q8**：**①-first MVP** + badge 落点隔离契约（§4 / should#7）；交付形态 owner 签。✅
- **should 1-10**：queue FAST(§1.3)、RESERVED+typed(§3.3)、计数诚实(§1.1)、backstop(§3.2)、软上限诚实(§3.2)、multi-KC 幂等(§3.3 cut-2)、badge 隔离(§4)、queue-name 常量(§1.3)、dwell 共存(§3.8)、NIT i-iv(§5 cut-2 / §3.2)。✅并入

## 8. Out of scope / follow-ups（落 Linear）

- **admin dismiss-rate 端点**（Q5 CUT）——数据攒够后建（`GET /api/admin/copilot-nudges`，仿 `conjecture-scores.ts`）。
- **correction/appeal 排除进 streak query**（Q3 DEFER，accepted risk）——随 cut-2 硬化时补 `NOT EXISTS action='correct'`。
- **既有 per-KC failure 读器漏 `action='review'` 且不滤 correction**（`loadRecentFailures`/`loadRecentFailureCounts`）——既有面瑕疵，单开记录。
- **「练习卡顿/长时间停留」触发**（A3 ②1 另半句）——需前端停留信号，非纯事件匹配，后续单。
- **nudge payload 稳定后**——typed schema 已锁承重键；promote/收敛按 ADR-0011 路径。
- **正式会话工作记忆表**（A3 缺口 #4）——本单以 event 反查绕开。
- **dwell auto-open 物理删除**——owner 决策（§3.8 只做让位不删）。

## 9. cut-1 / cut-2 边界（sequencing 契约）

cut-1（本 PR）交付端到端 wire 于最低风险路径（ingestion）：producer send → FAST handler → 确定性判定 → RESERVED+typed event + unique index + shadow gate → 读模型（排 shadow + backstop）→ KPI 分离 event。**cut-2 纯 additive**：streak 判定分支 + practice producer send + streak 参数/幂等——不改 cut-1 已定的队列名常量、事件 schema、读模型骨架。UI 全部 owner 签后。**② 降 fast-follow 是风险排序不是砍需求，issue 的 2-3 时刻仍全交付。**
