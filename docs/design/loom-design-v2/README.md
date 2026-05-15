# Loom · v2 design — event-driven

> 对应 **ADR-0006 v2**（3-table 核：material + learning_session + event）
> 与 **ADR-0008 修订**（conversation 吸收进 learning_session）。

旧 `docs/design/loom-design/` 的审美 / voice / tokens / Primitives 命名保留；
page shape + 交互按 event-driven 核重画。

---

## 跑

```
open loom-design-v2/index.html
```

无 build step。React + Babel standalone + 4 个 .jsx 文件（primitives / data
/ pages / tweaks-panel）。所有数据 SEED in `data.jsx`，所有 mutation 在
React state，**无 backend** — 这是 clickable mock。

## 路由（hash router）

| Hash | 页 | 关键事件查询 |
|---|---|---|
| `#today` | Learning Orchestrator | KPI = 多个 event filter；inbox strip = `session=s_dream_last_night` |
| `#mistakes` | 错题（事件视图）| `events WHERE action='attempt' AND outcome='failure' AND subject_kind='question'` |
| `#review` | FSRS 复习 | 写 `action='review'` event + 更新 `material_fsrs_state` 投影 |
| `#record` | 录入 · 3 tabs | `session.type='ingestion'` · Sub 0c SSE feed |
| `#knowledge` | 知识树 + 节点级 AI 活动 | per-node = events 引用了该 knowledge_id |
| `#items` | 学习项 TODO | 跟 event 解耦（ADR-0006 v2 §保留） |
| `#inbox` | 中央 AI 提议收件箱 | tweaks · 默认走 today 顶 strip 而非独立路由 |
| Copilot drawer | 任何路由右上角触发 | `session.type='conversation'` · events = 对话轮 |

## 新 Primitives（v1 没有）

| Primitive | 用途 |
|---|---|
| `<ActorBadge actorKind="user/agent/cron/system" actorRef="..." />` | event.actor_kind 的标签——AI 平等 actor 的可见化 |
| `<EventChain eventId eventsById />` | §6.1 默认 B：inline `<details>` 展示 caused_by 链 |
| `<ProposalCard event ... onAccept onDismiss />` | AI 生成的 artifact / propose event；accept→写 action=rate |
| `<CopilotDrawer />` | D 档：conversation session + events 形态 |
| `<CostRibbon today budget breakdown />` | §6.4：今日成本 + 预算条 + per-event hover |
| `<Lane eyebrow title badge stub />` | Today orchestrator 三 lane |

`<CauseBadge>` 形变更：现在从一个 `action='judge'` 的 event.payload.cause 派生
（actor_kind 决定 AI/用户 tone）。

## C 档场景（已建模）

1. **`/mistakes` 一道错题 + AI 链上的孩子事件**
   - `e_01 (user attempt failure)` → 沿 caused_by 找到 `e_02 (agent judge)` →
     该 judge 又有 `e_03 (variant)` / `e_04 (propose knowledge)` / `e_05 (note)`
     三个孩子。所有都是 ProposalCard，用户 accept / dismiss。
2. **`/today` 看夜间 Dreaming session**
   - inbox strip 展示 `s_dream_last_night` 摘要：cron 启动时间、跑了多久、
     花了多少钱、生成了几个变式 / 小测、提议了几个新节点。"集中审批" → `/inbox`，
     "分散审批" → `/mistakes` 与 `/knowledge` 内嵌。

## D 档场景（已建模）

3. **Copilot drawer · ask → explain → propose → accept**
   - 任何路由顶栏点 Copilot 打开右侧抽屉
   - 抽屉自带 context chip（当前路由 entity，如 `e_01 / q1`）
   - 输入框 Enter 走 `window.claude.complete(...)`（如可用）或脚本兜底
   - Copilot 回 explain + 一条 `generate (artifact)` 提议；用户 accept/dismiss

## §9 open questions — 都做成 Tweaks 让你 grill

按工具栏 **Tweaks** 开关打开右下角面板：

| Tweak | 默认 | 选项 |
|---|---|---|
| **§6.2 inbox 形态** | today-strip | + central-route · + distributed-only |
| **§6.3 Copilot 主动性** | context-aware | + manual · + proactive（停 1.2s 自动开） |
| **§9 Q5 Lane B/C 空数据** | live-only | + show-disabled（loom 原方案） |
| **§6.4 成本可见性** | ribbon + per-event hover | toggleable |
| **actor 名展开** | 完整（`agent · attribution`）| compact-only |

我的默认选择全在 brief §9 标 "默认 B / distributed but with today preview / 等"
的位置——不是凭空选，是 brief 的方向；其它选项是 grill 余地。

## 设计 token 增量

`tokens.css` 直接 lift 自 design system。**没有**新增 token——所有变体都在
现有 86 个 `--*` 内组合。新增的语义层只有：

- `--info` 用作 **AI actor** 的 tone（v1 只用作 CauseBadge 的 AI 来源）—— 现在 ActorBadge / Copilot 提议气泡也用。
- 在 `tokens.css` 顶部把 webfont 全改成 Google Fonts CDN（v1 引用了
  `fonts/MiSans-Normal.ttf` 等本地文件）—— 仅 prototype 便利。

## 旧 loom-design 哪些保留 / 哪些扔了

**保留**：
- `colors_and_type.css` 全部 token + 三步阴影 + 4/6/8/12/999 半径
- Brand mark（3 woven curves + frame）
- Primitives 命名（Brand · Icon · Button · Badge · StatusBadge · CauseBadge · Card · PageHeader · TopNav）
- 中文 first voice / 无 emoji / `归因中...` 等定义

**扔了**：
- 旧 `ui_kits/loom-app/*.jsx` 的所有 page-shape——那是 mistake-centric 单
  表 outcome 模型，与 v2 event-driven 冲突
- TabBar / mobile bottom nav——v2 暂时单 viewport（mobile-first 录入还
  没设计，brief §9 Q6）
- `mistake` / `review_event` / `dreaming_proposal` 三表导出的 hooks——
  v2 全部走 event 视图

## 你 grill 时的 hot-spots

1. **§6.1 event chain 形态**——我用了 inline `<details>`（默认 B）。在 mistakes
   / knowledge / Copilot 三处都试着摆，对不对？要不要在某些场景换成 popover？
2. **§6.2 inbox**——双入口（today strip + 独立 /inbox）是不是太多？
3. **§6.3 Copilot 主动性 "proactive"** 模式——1.2s 触发是否太激进？
4. **/today KPI 4 个**——选的对吗？应该换哪个？
5. **/record 的 Vision Tier rescue 三步**——按钮上明码 cost；够透明 / 太
   noisy？
6. **/knowledge 树视图**——目前是缩进 + 「↳」。brief §9 Q7 提到未来要不要
   force-directed graph——暂未做。
7. **每条 AI 提议的成本** 都打在 ProposalCard / EventChain row 里——
   够 / 多余？

## 已知 not-done

- `/_/inspect` 调试页（brief §7 out of scope）
- 真 FSRS — review 的 1/2/3 只 advance 队列
- mobile-first /record 拍照流（brief §9 Q6）
- dark mode
- 没接真 backend；`window.claude.complete` 调用是 D 档 demo 的弹性能力，
  失败回脚本兜底
