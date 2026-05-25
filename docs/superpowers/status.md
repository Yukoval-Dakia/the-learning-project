# Project Status — 滚动总览

> 长期文档，区别于一次性 `RESUME.md`。
> 这里记的是 **项目走到了哪、下一站去哪、为什么这么走**，不是 commit log。
> 维护规则：每完成一个 Phase 就 update 一次；不维护周度进度。

**最后更新**：2026-05-25（Product Track 1 Wave 1-4 已 chain-merge 到 main；Wave 5 closeout 刷新路线图 / audit / retrospective；Track 2 proposal inbox 与 maintenance cron 已 ship）
**当前 Phase**：Product Track 1 收口完成：Teaching idle、record→proposal、Note read/edit UX、VariantVerifyTask、review polish、learning-item rollback、Phase 2C E2E 均已落地到 main。下一站应从明确 follow-up 中选择：YUK-66 teaching ask_check artifact、Living Note refinement、Note 申诉/标错、Dreaming agent 或 subject #4。
**主分支**：`main` 已推 `origin`
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
🟡  ActivityRef / ActivityKind schemas          ✅ src/core/schema/activity.ts
🟡  CapabilityManifest / CapabilityRef          ✅ src/core/schema/capability.ts
🟡  CapabilityRegistry + 默认 registry          ✅ src/core/capability/registry.ts
🟡  exact + keyword judges 注册为 capability    ✅ src/core/capability/judges/{exact,keyword}.ts
🟡  JudgeResultV2 (score + scoreMeaning + ref)  ✅ src/core/schema/capability.ts
🟡  JudgeRouter v2 delegates to registry        ✅ src/server/ai/judges/router.ts
✅  老代码路径 question_id → ActivityRef shim    review plan/due/submit 已接入 activity_ref；question_id/mistake_id 仅作 compat/storage
✅  subject identity normalization 完成度回查    src/subjects/profile.ts + tests/subjects/profile.test.ts
```

### Foundation B — SubjectProfile + Frontend Subject Awareness（ADR-0014 §3/§10 + N+1）

```
🟡  SubjectProfile 扩展（version, causeCategories, renderConfig, schedulingHints, judgeCapabilities）
                                                ✅ src/subjects/profile.ts + wenyan/profile.ts
🟡  Build-time profile validator                ✅ src/core/capability/validate-profile.ts
🟡  Frontend 读 renderConfig 渲染               ✅ PR #63 — 前端字体 / metadata / API 不再硬编码 wenyan
🟡  API 暴露 subject profile（review / learning-item）  ✅ PR #63
✅  剩余 high-use AI task prompt 抽 profileFragments  attribution / graph proposal / variant / teaching / summary / knowledge review 已走 SubjectProfile
✅  非 wenyan 第二科目 profile（math）作为 pressure test  math profile + KaTeX renderConfig + steps@1 + partial credit UI 已收口（#77/#80/#81/#82/#83/#84）
✅  第三科目 profile（physics）Foundation B acid test 1  PR #91（`13485be`）已 ship — `src/subjects/physics/profile.ts` 落地 + `src/subjects/profile.ts` 注册 + `KNOWN_SUBJECT_IDS += 'physics'` + 8 profile tests + 5 e2e smoke + framework diff = 0（acid test 1 ✓）
✅  `unit_dimension@1` P1/P2                         YUK-35 / YUK-36 已 ship — capability skeleton、router contract、mathjs accelerator、LLM fallback、4-path score 组合与 regression tests 落地
```

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
🟡  Maintenance agent               YUK-48 cron ✅ (`knowledge_maintenance_nightly` BJT 03:00); accept UI uses unified proposal lifecycle, richer ranking remains later
⬜  Dreaming lane                   daily AI 主动 proposal（reuse inbox）
⬜  Acceptance-rate / dismiss-reason 信号 → 未来 ranking
⬜  Bad accepted proposal 显式 retraction / rollback 流程
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
| 0014 | Generalized Activity + Capability Registry | `ActivityRef` 取代 question_id；judge/renderer/scheduler 注册制；SubjectProfile 纯数据 + 完全 profile-driven 归因；JudgeResult v2 连续分数；correction event 一等公民；FSRS 是 scheduling policy 之一 |

新 ADR 模板见 `docs/adr/`。改弦更张前先翻当时的 ADR 别重新论证。

ADR-0014 配套：[7 轮讨论 + 10 决议 summary](../discussion/summary.md)、[N+1 实施计划（2125 行）](plans/2026-05-18-capability-registry-foundation.md)。

---

## 3. 三大 orchestrator 落地（Phase 2 MVP）

### Phase 2A — Review Orchestrator（A 档「今天复习什么」）
- `src/server/orchestrator/review.ts` —— 规则优先（cause-base + days_overdue + lapses bonuses，capped 5）
- 队列摘要 → `ReviewIntentTask`（mimo-v2.5-pro）→ 一句话 session intent
- `/review` 页面顶部展示 intent 字幕

### Phase 2B — Learning Intent Orchestrator（B 档「我想学 X」）
- `src/server/orchestrator/learning_intent.ts` —— 硬 fence：只 case 3c（topic 节点 + children 存在），3a/3b 返 422 引导用户去 /knowledge 建图
- `LearningIntentOutlineTask` 出 1 hub + N atomic 拆分
- POST /api/learning-intents（plan）+ POST /api/learning-intents/[id]/accept
- accept 在 DB 事务里：1 hub LearningItem + N atomic + 1 hub artifact(outline ready) + N atomic artifact(pending) + rate event
- 落库后入队 N 个 `note_generate` 异步 job → `NoteGenerateTask` 填 atomic artifact.sections
- `/learning-items` 页面顶部「我想学…」输入框 + inline proposal panel；accept → 跳详情页

### Phase 2C — Active Teaching Session（A+B 合成的教学循环）
- `learning_session(type='conversation', status='active'→'ended')`，`src/server/session/conversation.ts` 单 owner 写路径
- `TeachingTurnTask` 输入 { learning_item, parent_hub_summary, atomic_sections, messages } → 输出 `{kind: 'explain'|'ask_check'|'end', text_md, suggested_next}`
- 4 routes：POST /api/teaching-sessions（start + 首 agent turn）、POST .../turn（user→agent）、POST .../end、GET ...（session + 消息列表）
- `/learn/[learning_item_id]/chat` UI：消息流 + 输入 + 结束按钮；⌘/Ctrl+Enter 发送
- 消息 = `event(action='experimental:teach_message', payload={role,text_md,turn_kind})`
- MVP 不做：streaming / tool call / inline question 落库 / idle 状态机 / VariantVerifyTask Pass 2 都留 Phase 3

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
| `/knowledge` | Loom 树 + mesh + 手动建边 | 边提议 accept/reverse/change_type/dismiss |
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
| `knowledge_maintenance_nightly` | cron @ BJT 03:00 | KnowledgeReviewTask → tree / mesh maintenance proposals |
| `prune_job_events` | cron @ BJT 04:00 | 旧 job_events 清理 |
| `prune_orphan_review_sessions` | cron @ BJT 04:15 | 6h+ started 标 abandoned（ADR-0013） |
| `session_summary` | review session end | SessionSummaryTask → summary_md |
| `note_generate` | learning-intent accept | NoteGenerateTask → atomic artifact.sections |
| `note_verify` | note_generate ready | NoteVerifyTask → artifact verification metadata / event |
| `embedded_check_generate` | note_verify pass | EmbeddedCheckGenerateTask → 1-3 embedded question rows + artifact embedded_check metadata |
| `attribution_followup` | 失败 attempt | AttributionTask → judge event |
| `variant_gen` | attribution_followup done | VariantGenTask → mistake_variant question |
| `tencent_ocr_extract` | /record vision 提交 | Tencent QuestionMarkAgent OCR |
| `echo` | E2E harness | golden 链路验证 |

---

## 7. 技术债 / 已知遗留

| 项 | 描述 | 严重度 |
|---|---|---|
| Phase 2C UI 未真机验证 | 本地 ship 完没 E2E 跑过浏览器；NAS 容器还是旧 build | **高** |
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
