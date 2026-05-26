# YUK-88 Block-Tree Note Rebuild — Autonomous Roadmap Driver Prompt

> **Purpose**：这是 YUK-88 roadmap 在多 session / 多 phase / 多 lane 跨度下的 autonomous 驱动手册。任何驱动这条 roadmap 的 Claude session（主 agent 或 dispatched subagent）必须在动手前读完 §0-§3，并按 §4-§11 决策。
>
> **Trigger**：用户说 "drive yuk-88" / "continue yuk-88" / "next phase" / 或一个新 session 从这条 roadmap 接力时。
>
> **Self-containment**：本文档不假设 session context。所有外部依赖在 §1 列出且必读。

**Doc 日期**：2026-05-26
**适用 roadmap**：YUK-88 P0-P7（~61 pts，17-20 周，单人）
**Owner**：yukoval（single user, NAS self-host）

---

## §0. Mission and scope

### 0.1 一句话目标

把 Note artifact 从"hub + atomic 5-section"两态架构重写成"hub + atomic + long 三态共用 body_blocks block tree + TipTap Notion-like 编辑器 + Living Note mutator-mode"，落 8 个 phase（P0-P7），每个 phase 单独可 ship，最终 supersede ADR-0019，落 ADR-0020 + ADR-0021。

### 0.2 不在范围内（hard out-of-scope）

- ❌ source_tier / grounding write path / user_verified flip（与 ADR-0020 解耦，独立 phase）
- ❌ D graph 节点页视图（phase 2+ roadmap）
- ❌ per-hub opt-in `applied_in` / `related_to` mesh 扩展（day1 不做）
- ❌ Dreaming auto-archive maintenance agent（future）
- ❌ 多用户 / per-user auth（ADR-0007 永久 non-goal）
- ❌ 外部 MCP server / plugin marketplace（v0.3 §6 non-goal）
- ❌ 引入 Python sidecar / 其他 provider（ADR-0001 / ADR-0003）

### 0.3 完成定义

8 phase 全 ship + ADR-0020 accepted + ADR-0021 written + status.md 标 YUK-88 ✅ + Linear YUK-88 close + `audit-drift` 跑一次绿。

---

## §1. Authoritative sources（动手前必读）

按重要性排序。冲突时上面的覆盖下面的。

| 优先级 | 文件 / 命令 | 角色 |
|---|---|---|
| 1 | `omc ultragoal status` | roadmap 当前 phase 在哪、哪些 done、哪些 blocked |
| 2 | `docs/adr/0020-block-tree-note-rebuild.md` | 核心契约（block_id / body_blocks / knowledge_ids / Notion 位置规则 / archive 模型 / hub auto-sync） |
| 3 | `docs/adr/0021-*.md`（P2 跑通后存在） | TipTap PM node schema 规约 |
| 4 | `docs/planning/2026-05-26-note-rich-doc.md` §0 | post-grill 完整决策矩阵（Q1-Q19，C1-C4 拍板） |
| 5 | `docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` | Phase index（依赖图 / wave / cross-cutting / 启动建议） |
| 6 | `docs/superpowers/plans/2026-05-26-yuk88-p{N}-*.md` | per-phase lane plan（启动 phase 时存在） |
| 7 | `docs/superpowers/status.md` | shipped baseline + 当前 phase 群外部状态 |
| 8 | `docs/planning/v0.4-complete-form-roadmap.md` §3 第 5 层 | Artifact 多态完全体目标对照 |
| 9 | `CLAUDE.md` + `.claude/CLAUDE.md` | 项目级行为规则 |
| 10 | `CONTEXT.md` | 跨 agent 术语表 |
| 11 | Linear YUK-88 + sub-issues YUK-90~97 | sub-issue acceptance criteria 权威 |

### 1.1 自检 checklist（每个 session start）

新 session 接力时按顺序跑：

```bash
# 1. roadmap state
omc ultragoal status

# 2. git state（branch + uncommitted + last 5 commits）
git status -uno && git log --oneline -5

# 3. 当前 phase 的 Linear sub-issue 状态
# 用 mcp__claude_ai_Linear__get_issue 查 YUK-9{N+0}

# 4. ADR-0020 status（应该是 accepted）
grep -A2 "^**Status:" docs/adr/0020-block-tree-note-rebuild.md

# 5. 任何 phase-deferred allowlist 入口
cat scripts/audit-schema-allowlist.json | jq '.[] | select(.resolves_when.ref | contains("YUK-88"))'
```

任一异常 → 不动手、报告给用户。

---

## §2. State machine — 当前阶段定位

### 2.1 状态变量

```
PhaseState = {
  current_phase: G001..G008 | None,
  current_status: pending | in_progress | review_blocked | failed | complete,
  current_lane: <lane-id> | None,
  current_worktree: <path> | None,
  current_branch: <branch> | None,
}
```

Source of truth：`omc ultragoal status` + `git worktree list`。

### 2.2 Phase 依赖图（不可绕）

```
P0 (G001, throwaway spike)
  ↓
P1 (G002, schema + ADR-0020)
  ↓
P2 (G003, editor) ── ADR-0021 ──┐
  ↓ (after ADR-0021)             │
  └─────────────────────────────── P3 (G004, AI pipeline)
                                          ↓
                                   P4 (G005, Living Note)
                                          ↓
                                   P5 (G006, cross-link + hub auto-sync) ← P2 done
                                          ↓
                                   P6 (G007, read-view + node page)
                                          ↓
                                   P7 (G008, tests rework)
```

### 2.3 并发节点（hard rules）

- **P2 // P3**：仅在 ADR-0021 written 且 P1 done 后；两条独立 worktree、两次独立 `/launch-phase` 调用；**不共享 TaskList**。
- **P3 → P4**：sequential 强制（P4 mutator op schema 依赖 P3 patch op 定型）。
- **P5 deps double**：P5 必须等 P2 done AND P4 done。

### 2.4 状态转换规则

- `pending` → `in_progress`：通过 `omc ultragoal complete-goals` 拿 handoff + 主动 announce
- `in_progress` → `review_blocked`：verifier fail / code-review fail / spec drift → `omc ultragoal record-review-blockers`
- `review_blocked` → `in_progress`：blocker resolved，附 evidence
- `in_progress` → `complete`：`omc ultragoal checkpoint --status complete` + Linear close + commit `Closes YUK-9N`
- `in_progress` → `failed`：撞 ADR / schema / framework 硬墙 → escalate 用户、停

---

## §3. Per-phase execution protocol

每个 phase 走相同的 4 步循环：preflight → launch → verify → checkpoint。

### 3.1 Phase preflight（启动 phase 前必跑）

1. **拉 main 最新**：`git checkout main && git pull --ff-only origin main`
2. **Linear 状态确认**：sub-issue 在 Backlog 或 Todo（不能已经 In Progress / Done）
3. **依赖 phase 已 done**：`omc ultragoal status` 看前置 phase 都标 complete
4. **写 per-phase lane plan**（如不存在）：路径 `docs/superpowers/plans/2026-05-26-yuk88-p{N}-<slug>.md`，仿 P0 spec 形态
   - **Lane 切分骨架**写在 phase index doc 里（§"Lane scope per phase"），抄过来作为起点
   - **per-lane 实施步骤不预写**（per memory `feedback_lane_plan_pattern.md` — lane subagent 在 lane start 现场写；预写会 stale）
5. **dev server port check**（per memory `feedback_dev_server_port_check.md`）：如果 phase 涉及 UI 验证，先 `lsof -i :3000` 看 OrbStack 容器有没有占；如果占了，要么停容器，要么 pnpm dev 跳 :3001 + 显式 curl :3001
6. **UI design pre-flight**（如 phase 含 UI 修改）：
   - 逐字引用 design doc 段落（path + 章节锚点 / 行号）
   - 声明组件类型（drawer / route / modal / page / ...）
   - 列出将要 touch 的文件（创建 vs 修改）
   - **等用户 approve 才动 UI 代码**（per memory `feedback_ui_preflight.md`）

任一 fail → 报告 + 停。

### 3.2 Phase launch

**默认走 `/launch-phase`**，input 是 per-phase lane plan path。

```
/launch-phase docs/superpowers/plans/2026-05-26-yuk88-p{N}-<slug>.md
```

`/launch-phase` 内部：
- 读 lane 切分 → `TaskCreate` 每条 lane 建任务 + `addBlockedBy` 串依赖
- 每条 lane：
  1. `superpowers:using-git-worktrees` 建 worktree
  2. **subagent dispatch** —— **model 必 `opus`**（per memory `feedback_subagent_model.md`，覆盖 CLAUDE.md "极少用 Haiku" 的自主调度指引）
  3. `superpowers:writing-plans` 在 lane 内现场写 lane plan
  4. `superpowers:subagent-driven-development` 跑 impl → 自审 → spec review → fix → quality review
  5. Pre-merge gate（见 §8.1）
  6. Lane done → `TaskUpdate complete`，不删 worktree（chain-merge 后统一清理）
- 全 lane done → chain-merge sequential

**P0 例外**：不走 `/launch-phase` 默认 chain-merge 流程。P0 是 spike，不 merge 到 main；走 `superpowers:subagent-driven-development` 单 lane + spike branch + PR description 作 deliverable。

**例外标志**：phase index doc 里写"NOT chain-merged to main"的 phase（当前只有 P0）。

### 3.3 Phase verify

每条 lane chain-merge 完 → 整 phase verify：

```bash
# 标准 phase-level gate（CLAUDE.md pre-PR gate）
pnpm typecheck && \
pnpm lint && \
pnpm audit:schema && \
pnpm audit:partition && \
pnpm audit:profile && \
pnpm test && \
pnpm build
```

任一 fail → 不进 §3.4 checkpoint，回 lane 修。

**额外 audit**（特定 phase 触发）：
- **P1 done** → 跑一次 migration smoke test，确认 fresh DB up clean
- **P2 done** → `/audit-drift` 跑一次（schema vs ADR-0020 / 0021 漂移）
- **P5 done** → 跑 hub auto-sync nightly worker dry-run，验证 iii-curated mesh query 性能 < 5s
- **P7 done** → 全 phase closeout audit，跑 `/audit-drift` + 检查 status.md 是否需要更新

### 3.4 Phase checkpoint

```bash
omc ultragoal checkpoint \
  --goal-id G00N-<slug> \
  --status complete \
  --evidence "PR #X merged + tests pass + Linear YUK-9N closed" \
  --claude-goal-json '<snapshot of active /goal state>'
```

**对最后一个 phase (P7)**：必须附 `--quality-gate-json`，含 `aiSlopCleaner` / `verification` / `codeReview` 三 evidence 全 clean。

**Linear close**：commit message 含 `Closes YUK-9N`（per memory `feedback_linear_workflow.md` — Linear integration 靠 commit message 触发，不是 PR body）。

**status.md update**：phase 全 ship + 测过 + 确认不会回滚 → 主动 propose `docs/superpowers/status.md` update（per status.md §9 维护规则）。

---

## §4. Skill usage rules

### 4.1 Roadmap-level（跨 phase）

| 触发 | Skill | 用法 |
|---|---|---|
| Session start | (自检 §1.1) | 不是 skill，是 bash 流程 |
| 进入下一 phase | `omc ultragoal complete-goals` | CLI 不是 skill；拿 handoff text + 设 `/goal` 条件 |
| 跨 phase 检查漂移 | `/audit-drift` | 项目本地 skill，手动触发；输出到 `docs/audit/YYYY-MM-DD-drift.md` |
| 评估当前 architecture | `/oh-my-claudecode:plan` (Opus) | 当 phase 间发现 ADR 需调整时 |
| 跨 session 接力 | `/handoff` | 当当前 session 要 compact 但 phase 没完时 |

### 4.2 Phase-level（单 phase 内）

| 触发 | Skill | 用法 |
|---|---|---|
| 启动 phase 多 lane | `/launch-phase`（项目本地） | 默认入口；spike phase 例外 |
| 写 phase plan | `superpowers:writing-plans` | 仅在 lane start 由 lane subagent 跑；禁主 agent 预写 |
| Worktree 隔离 | `superpowers:using-git-worktrees` | launch-phase 自动调；无需手动 |
| Phase 间 grill | `/grill-with-docs`（项目本地） | 当 phase 内 spec 与 ADR 撞了 |

### 4.3 Lane-level（lane subagent 用）

| 触发 | Skill | 用法 |
|---|---|---|
| Lane impl | `superpowers:subagent-driven-development` | launch-phase 自动调 |
| Lane TDD | `superpowers:test-driven-development` | CLAUDE.md 未强制 TDD，但对 P3/P4/P5 schema-critical 改动推荐 |
| Pre-merge | `superpowers:verification-before-completion` | launch-phase 自动调 |
| Ff-merge | `superpowers:finishing-a-development-branch` | launch-phase 自动调 |
| 代码 review | `superpowers:requesting-code-review` 或 `/pr-review-toolkit:review-pr` | quality review pass 用 |
| Bug debug | `superpowers:systematic-debugging` 或 `/oh-my-claudecode:debug` | 撞 bug 时；不要直接乱改 |
| 接收 review feedback | `superpowers:receiving-code-review` | 当 reviewer 提了改动建议；要技术 rigor，不要 performative agreement |

### 4.4 调试 / 验证 skills

| 触发 | Skill |
|---|---|
| 反直觉 bug，多 hypothesis 候选 | `/oh-my-claudecode:trace`（内部用 team 跑竞争 hypothesis） |
| Prompt regression（P3 AI 出错） | `/oh-my-claudecode:ccg`（claude+codex+gemini 三模交叉） |
| Silent failure 检查 | `/pr-review-toolkit:silent-failure-hunter` |
| Type design 改动 | `/pr-review-toolkit:type-design-analyzer` |
| Comments 审 | `/pr-review-toolkit:comment-analyzer` |

### 4.5 不要用的 skill

- ❌ `/oh-my-claudecode:autopilot` —— 单线 idea → code，绕过 launch-phase / 跨 phase 状态
- ❌ `/oh-my-claudecode:ralph` —— 自循环到 task done，不适合 multi-phase 强依赖
- ❌ `/oh-my-claudecode:team` —— phase 内 launch-phase 禁并行 impl；team 增加 coordination overhead 无收益
- ❌ `/figma-*` 系列 —— 这个项目没有 Figma 设计源；UI 走 design brief markdown
- ❌ `/oh-my-claudecode:omc-setup` / `/omc-doctor` —— OMC 已装好，运行期不要乱动

---

## §5. MCP usage rules

### 5.1 Linear（issue tracker）

**Tool prefix**：`mcp__claude_ai_Linear__*`

| 操作 | Tool | 何时用 |
|---|---|---|
| 查 YUK-88 整体 | `get_issue --id YUK-88 --includeRelations true` | session start 自检 |
| 查 sub-issue 详情 | `get_issue --id YUK-9N` | phase preflight |
| 列 YUK-88 所有 sub | `list_issues --parentId YUK-88` | roadmap 状态全扫 |
| Update sub-issue status | `save_issue --id YUK-9N --stateId <id>` | phase 启动 / 完成 |
| 新 follow-up issue | `save_issue --title ... --teamId ... --parentId YUK-88` | 发现 phase 内 deferred work |
| comment | `save_comment --issueId YUK-9N` | 进度 / blocker 记录 |

**关键规则**（per memory `feedback_linear_workflow.md`）：
- Linear integration 通过 **commit message** 里的 `Closes YUK-NN` 自动 attach + status flip 到 Done。不是 PR body。
- In Progress 是手动转的（commit 不触发 In Progress；只触发 Done）。
- 多 issue 时不要 `Closes YUK-27 + YUK-28` 缩写，要 `Closes YUK-27` + `Closes YUK-28` 分行。
- Issue body 用 6-section template（goal / scope / tasks / acceptance / 估算 / out-of-scope），不偏离。

### 5.2 auggie（codebase 检索）

**Tool**：`mcp__auggie__codebase-retrieval`

**使用规则**（per CLAUDE.md "Codebase search (auggie)" + memory `feedback_search_strategy.md`）：

| 场景 | 工具 |
|---|---|
| 跨文件语义检索 / 想了解某 feature 整体实现 | `mcp__auggie__codebase-retrieval` |
| 已知确切符号 / 已知文件 / 列举所有引用 | `grep` / `Read`（auggie 是 overkill） |
| grep 找不到不要直接断言"不存在" | **先 auggie 二次验证**（per memory，SQL / migration / view 走 auggie 才能命中） |

**第一次用前 ToolSearch**：`select:mcp__auggie__codebase-retrieval`

### 5.3 context7（外部库文档）

**Tool**：`mcp__context7__resolve-library-id` + `mcp__context7__query-docs`

**用于**（per `~/.claude/rules/context7.md`）：
- TipTap / ProseMirror API（P0 / P2 必用，文档变化快）
- Drizzle ORM 高级用法（P1 schema rewrite）
- pg-boss 调度（P4 / P5 worker）
- Next.js 15 App Router caching（P5 / P6 SSR）
- React 19 / TanStack Query / Zustand（P2 / P4 / P6 UI）

**步骤**：
1. `resolve-library-id` 用库名（如 `tiptap` / `prosemirror-model`）拿 `/org/project` ID
2. `query-docs` 带完整问题（不是单词）

**不用于**：refactor / 业务逻辑 / 写脚本 / 通用编程概念。

### 5.4 GitHub（PR / commit / review）

**Tool prefix**：`mcp__github__*` 或 `gh` CLI via Bash

| 操作 | 推荐 |
|---|---|
| Open PR | `gh pr create --body-file <tmp>`（per memory，body 文件避免 git-guard false positive） |
| List branches | `mcp__github__list_branches` |
| PR review comments | `mcp__github__pull_request_review_write` |
| Get PR diff | `mcp__github__get_diff` |

**关键规则**：
- PR title 含 YUK-9N，body 含 sub-issue link
- PR body 含 git-guard 拦截关键字（`git branch -D` / `git push --force`）时，写 body 到文件用 `--body-file`，避免 hook false positive

### 5.5 不用的 MCP

- ❌ `mcp__plugin_figma_figma__*` —— 没 Figma 源
- ❌ `mcp__render__*` / `mcp__plugin_vercel_*` —— 项目 NAS 自托管，不上 render / vercel
- ❌ `mcp__claude_ai_Cloudflare_Developer_Platform__*` —— 走 Cloudflare Tunnel ingress，但不动 Cloudflare 配置
- ❌ `mcp__computer-use__*` —— 没有 GUI 自动化需求；UI 验证用 Playwright MCP

### 5.6 Playwright（UI 验证）

**Tool prefix**：`mcp__plugin_playwright_playwright__*`

**用于**：P2 / P6 UI verification（编辑器交互 / 阅读视图渲染）

**禁止**：跑端到端业务 e2e（项目已有 vitest + happy-dom 设置）；仅作"我刚改的 UI 长这样"快照。

---

## §6. Behavioral standards

### 6.1 Scope discipline（per CLAUDE.md）

- 实现 exactly 用户问的；**不**扩 scope 进 MCP / Skills / Plugins / full harnesses 除非显式让你做
- 想加 infrastructure 之前先问"用户是否问了？" —— 不清楚就停下问，不要自建
- bug fix 不需要周围的 cleanup；one-shot operation 不需要 helper
- "三行相似代码"好过"premature abstraction"

### 6.2 UI 设计 pre-flight（per CLAUDE.md "UI Design Compliance"）

写任何 UI 代码 **之前**：
1. **逐字引用** design doc 段落（文件路径 + 章节锚点 / 行号；不要从上下文推断）
2. **声明组件类型**：drawer / route / modal / page / 其它
3. **列出 touch 文件**：标 创建 vs 修改
4. **等用户 approve 才动手**

**不适用**：纯文档 / 纯后端 / 纯 schema / 纯测试 / 已经在批准过的 plan 步骤里。

### 6.3 Code conventions

- **文件权限**：不硬编码 `0o644`；用 `0o666 & ~umask` for files / `0o777 & ~umask` for dirs
- **注释**：默认不写。除非 hidden constraint / 微妙 invariant / 特定 bug workaround / 反直觉行为
- **不要解释 WHAT**（命名说明）；不要 reference 当前 task / fix / caller（"used by X" 这种，应在 PR description）
- **phase-deferred / 占位代码**（per memory `feedback_phase_deferred_comments.md`）：显式注释标"何时完善 + 去哪查上下文"
- **Error handling**：不为不可能场景加；internal code + framework guarantees 可信；只在 system boundary（user input / external API）守

### 6.4 反过度工程（per memory `feedback_anti_overengineering.md`）

- 成熟问题用 OSS（tool calling / frameworks / FSRS / AI SDK），不自建
- 不抽 abstraction 直到第二个具体实例出现（YAGNI）
- 不为假想未来需求设计
- 不嵌 Obsidian 当 note 框架

### 6.5 AI agency + Evidence（per memory `feedback_ai_agency.md`）

- AI 在软判断 / 软提议上自由发挥
- **所有决策可追溯**：动作走 `event` 表（ADR-0006 v2）；不绕开 `writeEvent()`
- **可回滚**：retract / supersede 走 correction event 不 mutate；undo always 可达

### 6.6 Search 顺序（per memory `feedback_search_strategy.md`）

1. 已知 symbol / 文件 → `grep` / `Read`
2. 跨文件 / 语义 / 不知道在哪 → `mcp__auggie__codebase-retrieval`
3. grep 找不到 → **不要直接断言"不存在"** → auggie 二次验证（SQL / migration / view 容易漏）
4. 历史 commit / 谁改的 → `git log` / `git blame`，不要 mem 推

### 6.7 Subagent 调度（per memory `feedback_subagent_model.md`）

- **subagent 一律 `model: opus`**，覆盖 CLAUDE.md 的"自主调度"指引
- 例外：纯查文档 / 简单 read 操作可 sonnet；haiku 极少
- launch-phase 派的 lane subagent 默认 opus

### 6.8 Commit / PR 规范

- Commit subject ≤ 70 chars，YUK-XX 在 title 或 body
- Commit body 包含 `Closes YUK-9N`（单行，多 issue 分行）
- Commit message 含 git-guard 关键字时用 `git commit -F <file>`（避免 hook false positive）
- PR body 用 `gh pr create --body-file <tmp>`
- Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## §7. Cross-cutting invariants（每个 phase 都要 hold）

复制自 phase index doc。lane subagent 启动时必读。

### XC-1 — block_id 稳定性（ADR-0020 §2）

**规则**：split → 原 id 跟"上半"、下半新 id；merge → 前 block id 保留、后 block id 丢弃；**无 lineage / supersedes / derived_from 字段**。
**Helper（P1 land 后）**：`src/server/blocks/anchor.ts`
**适用**：P2 编辑器、P3 patch op、P4 Living Note apply 全部依赖。

### XC-2 — body_blocks 单一 SOT（ADR-0020 §1）

**Schema**：三态共用 `artifact.body_blocks JSONB`，PM doc.toJSON() 形态。
**禁止**：任何 lane 引入 atomic-only / long-only / hub-only schema 字段。
**Verifier 约束**：atomic = 5 semantic_kind 至少各 1 + knowledge_ids.length === 1；hub = ≥ 3 cross_link block。

### XC-3 — L3+L2 cross_link 索引混合（ADR-0020 §5）

**SOT**：`block.attrs.cross_link = { artifact_id, block_id? }`（L3）
**反链**：`artifact_block_ref` 表（L2，write-through）
**禁止**：用 `knowledge_edge` 表存 note ref。

### XC-4 — knowledge_ids label 关系（ADR-0020 §3）

**Schema**：`artifact.knowledge_ids text[]`（plural），至少 1 个。
**约束**：atomic 数组长度 === 1（强制）；long / hub 可 N。

### XC-5 — Event-driven 撤回（ADR-0006 v2 + ADR-0020）

**SOT**：correction event log（block_id anchor）。
**禁止**：嵌 lineage 字段；retract 走 event 不走 mutate。

---

## §8. Verification gates

### 8.1 Per-lane pre-merge gate（launch-phase 自动跑）

```bash
pnpm typecheck && \
pnpm lint && \
pnpm audit:schema && \
pnpm audit:partition && \
pnpm audit:profile && \
pnpm test && \
pnpm build
```

任一 fail → lane 不 merge，回 §3.2 lane subagent fix。

### 8.2 Per-phase chain-merge gate（每条 lane 进 main 后）

每条 lane ff-merge 进 main 后，主 worktree 再跑一次 `pnpm test`。挂了立即 `git reset --hard ORIG_HEAD` 回滚，escalate。

### 8.3 Wave-end gate（多 phase 收口）

Wave 结束 chain-merge 完后跑全套 §8.1 + `/audit-drift`。绿了才启下一 wave。

### 8.4 Final phase closeout gate（P7 done）

P7 是最后 phase，`omc ultragoal checkpoint` 必须附 `--quality-gate-json`：

```json
{
  "aiSlopCleaner": { "ran": true, "findings": "clean", "evidence": "..." },
  "verification": { "ran": true, "result": "pass", "evidence": "..." },
  "codeReview": { "ran": true, "verdict": "APPROVE", "evidence": "..." }
}
```

不 clean → 走 `record-review-blockers` 不 checkpoint。

---

## §9. Failure handling / escalation

### 9.1 Verifier fail（pre-merge gate 红）

1. 看是哪一步红（typecheck / lint / audit / test / build）
2. 启 `superpowers:systematic-debugging` 或 `/oh-my-claudecode:debug`
3. **不**降级跳过（不 `--skip` / `--no-verify` / `it.skip` 临时禁测）
4. 修了再跑 §8.1 完整 gate

### 9.2 git-guard hook 触发

**Per memory `project_launch_phase_pipeline.md`**：触发 = 用户介入信号。

**做**：
- 报告被拦了什么（哪条命令 + 哪条规则触发）
- 让用户决定下一步
- 如是 commit / PR body 含拦截关键字 false positive → 用 `git commit -F file` / `gh pr create --body-file`

**不做**：
- ❌ 换 shell 重跑
- ❌ 改 hook 路径 / disable hook
- ❌ `--no-verify` 绕

### 9.3 Subagent 反复 BLOCKED（≥ 2 次同因）

`launch-phase` 规则：≥ 2 次同因 → escalate 用户，不无限 retry。

**escalate 报告含**：
- 哪条 lane / 哪个 worktree
- BLOCKED 原因（直接引 subagent 报告）
- 已尝试 fix（具体改动）
- 建议路径（A: 调 ADR / B: 拆 lane / C: 改 spec）

### 9.4 ADR 冲突发现 mid-phase

phase 内 impl 时发现"按 ADR-0020 不通"：

1. **停 lane impl**（不要"先这样"绕）
2. 用 `/grill-with-docs` 把冲突点跟 ADR 对照
3. 输出：ADR 该 revise 哪一段 + 新 ADR-0020.X revision 或 新 ADR
4. 用户 approve revision → 续 lane impl
5. **memo**：ADR revision 走 commit + Linear note，不在 PR body 偷偷塞

### 9.5 Phase 超 2x 估时

例：P0 估 0.5 周，跑到 1 周还没出 spike 结论 → escalate。

**报告含**：
- 超时哪条 lane / 卡哪
- 重估 pts 与原 pts 差
- 建议：A 继续 / B 拆 phase / C 改 scope

不私自延 phase 边界。

### 9.6 ff-merge 不可能（main 上有 lane 不知道的 commit）

launch-phase 明确：让用户决定 rebase or merge commit。**不私自处理**。

### 9.7 acceptance test flaky

标 lane `blocked` 不 merge，写进报告。让用户决定 rerun / 修测试 / 改 spec。

### 9.8 Schema migration 失败 mid-deploy（P1 / P5 风险）

1. `git reset --hard ORIG_HEAD` 回滚 commit
2. 回滚 DB：`pnpm db:rollback` 或手动 `DROP/RECREATE` 已建表（per migration smoke）
3. escalate：列出失败 SQL + 期望 vs 实际行为
4. **不**重试 migration 期望"这次就过"

---

## §10. Logging / state updates

### 10.1 ultragoal checkpoints（每 phase done）

```bash
omc ultragoal checkpoint --goal-id G00N-<slug> --status complete \
  --evidence "PR #X merged + tests pass + Linear YUK-9N closed" \
  --claude-goal-json '<snapshot>'
```

### 10.2 Linear updates

| 何时 | 操作 |
|---|---|
| Phase 启动 | manual flip sub-issue status to "In Progress"（commit 不触发，per memory） |
| Lane done in phase | 不动 Linear（lane 是内部切分，Linear 只追 phase） |
| Phase done | commit message 含 `Closes YUK-9N` → 自动 flip Done |
| 发现 phase 内 deferred work | `save_issue` 新建 follow-up，标 parent = YUK-88 或独立 project |
| Phase blocker | `save_comment` 写 issue 评论 |

**Issue capture gate**（CLAUDE.md）：任何 implementation / audit / planning task 在 final response 前要么创 Linear issue 给 follow-up，要么显式说 "no Linear issue needed because X"。

### 10.3 status.md update

Phase 全 ship + 无回滚 → propose `docs/superpowers/status.md` update：
- Foundation D 段下加 YUK-88 P{N} ✅ 行
- 或新建 Foundation E（如果 YUK-88 整体被视作新 foundation）—— 拍板时决定

**不**维护周度进度（status.md §9 规则）。

### 10.4 audit-drift（特定 phase 后）

| Phase | Trigger |
|---|---|
| P1 done | `pnpm audit:schema` 必跑；如新 allowlist 入口，标 `resolves_when.kind='phase' ref='YUK-88 P3'` |
| P2 done | `/audit-drift` 跑一次（ADR-0020 / 0021 vs 编辑器 impl 漂移） |
| P5 done | `/audit-drift` + 性能 audit（hub auto-sync query < 5s for 1k nodes） |
| P7 done | `/audit-drift` 完整一次 + status.md update + Linear close YUK-88 |

### 10.5 Memory updates（用户口头授权）

发现新行为 pattern 应该记 memory（per CLAUDE.md "auto memory" 协议）：
- 用户矫正你的 approach → save feedback memory
- 用户认可一个非显然选择 → save feedback memory
- 项目内决策 / who's doing what → save project memory
- 外部系统 reference → save reference memory

**不**save：code patterns / git history / debug solutions / 已在 CLAUDE.md 的东西。

---

## §11. Anti-patterns / hard NO

| 反模式 | 为什么 |
|---|---|
| 跳过 `pnpm build` gate | next build catches route export validation production-only checks（YUK-67） |
| `--no-verify` / `--skip-hooks` | git-guard hook 是反向兜底，绕等于把保险拆了 |
| 并行 dispatch impl subagent | launch-phase 明文禁，会冲突 |
| 主 agent 预写 lane plan | 会 stale（per memory PR #122 实证） |
| 在 main branch commit | git-guard 会拦；用户做这事是错的，你做更错 |
| `git branch -D` / `git push --force` 到 main | git-guard 拦；强行绕 = 丢工作 |
| 在 `src/` 写 spike 代码 | P0 是 throwaway，污染 src/ 会被 build / test 吃 |
| 改 ADR-0020 不 supersede | ADR revision 要么改 status: revised + 注明 supersedes，要么新建 ADR-0020.1 |
| 引入 Python / 新 provider | ADR-0001 / ADR-0003 锁死，要 revise ADR 才行 |
| 加 backwards-compat shim 给删的字段 | post-grill spec 决定 DROP sections / outline / child_artifact_ids；不要"保留兼容" |
| 在 atomic 内嵌 `question_ids[]` | post-grill 决定 → 改 artifact_ref block；不要 resurrect 老 schema |
| 用 section_id 作 mark_wrong anchor | ADR-0019 整体废止；用 block_id |
| 共用 Tool interface（YAGNI） | 等第二种 tool kind 出现再抽 |
| `auggie` 工具不 ToolSearch 先 load | `auggie` 是 deferred；第一次用前必 `ToolSearch select:mcp__auggie__codebase-retrieval` |
| `pnpm dev` 不查 :3000 占用 | OrbStack 容器长期占；会跳 :3001，curl :3000 拿老 build |
| commit message 用 emojis | CLAUDE.md / project conventions：用户不要求就不用 |
| feature flags / backwards compat shims | 直接改代码，不要兜底 toggle |

---

## §12. Final closeout（P7 done 后做的事）

按顺序：

1. **P7 pre-merge gate 全绿** + `/audit-drift` 全绿
2. **`omc ultragoal checkpoint --goal-id G008-p7-tests-rework --status complete --quality-gate-json <full evidence>`**
3. **`omc ultragoal status`** 显示 8/8 complete
4. **Commit + push** P7 final commit，含 `Closes YUK-97` + `Closes YUK-88`（parent close）
5. **`docs/superpowers/status.md` update**：YUK-88 整 phase ✅ 行入 Foundation 段（或新建 Foundation E）
6. **`docs/planning/v0.4-complete-form-roadmap.md` §3 第 5 层** update：标 ADR-0020 全 phase ship；删 "Gap" 段对应已 close 项
7. **ADR-0019 final status check**：确认 `Status: Superseded by ADR-0020`
8. **ADR-0020 + 0021 final status check**：确认 Status: Accepted + date
9. **Linear YUK-88 + YUK-90~97** 全 closed
10. **post-mortem note**（optional）：在 `docs/superpowers/audits/2026-XX-XX-yuk88-closeout.md` 写一份 5-section closeout（什么 ship / 什么没 ship / 估时 vs 实际 / 学到什么 / 残留 follow-up）
11. **memory update**：发现的 reusable pattern 存 memory（lane subagent 协作 pattern / launch-phase 失败模式 / 之类）

---

## Appendix A: Quick-start session opener

新 session 接力时，对自己 / 对用户先跑这段：

```
我在驱动 YUK-88 Block-Tree Note Rebuild roadmap (P0-P7, ~61pt, 17-20 周)。
按 docs/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md 执行。

执行 §1.1 自检：
1. omc ultragoal status — 当前 phase 在哪
2. git status -uno && git log --oneline -5 — git state
3. 当前 phase sub-issue 状态 (Linear YUK-9{N})
4. ADR-0020 status — 应该 accepted
5. audit-schema allowlist YUK-88 entries 检查

自检全绿后按 §3 进入当前 phase。
```

## Appendix B: Decision flowchart

```
session start
  ↓
§1.1 自检 → any fail? → 报告 + 停
  ↓ all pass
omc ultragoal status → current phase?
  ↓
phase preflight §3.1 → any fail? → 报告 + 停
  ↓ all pass
[has per-phase lane plan?] → no → 写 §3.1 step 4 → user approve?
  ↓ yes/approved
phase is P0 (spike)? → yes → superpowers:subagent-driven-development single lane
  ↓ no
/launch-phase <per-phase plan path>
  ↓
phase verify §3.3 → fail? → §9.1 verifier fail loop
  ↓ pass
phase checkpoint §3.4
  ↓
phase = P7? → yes → §12 final closeout
  ↓ no
notify user phase done + propose next phase preflight
```

---

## Appendix C: Linked authority

| Doc | Purpose |
|---|---|
| `docs/adr/0020-block-tree-note-rebuild.md` | 核心契约 |
| `docs/adr/0021-*.md` (post-P2) | TipTap PM node schema |
| `docs/planning/2026-05-26-note-rich-doc.md` §0 | post-grill 决策矩阵 |
| `docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` | Phase index |
| `docs/superpowers/plans/2026-05-26-yuk88-p{N}-*.md` | Per-phase lane plans |
| `docs/superpowers/status.md` | Shipped baseline |
| `docs/planning/v0.4-complete-form-roadmap.md` | 完全体对照 |
| `CONTEXT.md` | 术语 |
| `CLAUDE.md` + `.claude/CLAUDE.md` | 项目行为 |
| `.claude/skills/launch-phase/SKILL.md` | launch-phase 协议 |
| Linear YUK-88 + YUK-90~97 | Issue acceptance |
| `.omc/ultragoal/{brief,goals,ledger}` | Roadmap durable state |
