# Loom · Design Brief (2026-05-15)

> **For Claude Design / any future designer**: this brief grounds you in what to design. **Read this first, then the 5 files referenced at the bottom**. The old `loom-design/` folder is a previous iteration — use it for aesthetic + voice + Primitives命名, but **its data model and page interaction logic are stale**.

---

## 1. Project · one paragraph

**Loom** is Yukoval Studios' single-user AI-driven learning tool. First subject: 文言文 (classical Chinese), but the architecture is generic. Three threads are woven into a closed loop:

- **Knowledge graph** (manually grown + AI proposed)
- **Mistake-driven learning** (you do a question wrong → AI attributes cause → schedule review)
- **FSRS spaced review** (3-button rating: 不会 / 模糊 / 会了)

**AI is a central design concept, not a feature.** The system is built around AI as a first-class actor — it generates content (变式 / 笔记 / quiz), proposes knowledge nodes, critiques itself, and converses with the user via a Copilot sidebar. The user is the human in the loop; the AI is the proactive partner.

---

## 2. Architectural truth (READ ADR-0006 v2 FIRST)

The system is **event-driven**. Every action — by user, by AI agent, by cron — is a row in the `event` table. There are **3 core tables**:

```
[material]                   question / knowledge / source_document / artifact
                             (artifact is where AI's generated content lands)

[learning_session]           container with type ∈ {ingestion, review, conversation,
                             tutor, explore, create}
                             ↳ a session contains many events; its timeline IS the events

[event]   ★ THE CORE ★       actor_kind × action × subject_kind 三轴
                             - actor_kind: 'user' | 'agent' | 'cron' | 'system'
                             - action:     'attempt' | 'judge' | 'propose' | 'generate'
                                         | 'review' | 'rate' | 'extract' | 'experimental:*'
                             - subject_kind: 'question' | 'knowledge' | 'artifact'
                                         | 'source_document' | 'event' (chain)
                             - caused_by_event_id: 因果链 (DAG)
                             - payload: jsonb with per-(action,subject_kind) Zod schema
```

**Implication for UI**: most domain queries are event-filtered views.

| 用户语义 | Backing query |
|---|---|
| 错题列表 | `events WHERE action='attempt' AND outcome='failure' AND subject_kind='question'` |
| 归因 | 沿 attempt event 的 `caused_by_event_id` 找到 `action='judge'` 子事件 |
| 复习 | `events WHERE action='review'` |
| AI 提议 | `events WHERE action='propose' AND actor_kind='agent'` |
| Copilot 对话 | `learning_session(type='conversation')` 含 events |

---

## 3. The four AI archetypes — we are at C + D

| Archetype | What AI does | Where we are |
|---|---|---|
| A · annotator | Categorizes user mistakes after the fact | past (insufficient) |
| B · equal actor | AI actions logged like user actions, auditable | **baseline** |
| C · proactive producer | AI generates variants / notes / quizzes / proposals on its own | **target** |
| D · conversation partner | Copilot sidebar; AI tutors, explains, critiques in dialogue | **target** |

**Design implication**: AI is visible everywhere. Every AI action has an actor badge (`AI · attribution`, `AI · variant_gen`, `Copilot`). The user can drill into any AI output and trace its reasoning chain (`caused_by_event_id`).

---

## 4. Aesthetic + voice — keep loom (this part doesn't go stale)

**Lift wholesale from `docs/design/loom-design/`**:

- Warm paper (`#FAF9F5`) + single coral accent (`#D97757`) + ink (`#1F1E1D`)
- Three semantic tints used ONLY at FSRS rating buttons + CauseBadge (`again / hard / good / info`)
- Fonts: Source Serif 4 (display) + Noto Serif SC (中文) + MiSans (UI sans, fallback PingFang SC) + JetBrains Mono
- 4 / 6 / 8 / 12 / 999 corner radii. No 16px+.
- Three shadow steps (`--shadow-1/2/3`), all warm-tinted

**Voice rules** (`docs/design/loom-design/project/README.md` §Content):

- 中文 first; Latin/code is inline. UI labels 中文 first.
- Technical specificity over reassurance. "归因中..." not "正在思考..."
- Show the mechanism. Surface task names, confidence percentages, FSRS ratings, version numbers.
- Dry, occasional humor — never cute. "今天没有要复习的，太好了" ✓ "🎉 你真棒！" ✗
- **No emoji, ever.** Permitted unicode: `·` `→` `↳` `—` `×` `+ ` only.
- English: Sentence case. Buttons read "Refresh", not "REFRESH".

**Re-use loom Primitives命名** (`Brand / Icon / Button / Badge / StatusBadge / CauseBadge / Card / PageHeader / TopNav / TabBar`). 实现换 lucide-react；shape保持。

---

## 5. Pages to design (6 + Copilot sidebar)

| Route | Purpose | Key new (vs loom v1) |
|---|---|---|
| `/today` | Learning Orchestrator 控制面（KPI + 3 lane + Task Dispatcher）| C 档需要：lane 数据来自 events（cause distribution, recent AI proposals 计数） |
| `/record` | 三 tab unified（manual + vision_single + vision_paper）→ 同一 `learning_session(type='ingestion')` | Sub 0c SSE 接入：`/api/ingestion/[id]/events` 实时进度 + layout_quality badge + Vision Tier 2/3 rescue 按钮 + extraction_evidence (handwriting + tencent_grading) 高亮 |
| `/review` | FSRS due queue + 单题答 + 1/2/3 评分 + cause 显示 | C 档需要：cause 来自 `events WHERE action='judge'`；用户可点击查看 reasoning chain |
| `/mistakes` | `events WHERE action='attempt' AND outcome='failure'` 视图 | 新：每条错题旁显示 AI 生成的变式 / 笔记 / 提议（沿 caused_by 找子 events）+ 用户可 accept/dismiss |
| `/learning-items` | 学习项 TODO（保留语义，与 event 解耦）| 不变 |
| `/knowledge` | 知识 tree + AI 提议入口 | 新：每节点显示该节点上 AI 的最近活动（events filtered by knowledge_id）|
| **`Copilot sidebar`** | D 档对话伙伴。任何页面右侧抽屉 | 新：对话是 `learning_session(type='conversation')`，每轮是 events；Copilot 调 tool 后写 `action='generate'` event，用户 rate accept/dismiss |

---

## 6. C + D 档专有 UI 元素（loom 没画，这些是新需求）

### 6.1 Event chain 审查（C 档核心）
用户能问"AI 为什么提议这个？" 沿 `caused_by_event_id` 看完整 reasoning trail。形态待 grill：

- 选项 A：每个 AI event 旁有"查看推理"按钮 → 弹 popover 展开父事件 + payload
- 选项 B：每个 AI event 是可展开的 `<details>` 元素，inline 显示链
- 选项 C：独立路由 `/events/[id]` 看完整 DAG

**默认 B**（最少跳转），但你可以提议更好的。

### 6.2 AI 提议的 inbox / 收件箱（C 档主要 UX）
夜间 Dreaming + Maintenance 产生大量 AI proposal events。用户审批它们的入口：

- 在 `/today` orchestrator 一个区块（"昨晚 AI 提议了 N 条，要看吗？"）
- 在相关 entity 旁内嵌（一个 knowledge 节点上方显示"AI 想给你加 2 个子节点"）

待 grill：**inbox 是独立路由 `/proposals` 还是分布式（在 today / knowledge / mistakes 等页面内嵌）**？loom 老 design 是分布式但没画清；选独立有"集中决断"优势。

### 6.3 Copilot sidebar（D 档核心）
- 任何路由右上角"Copilot"图标 → 右侧抽屉 / 模态
- 上下文感知：sidebar 知道当前路由的 entity（错题 id / 知识点 id），首条 prompt 含 context
- 对话写 `learning_session(type='conversation')` + events
- 用户可在对话内 accept Copilot 的提议（写 `action='rate'` event）
- 历史对话可恢复（`/today` 下拉"最近对话"）

待 grill：**Copilot 与传统 sidebar tab（如 GitHub Copilot）相比是否要更主动**？比如自动出现在用户停留 30s+ 的页面、主动提示"我注意到你最近一直答错于(yu)的用法"？

### 6.4 Cost transparency（C 档信任建立）
AI 大量产出意味着用户要信任成本可控：

- `/today` 底部小行：`今日 $X / 预算 $5 · 详见 logs`
- 每个 AI event 显示 cost_micro_usd（hover 显示）
- 月度报告：`/api/_/logs/jobs` 已有数据，UI 形态待设计

---

## 7. Out of scope

- 多用户 / sharing / 协作（ADR-0007）
- 移动 native app（PWA-only）
- Dark mode
- Marketing / landing page
- Animation 复杂化（loom 已规定：fades + translates only，no bounces/parallax）
- Phase 2 之外的 task（VariantVerifyTask / SourceRetrievalTask 等出现在文档但 UI 占位即可）
- `/inspect` debug page（管理端，不需要"产品级"设计）

---

## 8. Files to read (in order)

1. **This brief** ← you are here
2. **`docs/adr/0006-encounter-replaces-mistake.md`** ← v2 部分，event-driven 核（必读）
3. **`docs/adr/0008-learning-session-multi-type-envelope.md`** ← session 多 type + conversation 吸收 agent_sessions
4. **`CONTEXT.md`** §已批准 v2 ← 词条 + 概念映射表
5. **`docs/design/loom-design/project/README.md`** §Content + §Visual Foundations ← 声调 / 视觉规范（参考，**不读 §Sources 或 §Index 里关于 9 admin pages 的描述，那是旧的**）
6. **`docs/design/loom-design/project/colors_and_type.css`** ← design tokens（直接 port）

Optional：
- `docs/superpowers/specs/2026-05-14-phase1c-design.md`（spec D2-D9，含 page list / UI 决策）
- `docs/superpowers/specs/2026-05-15-phase1c-loom-design-addendum.md`（loom L1-L8）
- Sub 0c plan `docs/superpowers/plans/2026-05-11-sub0c-async-and-ocr-upgrade.md`（异步抽取 / SSE / rescue 现实）

**Skip**：
- `docs/design/loom-design/project/ui_kits/loom-app/*.jsx` —— 旧 mistake-centric 实现，作 reference 看 Primitives 形状但不照 port
- `docs/superpowers/plans/2026-05-11-sub0d-agent-layer.md` —— DEFERRED，等 1c.1 后 refresh

---

## 9. Open design questions（你提议，我们 grill）

1. **Event chain 审查**形态（§6.1 三选一或别的方案）
2. **AI 提议 inbox** 独立路由 vs 分布式（§6.2）
3. **Copilot 主动性**程度（§6.3）
4. **Cost transparency UI** —— 信任工具，但别太烦人
5. **`/today` orchestrator 3 lane（A Review / B Learning Intent / C Coach）** 中 B 和 C 还没数据来源——是显示 disabled stub（loom 原方案）还是先隐藏到有数据再露？
6. **mobile-camera-first** 的 /record vision tab 拍照流 —— 现 loom 的 dropzone 是 desktop 思路，mobile 应该一键拍照 + 上传，待重设计
7. **Knowledge graph 的可视化** —— loom 现是 table，未来要不要 force-directed graph？取决于节点数

---

## 10. What "done" looks like

A click-thru HTML/CSS/JS prototype（同 loom 原本形态）包含：

- 6 主路由 + Copilot sidebar 的高保真渲染
- 至少 2 个 C 档 AI 主动场景：
  - 用户视角看一道错题 + AI 生成的变式 + 提议接受/拒绝
  - 夜间 Dreaming agent 跑完后 user 在 /today 看到提议 inbox
- 至少 1 个 D 档对话场景：
  - Copilot sidebar 内一次 ask → explain → propose → accept 流
- 设计 token 更新（如有调整 vs colors_and_type.css）
- Primitives shape 更新（如新增 `<EventChain>` `<ProposalCard>` `<CopilotDrawer>` 等）
- 一张 SKILL.md 或 README 标明"这是 v2 设计，对应 ADR-0006 v2"

旧 loom-design 文件夹保留作历史；新 design 落到 `docs/design/loom-design-v2/` 或类似命名。
