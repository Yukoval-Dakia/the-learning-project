# Phase 1c.2 Implementation Plan — UI 主切片（六页，loom 对齐版）

> ✅ **SHIPPED 2026-05-17**
>
> 这份 plan 是 1c.2 启动时的 sketch（"REFRESH REQUIRED" banner 没动；正文沿用 `encounter` 命名，是历史快照，不要按字面读）。下面是实际落地清单，正文部分作为历史保留。
>
> **运行模型差异**：plan body 里 `encounter` 在落地时已经全部走 event 流（ADR-0006 v2）。映射：
> - `Encounter where outcome='wrong'` → `event WHERE action='attempt' AND subject_kind='question' AND outcome='failure'`
> - `encounter.evidence.cause` → 沿 `caused_by_event_id` 的 `judge` event payload.cause（或 1c.2 加的 `experimental:user_cause` event）
> - `/api/encounters?...` → `/api/mistakes?...` + `/api/events?...`（wire 形保留"错题"用户语义）
> - "review_session encounter" → `event(action='review', subject_kind='question')` + `material_fsrs_state` 投影
>
> **实际 commits（origin/main）**：
> - `01670bf` /knowledge tree + mesh (codex)
> - `d33bf3e` experimental:user_cause event path
> - `35073e4` accept knowledge-edge proposal handler
> - `fe8ecd7` lint baseline → 0/0
> - `7d39c72` /record vision_single + vision_paper MVP
> - `caa5237` vision review polish (image preview + bbox + Tier 2/3 rescue + cross-page merge + structured tree)
> - `abfee21` stale placeholder cleanup
> - 加上前面 `3cb420e..bfa81f9` 的 Step 0–8 + `c73eb71` merge commit
>
> **Deferred 到 Phase 1d**（非本 phase scope）：
> - `/encounters/[id]` / `/events/[id]` 单事件详情页（chain navigation UI）
> - Session summary AI 生成 + 显示
> - CostLedger UI 真接 /today（现仅文案占位）
> - `/knowledge/proposals` 独立路由 + 节点创建表单
> - history / 过往 session 列表（per addendum: `/today` KPI strip 暂代替）
> - Goal 链接（`learning_session.goal_id` + Goal 表 + UI）
>
> **历史 refresh 标记**（写于 1c.2 启动前，已被实际实施推翻）：
>
> ~~⚠️ REFRESH REQUIRED — 2026-05-15 v2~~
>
> 1c.2 启动 sketch 时数据访问语言是 `encounter` 单表，1c.1 Step 4-6 把它换成 event 流。本 plan body 沿用 `encounter` 命名，读时心里换 `event(action='attempt'/'judge'/'review')` 即可。
>
> **历史 design refresh**（per `docs/superpowers/specs/2026-05-15-phase1c-loom-design-addendum.md`）：
> - 页面从 5 变 6：drop `/history`（用 `/today` 顶部"近期"区块替代），drop `/capture` 与 `/inbox` 独立路由（合并进 `/record` 三 tab unified），新增 `/today` orchestrator + `/mistakes` + `/learning-items`
> - drop shadcn → 用 1c.1 已 port 的 **loom Primitives**（`src/ui/primitives/`），icon = `lucide-react`
> - design tokens 已在 1c.1 lift 进 `app/globals.css` `@theme`，本 phase 不再调

**Goal**：把 Phase 1c.1 建好的"无人触达的完整后端"接到人类眼前。**六个页面**（per loom L2）：
- `/today` —— Learning Orchestrator 控制面（KPI strip + 3 lane A/B/C + Task Dispatcher + cost ledger 链接）
- `/record` —— 三 tab unified（manual + vision_single + vision_paper），同一 IngestionSession 状态机
- `/review` —— FSRS due queue + 单题答 + 键盘 1/2/3 评分 + cause 显示
- `/mistakes` —— encounter where outcome='wrong' 列表 + CauseBadge AI/user provenance
- `/learning-items` —— TODO 形态，segmented filter + 状态 transitions
- `/knowledge` —— read-only tree table + AI proposals 链接

**Spec**：`docs/superpowers/specs/2026-05-14-phase1c-design.md`

**Predecessor**：Phase 1c.1 实现 plan `docs/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md`

**ADRs**：0006（encounter）/ 0007（单用户）/ 0008（LearningSession）—— 全部在 1c.1 落地，本 plan 只消费。

**前置（不可妥协）**：

- Phase 1c.1 PR merge 完成
- `encounter` / `learning_session` 表已上线
- loom Primitives 10 atoms 在 `src/ui/primitives/` 就位（1c.1 Step 10 已完成）

**预估**：5-7 d 单人推进，9 个 Step。

---

## Step 0: 准备 + 路由约定（loom 6 页结构）

- 起新分支 `phase1c2-implementation`（worktree 推荐）
- 确认 1c.1 schema 跑得动 + loom Primitives 就位；`pnpm dev` 起来 `/health` 用 loom palette 渲染
- 路由（addendum L2）：
  - `/` → redirect 到 `/today`（1c.1 已完成）
  - `/today` → Learning Orchestrator 控制面
  - `/record` → 三 tab unified（manual / vision_single / vision_paper）
  - `/review` → FSRS 复习
  - `/mistakes` → encounter where outcome='wrong' 列表（alias 给 `/encounters?outcome=wrong`）
  - `/learning-items` → 学习项 TODO
  - `/knowledge` → 知识 tree table
  - `/knowledge/[id]` → 单节点 + 挂在它下面的 encounters
- Layout：
  - desktop ≥ 760px: `<TopNav>` 顶部（6 routes）
  - mobile < 760px: `<TabBar>` 底部（5 routes — drop `/learning-items`）
  - `app/(app)/layout.tsx` 包 layout component；所有真实页面在此 route group

Commit：`feat(1c.2): route group + TopNav/TabBar shell (loom)`

---

## Step 1: 共享辅助 + 验证 Primitives

> Primitives 在 1c.1 Step 10 已经 port。本步只补 helper + 跑一次视觉冒烟。

- `src/ui/lib/utils.ts`：`cn` 工具（写一个或装 `clsx` + `tailwind-merge`）+ formatCnDate / formatRelTime
- 跑 `frontend-design` skill 一次 review 已 port 的 Primitives 视觉，按需要 override Tailwind tokens 进 minimal layer
- 写 `app/(app)/_storybook/page.tsx`（dev-only）—— 把所有 10 个 Primitives 在一页渲染，对比 loom `preview/components-*.html` 的 reference（仅 dev 路径）

Commit：`feat(1c.2): UI utils + Primitives storybook smoke`

---

## Step 2: `/review` — FSRS 复习页（**最高价值，先做**）

> 复习是项目的核心闭环；让 `encounter.evidence.cause` 终于到达用户眼前是这条 PR 的灵魂。

**数据流**：

1. `GET /api/review/due` → 当前 FSRS due encounter[]（`outcome='wrong'` filter，per ADR-0006）
2. 用户答题 → `POST /api/review/submit` → 写入 `learning_session(type='review', status='completed')` + 新增 `encounter(outcome='reviewed', source_encounter_id, fsrs_rating)`
3. UI 展示 judge 结果 + 原 encounter 的 cause（attribution 之前 AI 写好的）

**Layout**：

- 顶部进度条（5/10 done）
- 主区：encounter prompt（含 image_refs 渲染 + 原始材料的 markdown 题面）
- 答题区：textarea + "提交" button
- 提交后：split view —— 左侧用户答案 vs 右侧参考答案；下面展示原 encounter.evidence.cause（按 primary_category 高亮 + ai_analysis_md）
- FSRS 评分按钮：again / hard / good / easy

**关键 UX**：

- 答题过程键盘友好（Ctrl/Cmd+Enter 提交）
- judge 反馈停留 ≥ 3s 让用户读完 cause（不要一闪而过）
- cause 展示要让 `primary_category` 视觉权重高（带 chip + emoji 之类）

Commit：`feat(1c.2): /review page — FSRS due queue + encounter answer + cause display`

---

## Step 3: `/record` —— 三 tab unified（capture + inbox 合并）

> loom L2 拍板：原 sketch 的 `/capture` + `/inbox` 折叠成 `/record` 一个页面的三 tab，全部走同一 IngestionSession 状态机。直接 lift loom `Ingest.jsx` 的 `RecordScreenUnified` 形状。

**3 个 mode tab**（`<IngestModeTabs>`）：

1. **`manual`** —— ManualForm：textarea prompt / reference / wrong + 知识点 chip-row + 错因 select（留空 → AI 兜底）→ submit POST `/api/encounters`（post-1c.1）→ jump `/mistakes`
2. **`vision_single`** —— 1 张图 VisionFlow（dropzone → 上传 → SSE 进度 → 单 block 编辑 → import）
3. **`vision_paper`** —— 1-5 张图 VisionFlow + 跨页块合并（Block Assembly A path MVP）

**VisionFlow 数据流（Sub 0c 集成，per addendum L4）**：

```
dropzone → POST /api/assets (multipart) → POST /api/ingestion 创建 session
         → POST /api/ingestion/[id]/extract 触发异步
         → GET /api/ingestion/[id]/events 开 SSE
         → 收 ingestion.queued / extracting / extraction_completed 事件 → 推进 IngestPipelineTrace
         → 显示 N 个 question_block + layout_quality badge
         → 用户合并 / 编辑 / 标记 ignore（A path manual merge MVP）
         → 若 partial → 用户可点 "Vision Tier 2 (haiku)" / "Tier 3 (sonnet)"
            → POST /api/ingestion/[id]/rescue → 同步替换该 block
         → "审核完成 →" → "批量导入" POST /api/ingestion/[id]/import
         → jump `/mistakes`
```

**新增 UI 元素（loom 没画，addendum L4 要求）**：

- **SSE 进度条** 替代 loom 的 "模拟上传 + 提取" 按钮 —— 显示当前 stage 的实时点亮 + 来自 server 的 stage 名（queued / extracting / extraction_completed）
- **layout_quality badge**：`structured` 不显，`partial` 显 amber"布局部分识别"，`text_only` 显 amber "仅文本识别"
- **救援按钮 per block**：仅 partial 状态下显示，Tier 2 / Tier 3 + 成本提示
- **extraction_evidence 展示**：
  - `evidence.tencent_grading` → info-tone badge "Tencent · {RightAnswer}"
  - `evidence.handwriting[]` → 在原图上高亮 bbox（hover 显示 OCR 文本）

**保留 loom 设计**：
- `IngestModeTabs` 三 tab + hint + phase 标
- `IngestPipelineTrace` 4 阶段 ol（uploaded → extracted → reviewed → imported；扩到 Sub 0c 的 queued / extracting / partial / failed 状态）
- Manual form 中文-first textarea + 知识点 chip-row + 留空 cause select
- 批量导入按钮文案 "批量导入 · {n} 道 → AttributionTask"

Commit：`feat(1c.2): /record unified — manual + vision_single + vision_paper + SSE`

---

## Step 4: `/today` —— Learning Orchestrator 控制面

> loom L2 新增、最高 UX 价值（不存在于原 sketch）。直接 lift loom `Today.jsx` 的形状。

**Layout**（loom `<TodayScreen>` + `<OrchestratorPanel>`）：

- **KPI strip** 4 块大数：`FSRS 到期` / `归因中` / `学习项 (active)` / `知识点数`（来自 `GET /api/encounters` + `/api/learning-items` + `/api/knowledge` 各自 count endpoint）
- **Orchestrator panel**（"今日学习安排"）：3 lane ol
  - **A · Review** （`Phase 2A`）—— "复习 N 道错题"，reason 行展示按 cause 分布（concept/knowledge_gap/expression 计数），按钮 "开始 review_session →" 跳 `/review`
  - **B · Learning Intent** （`Phase 2B · spec`）—— stub disabled "+ 我想学…（未实现）"（addendum L8.2 拍板保留 stub）
  - **C · Coach** （`Phase 3 · spec`）—— stub disabled "查看本周报告（未实现）"
- **Task Dispatcher details**（`<details>` collapsible）—— 列已注册 task + 状态（shipped / in-flight / Phase 2）
- **Footer meta**：`Cost guard · CostLedger 今日 $X / $5 · ToolCallLog N calls · 详见 /api/_/logs/jobs`

**数据 fetch**：
- `GET /api/encounters?outcome=wrong&due_before=now` → A lane
- `GET /api/encounters?outcome=wrong&cause_is_null=true` → "归因中" KPI
- `GET /api/learning-items?status=pending,in_progress` → "学习项" KPI
- `GET /api/knowledge` → "知识点数" KPI
- `GET /api/_/logs/jobs?limit=1` → 今日 cost 推算（暂用 cost_ledger sum）

Commit：`feat(1c.2): /today orchestrator — KPI + 3 lanes + task dispatcher`

---

## Step 5: `/mistakes` —— encounter wrong 列表

> loom `<MistakesScreen>` 直接 lift。post-1c.1 后底层是 `encounter where outcome='wrong'`，但 UI 文案保留"错题"（用户语义）。

- header `<PageHeader title="错题列表" eyebrow="/mistakes">` + "AI 知识点提议 →" 链 `/knowledge/proposals`（Phase 1d 实装）
- lede：`最近 N 条 · 归因中 X / 已归因 Y · + 录新错题`
- 主区：card-list，每张卡用 loom `<Card>` + 顶部 row：`<meta-mono>{时间}</meta-mono>` + `<CauseBadge cause={evidence.cause} createdAt={created_at} />`
- 卡片体：prompt_md（prose-cn 类）+ 错答 + 知识点列表

`<CauseBadge>` 三态：
- `evidence.cause === null` 且 elapsed < 30s → `<Badge tone="hard"><dot> 归因中...</Badge>`
- `evidence.cause === null` 且 elapsed > 30s → `<Badge tone="neutral">待归因</Badge>`
- `evidence.cause.user_edited === false` → `<Badge tone="info">AI · {primary_category} ({confidence}%)</Badge>`
- 否则 → `<Badge tone="good">用户 · {primary_category}</Badge>`

Commit：`feat(1c.2): /mistakes — encounter list with CauseBadge provenance`

---

## Step 6: `/learning-items` —— TODO 形态

> loom `<ItemsScreen>` 直接 lift。学习项是 `learning_item` 表（Sub 4b 已建）。

- segmented filter：`全部 / 待办 / 进行中 / 已完成`
- `<details open>` 新增表单：title input + 创建按钮
- card-list with `<StatusBadge>` + 状态 transitions：
  - pending → "开始学" (hard 按钮) / "我学完了" (good 按钮)
  - in_progress → "我学完了" / "改回待办"
  - done → "重学"
- 删除：`×` 按钮 + 二次确认

Commit：`feat(1c.2): /learning-items — TODO with segmented filter + transitions`

---

## Step 7: `/knowledge` + `/knowledge/[id]` —— 知识树浏览

**`/knowledge` 列表页**：

- `GET /api/knowledge`（带层级 + archived filter）
- 展示树形结构（缩进 or expand/collapse）
- 每个节点显示 name + effective_domain + count(encounters挂在此节点下)
- click 节点 → `/knowledge/[id]`

**`/knowledge/[id]` 单节点页**：

- 节点元信息：name / domain / parent / created_at / 描述（若有）
- 挂在此节点的 encounters 列表（按 outcome 分组：wrong / right / exposed / created / drilled / reviewed）
- click encounter → `/encounters/[id]` (Phase 1d 实现单 encounter 详情页；本 phase 仅占位 "todo")

**关键 UX**：

- 树形导航 keyboard 友好（arrow keys + enter）
- 节点 count 实时更新（TanStack Query refetch on focus）
- 暂不提供"创建节点"按钮——节点的产生靠 AI propose + 用户在 `/knowledge/proposals` 决断（独立路由，Phase 1d 或后续 grill）

Commit：`feat(1c.2): /knowledge tree viewer + per-node encounters list`

---

## Step 8: 顶层 — auth gate + error boundary + loading patterns

> **drop `/history`**（loom L2）：`/today` 顶部 KPI strip + 中部 orchestrator 已覆盖"看自己干了啥"的需求；全 session 历史延 Phase 1d。

**Auth gate**：

- middleware.ts 已经做了 `x-internal-token` 校验，但 UI 调用 `/api/*` 时必须带 token。
- `src/ui/lib/api.ts`：fetch wrapper 自动加 `x-internal-token` header（从 localStorage 读，启动时一次性提示输入并存）
- 启动页：若 localStorage 无 token，强制弹 dialog 输入并存入

**Error boundary**：

- `app/(app)/error.tsx`：捕获 client-side 异常
- 全局 toast（用 loom Primitives 自建 `<Toast>` 或装 `sonner` —— sonner 是独立 lib 非 shadcn 专用，可直接装）
- 401 时清空 token + 重新提示

**Loading**：

- 每个页面用自建 `<Skeleton>` 占位组件（loom 没画，~15 行 CSS：paper-sunk 上的脉动条）+ React Suspense
- TanStack Query 默认 stale-while-revalidate，loading 状态自然

Commit：`feat(1c.2): auth gate + error boundary + loading patterns`

---

## Step 8: smoke E2E — 完整闭环手动 walkthrough

> 不上 Playwright（设置成本 > 收益，单用户工具）；改为**手动 checklist**，一次性跑通。

手动测：

- [ ] `/today` 加载 → 4 KPI 显示 + 3 lane 状态正确
- [ ] `/record` vision_paper tab：上传 2 张试卷照片 → SSE 进度条跑完 → 显示 N 个 block + layout_quality badge
- [ ] 编辑一个块 + 标记一个 ignore → 点"批量导入"
- [ ] 跳 `/mistakes`，看到新 encounter（outcome='wrong'），`<CauseBadge>` 显"归因中..."
- [ ] 等 attribution 跑完（看 `/api/_/logs/jobs`）→ `<CauseBadge>` 变 "AI · concept (87%)"
- [ ] `/today` KPI "归因中" 数字应该 -1
- [ ] 进 `/review`，做这道题答错 → 看到 cause 展示 + 键盘 1/2/3 工作
- [ ] 进 `/knowledge`，找到这个 encounter 挂的节点
- [ ] 进 `/learning-items` 新建 1 项 → transition pending → in_progress → done

跑通后写到 PR 里。

> **如果手测频繁失败，再投资 Playwright + MCP `mcp__plugin_playwright_*`**。但单用户 + manual checklist 应该够 90% 用例。

Commit：`docs(1c.2): smoke E2E walkthrough record (in PR body)`

---

## Step 9: PR

```bash
gh pr create --title "Phase 1c.2: UI main — review / inbox / capture / knowledge / history" \
  --body "$(cat <<'EOF'
## Summary
- 六个 UI 页面落地（today / record / review / mistakes / learning-items / knowledge），Phase 1 闭环可演示
- loom Primitives + Tailwind v4 (loom tokens) + Zustand + TanStack Query
- /review 让 attribution 终于到达用户眼前（关键价值兑现）
- /today orchestrator 是控制面 entry，/record unified 把"拍 + 审 + import"折叠成一个状态机

## Test plan
- [ ] pnpm test 全绿
- [ ] pnpm typecheck 全绿
- [ ] 手动 smoke walkthrough（Step 8 checklist）

🤖 Generated with Claude Code
EOF
)"
```

---

## Notes / 防踩坑

- **UI 测试策略本 plan 不投资 Playwright**。单用户 + 完工前无生产流量 + 手动跑一次 cheap。频繁手测累再开独立 plan。
- **`/review` 是杠杆最大的一页**——直接兑现 ADR-0006 的承诺。其他五页可以晚做；`/review` 不能省。
- **mobile 体验**：`/record` 的 vision_single / vision_paper tab 必须 mobile-first 设计（拍照场景）；其他五页 desktop-first，mobile 可读即可。loom `<TabBar>` 已经覆盖 mobile 导航。
- **loom Primitives port 顺序**：1c.1 Step 10 应该一次性 port 完 10 个（addendum L1 推翻 shadcn），不要边做 1c.2 边补。
- **frontend-design skill 用法**：本 phase **不用** skill 出 mockup——loom 设计已经定型，按 loom HTML / JSX 1:1 port 即可。skill 仅用于 review port 后的 RSC 结果。

---

## TBD: 细节待开干前敲定

1. **/review 的 cause 展示视觉规范**：10 类 cause 共用 loom info-tone Badge（addendum 默认）or per-cause 色？grill 时定。**默认**：共用，文案足以区分。
2. **/record vision tab 的合并 UI 是 drag-drop 还是 multi-select + button**：loom `Ingest.jsx` 用 multi-select + button（更适合 mobile）。**采用 multi-select**。
3. **`/encounters/[id]` 详情页**：本 phase 占位 "todo"，Phase 1d 补。
4. **session summary 谁触发 + 何时显示**：summary_md 字段在 1c.1 schema 已建，AI 生成路径 Phase 1d 加；本 phase 不显。
5. **B/C lane stub 显示与否**（addendum L8.2）：**保留 disabled stub**——loom 设计意图是 show the mechanism。
