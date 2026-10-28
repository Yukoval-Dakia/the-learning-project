# Redraw Wave-2 — 统合计划（YUK-169 · 2026-06-04）

> **Status**: Executing（用户授权 "写计划并自主实施"，2026-06-04）。
> **Base**: main @ `40165001`（7A/7B 已合，knowledge 三连刀已合，U0 裁决已合 `e2b59297`）。
> **设计源**: loom-prototype（checkpoint `f85aca6d`，提取于 `/tmp/loom-proto`）。
> **统合上下文**: `docs/design/2026-06-04-u0-decisions.md`（D1-D11）+ `docs/audit/2026-06-04-design-feasibility-audit.md`。

## 0. 重绘总账（wave-2 立项时点）

| 状态 | 屏 |
|---|---|
| ✅ 已落 main | shell · note-reader（S1）· knowledge-detail（S2）· knowledge（S3/3b/3c）· today（7A/7B；WeekHeat 留缺 YUK-207） |
| 🔨 **本 wave** | copilot composer（AF S0）· mistakes · sessions+events · coach · items+item-detail（含 D11 健康条）· legacy CSS cleanup（收口刀） |
| ⏸ 留后 | record（与 YUK-164 OC-5 复查面 in-flight 冲突，避让）· questions 题库（等 YUK-203 P4 API，同刀做）· review paper（= U5，等 P3 merge + U2/U4，**不先绘 card 版**）· teaching（= AF S4 吸收，不 restyle 旧 drawer）· admin + /admin/subjects 只读页（随 PS MVP）· 练习一级页面（D3 硬需求，需新 design，随出卷链路） |

## 1. Lanes（5 并行 + 1 收口）

| Lane | 屏 / 原型源 | 路由 | 备注 |
|---|---|---|---|
| **L-composer** | `copilot.jsx` | shell 挂的 CopilotDrawer | **AF Slice 0**：composer 输入 + 消息列 + 流式渲染 + tool-card，接现成 `/api/copilot/chat`；保留 summary 视图与 `copilot-drawer-trigger` testid 契约 |
| **L-mistakes** | `screen-mistakes.jsx` | `/mistakes` | 纯重绘，查询/mutation 接线不动 |
| **L-sessions** | `screen-sessions.jsx` + `screen-events.jsx` | `/learning-sessions`（+events surface，lane 现场勘路由） | 两小屏合一 lane |
| **L-coach** | `screen-coach.jsx` | `/coach` | 纯重绘 |
| **L-items** | `screen-items.jsx` + `screen-item-detail.jsx` | `/learning-items`（+ `[id]`） | 含 **D11 健康条**（读时聚合 knowledge_mastery + due，零新 state）；**TeachingDrawer 挂载保留不动**（AF S4 才吸收） |
| **L-cleanup**（chain-merge 后单跑） | — | `app/globals.css` | 删全部 lane 落定后 grep=0 的 legacy 类（`.kf-*`/`.detail-drawer`/`.dd-*`/`.edge-proposal`/`.ep-*`/`.proposal`/`.relation` + 本 wave 新退役的） |

## 2. Lane 协议（每条 lane 强制）

1. **首动作 verify cwd**：`pwd` + `git rev-parse --show-toplevel` + branch 必须 = 分配的 worktree/branch，不符即止。
2. **现场写 preflight**（CLAUDE.md UI 规则，对 fresh base 写）：`docs/design/2026-06-04-redraw-<lane>-preflight.md` —— 逐字引原型（文件+行号）、组件类型声明、touch 清单、**缺口→处理表（no-mock：后端没有的字段 drop + phase-deferred 注释，不假造）**。随实现一起 commit。
3. **CSS 纪律**：复用 S1 primitives（`Btn`/`LoomIcon`/`LoomCard`/`LoomBadge`/`Ring`/`Stateful`/`SkLines`/`SectionLabel`…）与既有 loom 类；新类先 grep globals，冲突类 scope 在页级 wrapper 下（`.mistakes-loom` 等，沿 `.knowledge-loom`/`.today-loom` 先例）；globals 追加段带 `LOOM <X> LAYER — Wave 2` banner。
4. **接线不动**：保留全部 query/mutation/memo/testid；只换视觉层。
5. **Lane gate**：touched-file biome + `pnpm typecheck` + `DATABASE_URL=postgres://placeholder pnpm build` + 相关 `pnpm test:unit`。
6. **独立 reviewer**（每 lane 专属 opus reviewer 审 diff）→ 修 must-fix → 终 commit（`feat(ui): loom redraw <x> — wave 2 (YUK-169)`）。

## 3. 集成协议

chain-merge 顺序（globals.css append-append 冲突由集成者机械解，两段都保留）：composer → mistakes → sessions → coach → items → **cleanup lane 在集成分支上单跑** → 全量 gate（typecheck / lint / audit:schema / audit:partition / audit:profile / **pnpm test**（Docker 可用）/ build）→ `/code-review` skill 审整 wave diff → push + **单 PR `yuk-169-redraw-wave2` → main，停等用户 merge**（feedback_wave_pr_workflow）。

## 4. 风险

- globals.css 多 lane 追加 → 唯一预期冲突点，机械可解；lane 间不碰彼此路由文件。
- composer 是本 wave 唯一"新功能面"（非纯 restyle）—— reviewer 重点：流式渲染错误态、不破坏既有 summary/事件留痕、token 不进前端。
- cleanup 删类必须 grep=0 全仓验证（含未重绘屏仍在用的 legacy 类，删错即回归——故排最后且单独 review）。
- items 健康条的读聚合：只读现成 view/表，不得新增写路径（audit:schema 零增项）。
