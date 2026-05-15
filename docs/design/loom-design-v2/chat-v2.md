# Project Design System

_Started 2026-05-15 11:05 UTC_

---

## User

https://github.com/Yukoval-Dakia/the-learning-project 为此项目创建设计。读 docs/design/2026-05-15-design-brief.md 作为 ground truth，按 §8 顺序读其它 5 个文件。不要照 port 
  ▎ docs/design/loom-design/project/ui_kits/ 里的 JSX——那是 mistake-centric 旧 design。审美/voice/tokens/Primitives 命名保留，page 形状 + 
  ▎ 交互按 ADR-0006 v2 event-driven 核重画。

## Assistant

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: update_todos]_

读完了。Brief 极清晰 — ADR-0006 v2 是 3-table 核（material + learning_session + event），ADR-0008 把 conversation 也吸收进 learning_session。Voice/tokens/Primitives 命名保留；page shape + 交互按 event-driven 重画。§9 给的默认（chain 用 inline details / inbox 分布式 + today 预览）我接住，在 prototype 里 surface 出来供 grill。

不开 questions_v2 了——brief 把决策点都列清楚了，先出第一版让你 grill。建计划，开工：

_[tool: copy_files]_

_[tool: copy_starter_component]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now write the app CSS:

_[tool: write_file]_

_[tool: write_file]_

Now primitives:

_[tool: str_replace_edit]_

Now the SEED data — event-shaped per ADR-0006 v2:

_[tool: write_file]_

Now the pages and Copilot drawer. This is the big one — six pages + drawer. Let me write it carefully:

_[tool: write_file]_

## Assistant

Now the pages — biggest file. I'll write all 6 routes + Copilot drawer:

_[tool: write_file]_

_[tool: write_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now let's load it and check for errors:

_[tool: show_html]_

_[tool: done]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: eval_js_user_view]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: get_webview_logs]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

The debug `body.innerHTML = ...` clobbered `#root`. Let me clean up:

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: str_replace_edit]_

Found it — my inline `data-presets="react"` is preventing babel from transforming JSX. Removing it:

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

Rendering. Some layout fixes needed — nav chars are wrapping, inbox strip is cramped:

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: sleep]_

Let me see the page across the various screens — I'll spot-check a few:

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: write_file]_

Let me write a README and surface this to you. README:

_[tool: done]_

_[tool: update_todos]_

_[tool: fork_verifier_agent]_

v2 落到 `loom-design-v2/`。按 ADR-0006 v2 + ADR-0008 重画——保留旧 loom 的审美、token、Primitives 命名，page shape + 交互全换 event-driven 核：

**6 路由 + Copilot drawer**
- `/today` — 4 KPI（全是 event filter）/ 三 lane / 夜间 Dreaming inbox strip / cost ribbon
- `/mistakes` — `events WHERE action=attempt outcome=failure` 视图；每条错题展开 caused_by 链上的孩子事件（judge + variant + propose + note），ProposalCard 内联 accept/dismiss
- `/review` — FSRS 三档 + 上次归因结论 + EventChain 推理钻取
- `/record` — 3 tab + Sub 0c SSE feed + layout_quality 提醒 + Vision Tier 2/3 rescue（明码 cost）
- `/knowledge` — 树视图 + per-node AI 活动 + 节点内嵌 propose 卡
- `/items` — 学习项 TODO（与 event 解耦保留）
- `/inbox` — §6.2 的独立路由选项（today strip 上"集中审批"进）
- Copilot drawer — `session.type='conversation'` + events；试调 `window.claude.complete` 失败回脚本

**§9 七问全做成 Tweaks 在右下面板**——inbox 形态 / Copilot 主动性 / Lane B/C 空数据处理 / 成本可见性 / actor 名展开。我的默认全选了 brief §9 标"默认"的那些，但每个都能切换 grill。

**新 Primitives**（v1 没画的，是 C+D 档核心）：`<ActorBadge>` · `<EventChain>` · `<ProposalCard>` · `<CopilotDrawer>` · `<CostRibbon>` · `<Lane>`。每个 AI event 都有 actor + task_run + cost 元数据。

**没做**：mobile-first /record 拍照流（§9 Q6）、knowledge force-directed graph（§9 Q7）、`/_/inspect`、dark mode、真 FSRS 数学——都按 brief §7 out of scope 处理。详细决策跟 hot-spots 写在 `loom-design-v2/README.md`，等你 grill。

