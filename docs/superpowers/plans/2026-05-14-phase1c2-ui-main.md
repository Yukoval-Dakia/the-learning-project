# Phase 1c.2 Implementation Plan — UI 主切片（五页）

> **Status**: sketch（高层 step 已敲定；具体页面 layout / 交互细节 + 测试策略待 1c.1 merge 后细化）。
>
> **For agentic workers**：开干前请确认 1c.1 PR 已 merge 到 main，UI 脚手架（Next.js routing / Zustand / TanStack Query / Tailwind v4 / shadcn）就位。

**Goal**：把 Phase 1c.1 建好的"无人触达的完整后端"接到人类眼前。五个页面：`/review`（最高价值——错因终于到达用户）/ `/inbox`（抽取审阅）/ `/capture`（拍照入口）/ `/knowledge`（知识树浏览）/ `/history`（学习会话历史）。

**Spec**：`docs/superpowers/specs/2026-05-14-phase1c-design.md`

**Predecessor**：Phase 1c.1 实现 plan `docs/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md`

**ADRs**：0006（encounter）/ 0007（单用户）/ 0008（LearningSession）—— 全部在 1c.1 落地，本 plan 只消费。

**前置（不可妥协）**：

- Phase 1c.1 PR merge 完成
- `encounter` / `learning_session` 表已上线
- shadcn 初始化完毕，至少 button / input / card / dialog 装好

**预估**：5-7 d 单人推进，9 个 Step。

---

## Step 0: 准备 + 路由约定

- 起新分支 `phase1c2-implementation`（worktree 推荐）
- 确认 1c.1 schema 跑得动；`pnpm dev` 起来 `/health` 仍 OK
- 路由命名约定：
  - `/` → Dashboard（精简版，显示今日 due reviews + 最近 sessions）
  - `/review` → 复习
  - `/capture` → 拍照入口
  - `/inbox/[sessionId]` → 录入会话审阅
  - `/inbox` → 录入会话列表（含 active / extracted / partial / failed）
  - `/knowledge` → 知识树浏览
  - `/knowledge/[id]` → 单节点 + 挂在它下面的 encounters
  - `/history` → 全 session 列表（type='ingestion' + 'review'）
  - `/history/[sessionId]` → 单 session 详情
- Layout：`app/(app)/layout.tsx` 含侧边栏导航（5 个路由 + Dashboard）。`app/(app)/` 是 route group，所有真实页面都走它

Commit：`feat(1c.2): route group + sidebar navigation shell`

---

## Step 1: 共享 primitives + theming

> 装 shadcn 组件 + 调 design tokens。这一步是审美定调。

- `pnpm dlx shadcn@latest add button input card dialog form label select textarea sheet skeleton sonner badge separator scroll-area tabs` —— 一次性把高频 primitive 装齐
- `app/globals.css` 调 Tailwind tokens：
  - 字号 / 行高 / 间距 用学习型工具风格（read-oriented，不是 dashboard 风格）
  - 色彩 palette：cool neutrals + 一个 accent（蓝 or 绿，待 frontend-design grill）
  - 圆角 / 阴影 克制
- 跑 `frontend-design` skill 一次 review 已装组件的视觉风格，按需要 override Tailwind tokens 进 minimal layer
- `src/ui/lib/utils.ts`：shadcn 提供的 `cn` 工具 + 项目特有 helpers（如 formatCnDate、formatRelTime）

Commit：`feat(1c.2): shadcn primitives + design tokens + theming`

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

## Step 3: `/inbox` + `/inbox/[sessionId]` — 录入审阅

**`/inbox` 列表页**：

- `GET /api/learning-sessions?type=ingestion&status=active,extracted,partial,failed`
- 按状态分组 / 排序：partial / failed 优先（要用户决策），其次 extracted（待 import），最后 active / queued / extracting（仍跑中）
- 每行展示：缩略图（首张 asset）+ 状态 chip + 创建时间 + tier_log 摘要

**`/inbox/[sessionId]` 单 session 详情**：

- 顶部：session 状态 + SSE 进度条（订阅 `/api/ingestion/[id]/events`）—— **复用 Sub 0c 的 SSE 路由**
- 块列表：每个 question_block 一张卡，展示 structured.prompt / options / answer / 配图 + bbox 角标
- 块级操作：编辑 prompt / 改 cause / 合并相邻块 / 拆分 / 标记 ignore
- 合并 UI：拖拽多块到合并区 → 生成 virtual block (`merged_from_block_ids: [...]`)
- 一键 import：选中要 import 的 blocks（默认全选） → `POST /api/ingestion/[id]/import` → 跳 `/encounters` 列表 or `/knowledge`

**关键 UX**：

- SSE 实时进度：用户能看到"正在抽取第 2/5 页"
- 块编辑用 inline edit pattern（点字段→变 input→失焦保存）
- 合并区视觉显著（drop zone 边框 + "把卡片拖来合并"提示）

Commit：`feat(1c.2): /inbox list + session detail with SSE progress + block editing + merge UI`

---

## Step 4: `/capture` — 拍照入口

> mobile-camera-first，但桌面也支持文件 picker。

**Layout**：

- 大按钮 "拍照"（mobile triggers camera）+ 次按钮 "从相册选" / "选文件"
- 选完后预览（多张照片网格）+ "继续" 按钮
- "继续" 后：`POST /api/assets`（multipart）→ `POST /api/ingestion`（创建 session + 触发 extract）→ redirect `/inbox/[sessionId]`

**关键 UX**：

- mobile：`<input type="file" accept="image/*" capture="environment">` 直接调用相机
- 上传过程显示 progress（每张 asset 一条）
- 网络失败 retry 友好（不要全部重传）

**移动端测试**：本地 dev 用 ngrok 或 Cloudflare Tunnel 让手机能访问（NAS deployment 自带 Tunnel，方便）

Commit：`feat(1c.2): /capture page — camera + file picker + multipart upload + session enqueue`

---

## Step 5: `/knowledge` + `/knowledge/[id]` — 知识树浏览

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

## Step 6: `/history` + `/history/[sessionId]` — 学习会话历史

**`/history` 列表**：

- `GET /api/learning-sessions`（全 type，按 started_at desc）
- 分组：今天 / 昨天 / 本周 / 更早
- 每行：type chip（ingestion 蓝 / review 绿 / others 灰）+ 持续时间 + 关联 encounters 计数 + summary_md 预览（第一段）
- 空状态："还没有学习记录，去 `/capture` 拍张试卷开始"

**`/history/[sessionId]` 详情**：

- session 元信息（type / status / 起止时间）
- timeline：本 session 内发生的 encounter 列表（按时间）
- summary_md 完整渲染（如果 AI 生成过；Phase 1c 不一定有，1d 加 session summary）

Commit：`feat(1c.2): /history session list + detail view`

---

## Step 7: 顶层 — auth gate + error boundary + loading patterns

**Auth gate**：

- middleware.ts 已经做了 `x-internal-token` 校验，但 UI 调用 `/api/*` 时必须带 token。
- `src/ui/lib/api.ts`：fetch wrapper 自动加 `x-internal-token` header（从 localStorage 读，启动时一次性提示输入并存）
- 启动页：若 localStorage 无 token，强制弹 dialog 输入并存入

**Error boundary**：

- `app/(app)/error.tsx`：捕获 client-side 异常
- 全局 toast（shadcn sonner）显示 API 错误（特别是 401 / 500）
- 401 时清空 token + 重新提示

**Loading**：

- 每个页面统一用 shadcn skeleton + suspense boundary
- TanStack Query 默认 stale-while-revalidate，loading 状态自然

Commit：`feat(1c.2): auth gate + error boundary + loading patterns`

---

## Step 8: smoke E2E — 完整闭环手动 walkthrough

> 不上 Playwright（设置成本 > 收益，单用户工具）；改为**手动 checklist**，一次性跑通。

手动测：

- [ ] `/capture` 上传 2 张试卷照片 → 进入 `/inbox/[sessionId]`
- [ ] SSE 进度条跑完 → session.status='extracted'
- [ ] 编辑一个块的 cause → 点 "import 全部"
- [ ] 跳到 `/encounters` 列表，看到新 encounter（outcome='wrong'）
- [ ] 等 attribution 跑完（看 `/api/_/logs/jobs`）→ cause 字段填上
- [ ] 进 `/review`，做这道题答错 → 看到 cause 展示
- [ ] 进 `/knowledge`，找到这个 encounter 挂的节点
- [ ] 进 `/history` 看到两条 session：ingestion + review

跑通后写到 PR 里。

> **如果手测频繁失败，再投资 Playwright + MCP `mcp__plugin_playwright_*`**。但单用户 + manual checklist 应该够 90% 用例。

Commit：`docs(1c.2): smoke E2E walkthrough record (in PR body)`

---

## Step 9: PR

```bash
gh pr create --title "Phase 1c.2: UI main — review / inbox / capture / knowledge / history" \
  --body "$(cat <<'EOF'
## Summary
- 五个主要 UI 页面落地，Phase 1 闭环可演示
- shadcn primitives + Tailwind v4 + Zustand + TanStack Query
- /review 让 attribution 终于到达用户眼前（关键价值兑现）

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

- **UI 测试策略本 plan 不投资 Playwright**。理由：单用户 + 完工前无生产流量 + 手动跑一次 cheap。如果 1c.2 收尾后频繁手测累，**再开独立 plan 加 Playwright + `mcp__plugin_playwright_*` 自动化**。
- **`/review` 是杠杆最大的一页**——它直接兑现 ADR-0006 的承诺（"让 cause 到达用户"）。其他四页可以晚做 / 简化；`/review` 不能省。
- **shadcn 装多了会冗余**——只装真正用的 primitive，看 1c.2 各 step 实际需要再 add。
- **mobile 体验**：`/capture` 必须 mobile-first 设计（拍照场景）；其他四页可以 desktop-first，mobile 可读即可。
- **frontend-design skill 用法**：每页第一次画 layout 前调一次 skill，让它出 mockup + 推荐 token 调整。不要"自己画 + 然后让 skill review"——前者快得多。

---

## TBD: 细节待开干前敲定

1. **/review 的 cause 展示视觉规范**：10 类 cause 应有不同 emoji / 色彩？或都用统一 chip？grill 时定
2. **/inbox 的合并 UI 是 drag-drop 还是 multi-select + button**：drag-drop 更直观但 mobile 难用，grill 时定
3. **`/encounters/[id]` 详情页**：Phase 1c.2 占位"todo" or 简易实现？grill 时定
4. **session summary 谁触发 + 何时显示**：CONTEXT.md 提到但 1c.3 phase 已并入 1c.1，summary_md 字段已存在但没 AI 生成路径——可能 Phase 1d
