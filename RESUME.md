# RESUME — 下一会话从这里继续

> 一次性 scratch 文件。下次会话开头我读完它就可以直接接续，干完阶段后可以删/重写。
> 用法：会话开头说「读 RESUME.md」即可。

## 当前状态（2026-05-17 EOD）

**分支**：`main`（已推 origin；本会话累计 9 commit）。
**Phase**：1d ✅ / Phase 2 主干 ✅（A 复习 + B 学习意图 + C 对话教学 + 错题闭环 + 变式生成）。
**部署**：**本地 ship 但未浏览器验证 Phase 2C**；NAS 容器还是旧 build。下次最划算的一件事：rebuild + redeploy + 跑一次 /learn/[id]/chat 真聊。

## 本会话累计成果（按时间倒序）

```
329ae19 fix(test): boss/client flake — cap pg-boss pool + bump Postgres max_connections (Task #19)
4798153 feat(2C): Active Teaching Session MVP — conversation orchestrator + chat UI (Task #18)
809af98 feat(2): variant_gen pg-boss handler — auto cause-targeted variants (Task #17)
eea16f4 feat(2): async attribution_followup via pg-boss (Task #16)
5997475 feat(2B): Learning Intent Orchestrator — hub+atomic LearningItems + NoteGenerateTask
f03af63 feat(2A): Review Orchestrator — priority + rationale + LLM session intent
cab0d7f feat(0d): Provider Manager + route all tasks to xiaomi/mimo
858b204 fix(deploy): lazy boss.start() so app routes can enqueue
dfd5b0a feat(deploy): worker service + esbuild-bundled pg-boss entry
```

详情见 `docs/superpowers/status.md` §3「三大 orchestrator 落地」+ §4「Provider Manager」。

## 当前可用 UI 概览

新增 → 加粗：

| 路径 | 用途 | 状态 |
|---|---|---|
| `/today` | KPI + 成本带（BJT 每天 0 点重算） | ✅ |
| `/record` | 手动错题 + Vision OCR | ✅（需 .env creds） |
| `/mistakes` | 错题列表 + user_cause | ✅ |
| `/learning-items` | 6 状态机 + **「我想学 X」入口** | ✅ |
| `/learning-items/[id]` | 详情 + artifact view + **对话教学入口** | ✅ |
| **`/learn/[id]/chat`** | **Phase 2C 对话教学循环** | ✅ 本地，**未 E2E** |
| `/knowledge` | Loom 树 + mesh + 手动建边 + 边提议 | ✅ |
| `/study-log` | 5 kind 学习日志 | ✅ |
| `/events/[id]` | 事件链浏览器 | ✅ |
| `/review` | FSRS 复习闭环（ADR-0013 session + ReviewIntent 字幕） | ✅ |
| `/learning-sessions/[id]` | session 详情 + summary_md | ✅ |
| `/coach` | 周度报表 | ✅ |

## 桌上未启动的事项（按"应该最先做"排序）

1. **Rebuild + redeploy NAS container + E2E 验证 Phase 2C**
   - 本会话改动量很大（Provider Manager + 3 个 orchestrator + 4 个 pg-boss 队列），容器还是旧 build
   - 跑：`docker compose up --build` 在 NAS，然后浏览器开 /learn/[id]/chat 跟 mimo 真聊 3 轮
   - catch deployment-time bug（这种 bug 单测覆盖不到）

2. **Phase 2 Maintenance Agent**
   - `KnowledgeReviewTask` 已经在 registry 里（reparent / merge / split / archive / propose_new mutation tool）
   - 缺：(a) pg-boss nightly cron handler `knowledge_maintenance_nightly`，(b) `/knowledge` 上的 accept/dismiss UI
   - 模式跟现有 `knowledge_edge_propose_nightly` handler 完全对称，比 2C 简单

3. **VariantVerifyTask Pass 2**
   - 当前 variant_gen 是单 pass MVP，没验证步骤
   - 跑数据看：MVP 跑 2 周后看哪些 variant 被用户做了，命中率 / 题面质量决定要不要补 Pass 2
   - 加：第二 LLM call 验证 + variants_max 计数表 + draft→active state transition trigger

4. **Phase 3 Coach Orchestrator**
   - spec：`docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §Phase 3
   - 用 2A/2B/2C 产出的 evidence 做 daily lane + 推迟/拆小/重学 plan suggestion
   - 是个大坑，先把 1-3 做了再说

5. **README.md 重写**
   - 仍写 Vite + Workers 栈；CLAUDE.md 已有 stack note 兜底但 README 是项目门面
   - 写当前 stack + 启动方式 + 主要 surface

6. **Dependabot 警告** — 5 个 moderate；看：https://github.com/Yukoval-Dakia/the-learning-project/security/dependabot

## 已知遗留 / 设计债

- Phase 2C UI 没浏览器验证（**优先级最高**，列入 #1）
- `experimental:user_cause` 跟 agent judge 合并策略仍是「user 优先」；dreaming 大产 judge 时需重审
- variant_gen 当前每 parent 只 1 道（用 `parent_variant_id` 唯一性兜底），多道留 Phase 3
- MCP playwright 服务器可能断；视觉验证 fallback 是 curl + DB
- `.env.local` 是 symlink → `~/.env.local`

## 环境快记

```bash
# 本地 dev（直连 .env.local；端口 :3000 容易被 OrbStack 容器占，先 lsof -nP -iTCP:3000）
pnpm dev

# OrbStack 本地 smoke
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
# app :3000 / postgres :5433 / worker :worker / cloudflared production-only

# 测试（需 Docker 起来，~70s，837 tests）
pnpm test

# Schema drift lint
pnpm audit:schema
```

## 我给下一会话的我留的话

- 先 `git status` + `git log --oneline -5` 摸现状，再读这个文件就够了。
- 用户问"下一步"时，**默认问一句要做上面 1–6 哪条**，不要自作主张挑大坑。
- 用户偏好：中文回复 / scope discipline / Evidence 留痕 / UI 必须按 design 系统执行。
- 本会话用户压了一句「按你的顺序走，避免飘逸」——做新 Phase 前**先写 brainstorm doc 列 IN-SCOPE / OUT-OF-SCOPE / 最可能漂移点**，这是已经验证有效的 discipline。模板见 `docs/superpowers/brainstorms/2026-05-17-phase2b-learning-intent.md` 和 `2026-05-17-phase2c-active-teaching.md`。
- pnpm dev 前先 `lsof -nP -iTCP:3000` —— OrbStack 容器爱占 :3000，curl :3000 拿到的是容器旧 build。
- xiaomi/mimo token 在 `.env`（gitignored），别 echo / commit。Provider Manager 只 wire 了 anthropic + xiaomi，其他 throw "not implemented"。
