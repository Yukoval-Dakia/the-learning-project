# RESUME — 下一会话从这里继续

> 一次性 scratch 文件。下次会话开头我读完它就可以直接接续，干完阶段后可以删/重写。
> 用法：会话开头说「读 RESUME.md」即可。

## 当前状态（2026-05-17）

**分支**：`main`（本次会话刚加 Phase 2 dreaming edge proposer 一个 commit）。
**Phase**：1c.2 ✅ / 1d 进行中 / 2 开局 —— dreaming 的节点 + 边 nightly cron 都活了。
**部署**：本地 OrbStack 已 smoke 过 4 个候选；NAS 推送由你手动做。

## 最近一段的成果（按时间倒序）

```
39ce567 docs(modules): refresh 5 module docs with §0 implementation-status headers
c9bae4d fix(1c.2): /knowledge edge create — created_by takes a string, not an object
6da0fa1 feat(1d): /events/[id] detail page + /today cost ribbon          ← Cand 4
d279089 feat(1c.2): /study-log standalone page + API                      ← Cand 3
7fb58e0 feat(1c.2): LearningItem 6 states (resting + archived + dismissed)← Cand 2
ab8bb1d feat(1c.2): manual knowledge_edge create form on /knowledge       ← Cand 1
dd50a3a feat(1c.2): surface learning_item knowledge_ids + secondary cause categories
4e9dc9d docs(1c.2): mark plan + mistakes module shipped against event-stream reality
abfee21 chore(1c.2): remove stale placeholders left over from earlier phases
caa5237 feat(1c.2.C): vision review — image preview + bbox + rescue + merge + structured
7d39c72 feat(1c.2): /record vision_single + vision_paper MVP
```

## 当前可用 UI 概览（用户视角）

| 路径 | 用途 | 状态 |
|---|---|---|
| `/today` | KPI + 成本带（BJT 每天 0 点重算） | ✅ |
| `/record` | 手动错题 + Vision OCR 全链路（待 .env creds） | ✅ |
| `/mistakes` | 错题列表 + user_cause 写入 | ✅ |
| `/learning-items` | 6 状态机 + 知识点 chips + 转态按钮 | ✅ |
| `/knowledge` | Loom 树 + mesh + 手动建边 + 边提议 accept/reverse | ✅ |
| `/knowledge/[id]` | 单个知识点详情 | ✅ |
| `/study-log` | 5 kind 学习日志（写作 / 总结 / 错题集 / 工具 / 反思） | ✅ |
| `/events/[id]` | 事件链浏览器（caused_by 上游 + 下游） | ✅ |
| `/review` | FSRS 复习闭环 | ✅（不开 learning_session row） |

## 桌上未启动的事项（按"应该最先做"排序，我的个人推荐）

1. ~~Phase 2 Dreaming worker~~ — **本次会话已完成 v1**：
   - `KnowledgeEdgeProposeTask` 注册（sonnet）
   - `src/server/knowledge/propose_edge.ts` —— 验证 + 去重 + 写 ProposeKnowledgeEdge 事件
   - `src/server/boss/handlers/knowledge_edge_propose_nightly.ts` —— pg-boss cron @ BJT 02:30
   - UI 已经在 `/knowledge` 通过 `/api/events?action=propose&subject_kind=knowledge_edge` 拉
   - Anthropic Batch API 暂跳过 —— 单用户体量低，同步调用足矣
   - 后续可扩：Maintenance agent（reparent / merge / split / archive）

2. ~~session lifecycle 决策~~ — **本次会话已完成（ADR-0013 + 实施）**：
   - ADR-0013 拍板选 A（eager 开 session + sendBeacon close + orphan cron 兜底）
   - `POST /api/review/sessions` + `POST /api/review/sessions/[id]/end`
   - `/review` 页 mount 开 + pagehide sendBeacon
   - `prune_orphan_review_sessions` cron @ BJT 04:15 把 6h+ started 标 abandoned
   - session-end AI 总结现在可以挂上 —— 但本次没做，下次拿了 session_id 后写一个 `SessionSummaryTask` 即可

3. **LearningItem hub + atomic 层级** — schema 已有 `parent_item_id` 字段（待激活），UI 完全没有。需要：
   - 数据：决定 hub 是不是即 LearningItem.kind='hub'；
   - UI：`/learning-items/[id]` 详情页 + 子项展开树。

4. **Note artifact 系统** — 0 写入 0 UI。是 Phase 1d/2 的大坑（生成 / 编辑 / embedded check / hub↔atomic 链接）。等 #3 hub/atomic 落地后再做。

5. **cause-differentiated review weights** — FSRS 现在不分 cause 类型给权重。比如「概念不会」vs「手滑」应该不同惩罚强度。需要 ts-fsrs custom retrievability 函数或后处理。

6. **Real OCR vision path** — UI + 端点全部就绪。只差 `.env`：`TENCENT_SECRET_ID/KEY`、`R2_*`、`ANTHROPIC_API_KEY`。你的活。

7. **Dependabot 警告** — push 后 GitHub 报 5 个 moderate。看：https://github.com/Yukoval-Dakia/the-learning-project/security/dependabot

## 已知遗留 / 设计债

- `experimental:user_cause` 路径已通，但 user_cause 跟 agent judge 的合并策略仍是「user 优先」。未来 dreaming agent 大量产 judge 时需要重审。
- `app/api/_/*` 私有路由（如 `/api/_/logs`、`/api/_/seed`）不进生产 build。如要从 UI 用须移出 `_` 前缀（参考 `/api/cost/today` 的做法）。
- 7 个 worktree + PR #44 + 残留 artifact 上次已清理，不再回来。
- MCP playwright 服务器在上次会话中断开。视觉验证依靠 curl + DB inspection。

## 环境快记

```bash
# 本地 dev（直连 .env.local）
pnpm dev

# OrbStack 本地 smoke
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
# app :3000 / postgres :5433 / cloudflared 在 production profile 下不启

# 测试（需 Docker 起来）
pnpm test

# Schema drift lint
pnpm audit:schema
```

`.env.local` 是 symlink → `~/.env.local`（分类器禁拷贝，已经用 ln -s 解决）。

## 我给下一会话的我留的话

- 先 `git status` + `git log --oneline -5` 摸现状，再读这个文件就够了。
- 如果用户说"接着干"，**默认问一句要做上面 1–6 哪条**，不要自作主张挑大坑。
- 用户可能会要求清理 `RESUME.md`——干完一个阶段后可以重写 or 删；它就是 scratch。
- 用户偏好：中文回复 / scope discipline / 反过度工程 / 已成熟问题用 OSS / Evidence 留痕。
