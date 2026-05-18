# Project Status — 滚动总览

> 长期文档，区别于一次性 `RESUME.md`。
> 这里记的是 **项目走到了哪、下一站去哪、为什么这么走**，不是 commit log。
> 维护规则：每完成一个 Phase 就 update 一次；不维护周度进度。

**最后更新**：2026-05-17（Phase 2A/2B/2C MVP 收尾 + Provider Manager + xiaomi/mimo 迁移）
**当前 Phase**：2 主干已搭（review / learning intent / teaching 三循环全 ship）；剩 Maintenance agent + variant double-pass + Phase 3 Coach
**主分支**：`main` 已推 `origin`

---

## 1. Phase 路线图

```
✅  0   Bootstrap                          Next 15 App Router + Postgres + Drizzle + R2 落地
✅  0z  Self-host                          OrbStack 本地 + NAS 部署（Cloudflare Tunnel ingress）
✅  0d  Provider Manager                   xiaomi/mimo Anthropic-compat endpoint；7 个 task 全切
✅  1a  Subject MVP（文言文）              wenyan 数据集 + FSRS 复习闭环
✅  1b  AI surface                         /api/ai/[task] 流式 + 工具调用统一入口
✅  1c.1 Event-driven core                 event 表替代 mistake/review_event/dreaming_proposal
✅  1c.2 UI main（read + write + Vision）  /record /mistakes /knowledge /learning-items
⏳  Record model migration                   /record 统一 LearningRecord，替代 /study-log
✅  1d  Observation surface                /events/[id] / 成本带 / ADR-0013 session lifecycle / learning_session detail / /coach 周报 / SessionSummaryTask
🟡  2   Three orchestrators
   ✅ 2A  Review Orchestrator               规则优先 + ReviewIntentTask
   ✅ 2B  Learning Intent Orchestrator      我想学 X → hub+atomic LearningItem + NoteGenerateTask
   ✅ 2C  Active Teaching Session           /learn/[id]/chat → TeachingTurnTask 循环
   ✅ 错题闭环                              attribution_followup pg-boss handler（替换 next/server.after）
   ✅ Variant generation                    variant_gen handler + cause-targeted prompt + 3 层防繁殖
   ⬜ Maintenance agent                     KnowledgeReviewTask 已注册；只差 cron + accept UI
   ⬜ VariantVerifyTask Pass 2              variant 双 pass + variants_max 计数
⬜  3   Coach Orchestrator                  daily lane + 推迟 / 拆小 / 重学 plan suggestions
⬜  4   Multi-subject 扩展                  wenyan 之外的科目
```

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

新 ADR 模板见 `docs/adr/`。改弦更张前先翻当时的 ADR 别重新论证。

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
- 浏览器代码不持 API key —— 一律走 `/api/ai/[task]`，server 端读 env

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
| `/events/[id]` | 事件链浏览器 | caused_by 上游 + 下游展开 |
| `/review` | FSRS 复习闭环 | ADR-0013 session row + ReviewIntent 字幕 |
| `/learning-sessions/[id]` | 复习会话详情 + 总结 | SessionSummaryTask 落 summary_md |
| `/coach` | 周度报表 | 柱状图 + 易错知识点 + 归因分布 |

---

## 6. pg-boss 队列（生产 worker 在跑）

| 队列 | 触发 | 任务 |
|---|---|---|
| `knowledge_propose_nightly` | cron @ BJT 02:00 | 节点提议 |
| `knowledge_edge_propose_nightly` | cron @ BJT 02:30 | 边提议 |
| `prune_job_events` | cron @ BJT 04:00 | 旧 job_events 清理 |
| `prune_orphan_review_sessions` | cron @ BJT 04:15 | 6h+ started 标 abandoned（ADR-0013） |
| `session_summary` | review session end | SessionSummaryTask → summary_md |
| `note_generate` | learning-intent accept | NoteGenerateTask → atomic artifact.sections |
| `attribution_followup` | 失败 attempt | AttributionTask → judge event |
| `variant_gen` | attribution_followup done | VariantGenTask → mistake_variant question |
| `tencent_ocr_extract` | /record vision 提交 | Tencent QuestionMarkAgent OCR |
| `echo` | E2E harness | golden 链路验证 |

---

## 7. 技术债 / 已知遗留

| 项 | 描述 | 严重度 |
|---|---|---|
| Phase 2C UI 未真机验证 | 本地 ship 完没 E2E 跑过浏览器；NAS 容器还是旧 build | **高** |
| user_cause 与 agent judge 合并策略 | 当前 "user 优先"；dreaming 大量产 judge 时需重审 | 中 |
| Dependabot moderate 警告 | GitHub 报 5 条；未处理 | 中 |
| variants_max 计数表 | MVP 一道 parent 只生 1 道变式（per parent_variant_id 唯一性）；多道变式留 Phase 3 | 低 |
| `app/api/_/*` 不进 prod build | 私有路由需要从 UI 调用就得移出 `_` 前缀 | 低 |
| `.env.local` 是 symlink | `ln -s ~/.env.local`；不同机器需要重新建 | 低 |
| README.md 过时 | 仍写 Vite + Workers 栈；CLAUDE.md 有 stack note 兜底 | 低 |

---

## 8. 文档地图

| 看什么 | 去哪 |
|---|---|
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

---

## 9. 维护规则

- **何时更新**：完成一个 Phase 阶段、推上 main、确认无回滚后。**不维护周度进度**——那是 git log 的事。
- **谁负责更新**：当前会话结束前由 AI 主动 propose update；用户确认后才落地。
- **不写什么**：commit list（git log 已经在做）、bug fix 细节（commit message 已记）、临时进度（用 `RESUME.md`）、设计论证（用 ADR）。
- **stale 信号**：「最后更新」距今 ≥ 1 个 Phase（即 commit 数 ≥ 20 后还没动），下次会话开头就该 propose 一次 update。
