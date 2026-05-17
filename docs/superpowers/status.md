# Project Status — 滚动总览

> 长期文档，区别于一次性 `RESUME.md`。
> 这里记的是 **项目走到了哪、下一站去哪、为什么这么走**，不是 commit log。
> 维护规则：每完成一个 Phase 就 update 一次；不维护周度进度。

**最后更新**：2026-05-17
**当前 Phase**：1d 收尾 + 2 开局（dreaming edge + maintenance 待）
**主分支**：`main` clean、未推 `origin`（本次会话 11 个 commit）

---

## 1. Phase 路线图

```
✅  0   Bootstrap                          Next 15 App Router + Postgres + Drizzle + R2 落地
✅  0z  Self-host                          OrbStack 本地 + NAS 部署（Cloudflare Tunnel ingress）
✅  1a  Subject MVP（文言文）              wenyan 数据集 + FSRS 复习闭环
✅  1b  AI surface                         /api/ai/[task] 流式 + 工具调用统一入口
✅  1c.1 Event-driven core                 event 表替代 mistake/review_event/dreaming_proposal
✅  1c.2 UI main（read + write + Vision）  /record /mistakes /knowledge /learning-items /study-log
✅  1d  Observation surface                /events/[id] ✅ + 成本带 ✅ + ADR-0013 session lifecycle ✅ + learning_session detail ✅ + /coach 周度报表 ✅ + SessionSummaryTask ✅；UI 全部按 design 语义 class 迁移
🟡  2   Dreaming agent                     node propose nightly ✅；edge propose nightly ✅；Maintenance agent / variant gen 待
⬜  3   Note artifact + Quiz JudgeRouter   AI 生 / 用户改 / embedded check
⬜  4   Multi-subject 扩展                 wenyan 之外的科目
```

---

## 2. 关键决策（ADR 索引）

| ADR | 主题 | 决议 |
|---|---|---|
| 0006 v2 | 数据骨架 | 全部走 `event` 表 + projection 投影；artifact 留 C 档 AI 产出 |
| 0007 | 单用户 | 不做 per-user auth；`x-internal-token` 中间件兜底 |
| 0008 | LearningSession | 多类型 session（review / record / dreaming）共用一张表 |
| 0010 | 知识 mesh | knowledge_edge 取代 prerequisite/tag 体系 |
| 0011 v2 | tool_use + suggestion + edge events | agent 的所有写入都过 event |
| 0012 | mastery view | DROP 双层 mastery；改用 derived view |
| 0013 | /review session lifecycle | eager 开 session + sendBeacon close + 6h orphan cron 兜底 |

新 ADR 模板见 `docs/adr/`。改弦更张前先翻当时的 ADR 别重新论证。

---

## 3. 当前活页（in flight 或刚结尾）

### ✅ 刚收尾：5 模块文档刷新（39ce567）
mistakes / learning-items / progress / quiz / lanes / notes 全部加 §0 实施现状头表，
立即可见哪些设计概念已落地、哪些是 Phase 2/3 sketch。

### ✅ 收尾：Phase 1d Observation
- ✅ `/events/[id]` 事件链浏览器（design polish 完成）
- ✅ `/today` 成本带（BJT 0 点结算）+ 按 design 重写 KPI strip / lanes
- ✅ ADR-0013 review session lifecycle：`/review` eager 开 session + sendBeacon close + 6h orphan cron
- ✅ `/review` 页按 design ReviewScreen 重写：`.review-stage` / `.btn-rating` 三段式
- ✅ `learning_session` detail 页 + GET /api/learning-sessions/[id]
- ✅ `/coach` 周度报表 + GET /api/review/weekly（每日柱状图 + 易错知识点 + 归因分布）
- ✅ SessionSummaryTask：session close → pg-boss enqueue → haiku 生成 ≤120 字总结 → summary_md

### ⬜ 未启动 Top 3（按推荐顺序）
1. **Phase 2 Maintenance agent**：reparent / merge / split / archive 的自动提议（当前只有节点 + 边 propose）
2. **Variant generation**：根据 mistake propose 变式题
3. **测试基础设施修复**：`src/server/boss/client.test.ts` 在全套 pnpm test 中偶发 "too many clients"（pg-boss 内部 poller 累积），需要 explicit cleanup 或限制 max_connections

### ✅ 本会话累计
- Phase 2 Dreaming edge proposer（KnowledgeEdgeProposeTask + nightly cron）
- ADR-0013 + 实施：`/review` eager 开 session + sendBeacon close + orphan cron
- LearningItem hub + atomic：parent_learning_item_id 激活 + cycle prevention + 详情页
- UI 全套对齐 design：`/today` `/review` `/events/[id]` + 新增 `/learning-sessions/[id]` `/coach`
- SessionSummaryTask 后端：pg-boss enqueue → haiku 生成 → summary_md 落库

---

## 4. 当前可用 UI 路径

| 路径 | 功能 | 备注 |
|---|---|---|
| `/today` | KPI + 成本带 | BJT 每天 0 点重算 |
| `/record` | 手动错题 + Vision OCR | OCR 需 `.env` creds |
| `/mistakes` | 错题列表 + user_cause | cause 写为 experimental:user_cause event |
| `/learning-items` | 6 状态机 + 知识点 chips | pending/in_progress/done/resting/dismissed/archived |
| `/knowledge` | Loom 树 + mesh + 手动建边 | 边提议 accept/reverse/change_type/dismiss |
| `/knowledge/[id]` | 知识点详情 | edge proposals + 相邻边 |
| `/study-log` | 5 kind 学习日志 | 写作 / 总结 / 错题集 / 工具 / 反思 |
| `/events/[id]` | 事件链浏览器 | caused_by 上游 + 下游展开 |
| `/review` | FSRS 复习闭环 | 暂不开 learning_session row |

---

## 5. 技术债 / 已知遗留

| 项 | 描述 | 严重度 |
|---|---|---|
| user_cause 与 agent judge 合并策略 | 当前 "user 优先"；dreaming 大量产 judge 时需重审 | 中 |
| `app/api/_/*` 不进 prod build | 私有路由需要从 UI 调用就得移出 `_` 前缀（已用 `/api/cost/today` 解决一例） | 低 |
| Dependabot moderate 警告 | GitHub 报 5 条；未处理 | 中 |
| MCP playwright 不稳定 | 长会话中可能断开，视觉验证退化为 curl + DB | 低 |
| `.env.local` 是 symlink | `ln -s ~/.env.local`；不同机器需要重新建 | 低 |
| README.md 过时 | 仍写 Vite + Workers 栈；CLAUDE.md 有 stack note 兜底 | 低 |

---

## 6. 文档地图

| 看什么 | 去哪 |
|---|---|
| 项目能干什么 / 如何启动 | `CLAUDE.md` |
| 架构总览 | `docs/architecture.md` |
| 单个模块详情 | `docs/modules/*.md`（每个文件开头有 §0 实施现状） |
| 设计决策 | `docs/adr/ADR-*.md` |
| Phase 计划 + 收尾记录 | `docs/superpowers/plans/*.md` |
| 工具命令 | `pnpm` script 见 `package.json`；`pnpm audit:schema` 防 schema 漂移 |
| 下次会话从哪接 | `RESUME.md`（一次性 scratch） |

---

## 7. 维护规则

- **何时更新**：完成一个 Phase 阶段、推上 main、确认无回滚后。**不维护周度进度**——那是 git log 的事。
- **谁负责更新**：当前会话结束前由 AI 主动 propose update；用户确认后才落地。
- **不写什么**：commit list（git log 已经在做）、bug fix 细节（commit message 已记）、临时进度（用 `RESUME.md`）、设计论证（用 ADR）。
- **stale 信号**：「最后更新」距今 ≥ 1 个 Phase（即 commit 数 ≥ 20 后还没动），下次会话开头就该 propose 一次 update。
