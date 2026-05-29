# Wave 8 Ready-to-Launch — YUK-88 P6/P7 + P2-polish + T-PD 收尾 + v1 closeout

> 状态：planning（2026-05-29，Wave 8 territory map 4-agent 勘察后）。Wave 8 是 scenario A 的**最后一 wave = v1 closeout**。按 master-roadmap §5.1 Wave 8 + §14。
> **前置**：Wave 7（P5 cross_link/backlink/hub + T-KG 诊断图谱）必须先全 ship+closeout 到 main。Wave 7 当前：P5 已 merge 本地 main（5 lane + 4 review fix + reviewer 批准）；T-KG（1a/1b/Slice2/Slice3 + fixes）待最终 reviewer + merge。

## Source of truth
- `docs/superpowers/plans/2026-05-27-master-roadmap.md` §5.1 Wave 8 + §14 Final Closeout + §2.7 T-PD1..13。
- `docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` §P6/§P7/§P2-polish。
- `docs/design/2026-05-26-atomic-note-read-view.md`（7 read-view 缺陷 + 5→3 semantic_kind idiom）。
- ADR-0020（block_id / 节点页 §10）+ ADR-0022（PM node schema）。
- Linear：YUK-96（P6）/ YUK-97（P7）/ YUK-88（parent）；YUK-115（section_id drift, overlaps P7）。

## Preflight state（map 实测 2026-05-29）

| Item | State |
|---|---|
| Wave 7 P5 | ✅ merged 本地 main（63205347，YUK-95 Lane-0..D + 4 fix）|
| Wave 7 T-KG | 🟡 1a/1b/Slice2/Slice3 + fixes 在 yuk-142-tkg，待 Slice3 reviewer + merge |
| YUK-96 (P6) / YUK-97 (P7) | Backlog |
| YUK-95 (P5) | In Progress（push 时 commit `Closes YUK-95` 触发自动关闭）|
| YUK-88 parent | In Progress（P0-P4 Done；P5 待 push 关；P6/P7 backlog）|
| **YUK-115** section_id→block_id drift | **In Progress，与 P7 重叠** —— 需先落或 P7 吸收 |
| P6 read-view 复用锚点 | ✅ Wave 7 已产出：`listBacklinks`/backlinks API、`getArtifactCorrectionStates`、`ArtifactBlockTree` 的 mark-wrong + backlink panel 模式、`MasteryBadge`、`/api/knowledge/edges`、`BlockTreeRenderer`（已渲染 5 node 类型）|
| P2-polish cross_link picker | ✅ 已在 Wave 7 P5 Lane-A 做（`CrossLinkSuggestion.tsx`）→ Wave 8 drop |
| T-PD8 modules sweep | ✅ Wave 6（PR #184）|
| 本 session 新增 | YUK-142(T-KG done)/143(north-star spec)/144(多页 bug)/145(T-OC spec)/146(derived_from)/147(undo UX)/148(跨进程 editing-guard) + fix/2026-05-29-review-findings 分支 |

## Decisions locked（2026-05-29）

| # | 议题 | 裁决 | 理由 |
|---|---|---|---|
| **W8-1** | P6 read-view CSS 深度 | **结构/功能为主，read-view CSS 缺陷只做删除型廉价项**（去 tier chip、隐藏 ready/not_required 状态条、去 eyebrow 技术词 ＝ DEFECT 3/4/5，纯删）；5→3 semantic_kind idiom + 控件低对比（DEFECT 1/2/6）**defer 到 UI 重绘** | UI 后续 claude design 重绘（[[memory]]）；结构（节点页路由/单节点端点/复用 wiring/placeholder 生成）survive redraw、CSS idiom 会被重画 |
| **W8-2** | P2-polish 范围 | = **slash-command + drag-drop only**。cross_link picker **drop**（Wave 7 已做）；generic @mention **defer**（与 @ cross_link 触发冲突 + redraw 再定 UX）。建独立 Linear issue（child YUK-88，~3pt）| Wave 7 D2；redraw-pending |
| **W8-3** | YUK-115 协调 | **YUK-115 先落**（独立 1pt fix），P7 拿到 clean schema 再 sweep；Linear link YUK-115↔YUK-97 | 避免 P7 与 YUK-115 双重 sweep 冲突 |
| **W8-4** | T-KG 归属 | T-KG（YUK-142）**已在 Wave 7 做完**，不在 Wave 8（master-roadmap §5.1 表 stale）| 本 session 实证 |
| **W8-5** | P7 规模 | **中等（~6-10 文件）**，非大 sweep（P1-P5 已清旧 schema）。先写 P7 lane plan（`2026-05-26-yuk88-p7-tests.md` 缺）| map 勘察 |
| **W8-6** | v1 closeout 走向 | **continue-to-scenario-B**（用户 rolling-commitment）。写 closeout audit + `v0.5-maintenance-roadmap.md` 指向 scenario B（north-star YUK-143 + T-OC YUK-145 为 post-v1 top track）| §5.0 Q5 + 本 session 用户决策 |

## Wave 8 scope

| Lane | 子项 | pts | Linear | Worktree |
|---|---|---|---|---|
| **P6/A** | BlockTreeRenderer read-view：删除型缺陷（去 tier chip/状态条/技术词 eyebrow）+ section 间距 var(--s-5)；idiom CSS defer | 1.5 | YUK-96 | A |
| **P6/B** | mark-wrong 钻取（复用 ArtifactBlockTree mark-wrong + getArtifactCorrectionStates）+ 低对比控件（轻）| 1 | YUK-96 | A |
| **P6/C** | `/knowledge/[id]` 全节点页：metadata + MasteryBadge + mesh chips(/api/knowledge/edges) + 主 atomic body_blocks inline + 反链 panel(复用 listBacklinks) + timeline；新增单节点 GET（替 O(N) 客户端扫）| 3 | YUK-96 | A |
| **P6/D** | 无主 atomic 占位卡 + 一键生成（POST note_generate）| 0.5 | YUK-96 | A |
| **P7** | tests sweep（中等）：先写 P7 lane plan；修 note_verify/producers section_id→block_id fixture；2 个 pure-unit handler test + copilot/chat.test.ts 入 fastTestInclude（清 P1 WARN）；补 hub_auto_sync cross_link / backlinks 覆盖 spot-check | 4 | YUK-97 | A（P6 后）|
| **P2-polish** | slash-command + drag-drop（generic mention defer，cross_link picker dropped）| 3 | 待建（child YUK-88）| B |
| **T-PD 收尾** | quick wins：T-PD11(ADR-0014 proposed→accepted) + T-PD5/6(verify-close) + T-PD4(maxCost/fallbackChain 标 inactive) + T-PD12(ADR metadata, trim) + Wave 7 gap-filler(ADR-0021→0022 stale ref / ADR-0020 §5 XC-3 nested→flat note) + **本 session 新 spec/issue 整进 master-roadmap §2/§11** | 5 | — | B |
| **v1 closeout** | §14 7 步 + 写 closeout audit + v0.5-maintenance-roadmap | — | coordinator |

总计 ~19pt（P6 6 + P7 4 + P2-polish 3 + T-PD 5 + closeout）。

## Chain order
1. **Wave 7 先全 closeout 到 main**（T-KG merge + Wave 7 wave-gate + push 后 YUK-95 自动关）。
2. **YUK-115 先落**（W8-3），P7 才 clean。
3. **Worktree A**：P6（A→B→C→D chain）→ P7（P6 后；依赖 P1-P6 全落 + YUK-115）。
4. **Worktree B**：P2-polish（slash→drag-drop）+ T-PD 收尾（doc-only，并行安全）。
5. **v1 closeout**（coordinator）：全 wave-gate 绿后跑 §14。

## Cross-cutting / 复用（lane 启动必读）
- **P6 大量复用 Wave 7**：节点页反链 = `listBacklinks` + backlinks API + ArtifactBlockTree 反链 panel 模式；mark-wrong = getArtifactCorrectionStates + ArtifactBlockTree 模式；mastery = MasteryBadge；mesh chips = /api/knowledge/edges；renderer = BlockTreeRenderer（勿重建，CSS+少量 JSX pass）。
- **YUK-115 ↔ P7**：先落 YUK-115（section_id→block_id），P7 sweep 对齐；勿双改 artifact-corrections legacy compat（保留）。
- **UI redraw pending**：P6/P2-polish 做功能+tokens，不视觉 QA（[[memory]]）。

## Wave gate（每 lane chain-merge 后 + closeout 前）
```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build
```
+ `/audit-drift` + status.md / master-roadmap update。

## v1 closeout checklist（§14）
1. master-roadmap §0.3 final snapshot（Wave 7+8 ✅，scenario A v1 达成）。
2. 写 `docs/superpowers/audits/2026-XX-v1-closeout.md`：v1 ship 表 + 遗留 backlog + retrospective。
3. `docs/planning/v0.4-complete-form-roadmap.md` 标 "v1 closeout achieved"。
4. `docs/superpowers/status.md` 顶部加 "v1 closeout 完成" header。
5. v1 范围 Linear issue 全关（YUK-88 + 子 issue）。
6. 剩余 track → maintenance backlog / scenario B project。
7. 写 `docs/planning/v0.5-maintenance-roadmap.md`（指向 scenario B：north-star YUK-143 + T-OC YUK-145 top track + 5 judges/question_part/Subject#4/Drawer×6/Track-F 半套，按 feature 价值重切 per 本 session 讨论）。

## Linear actions（Wave 8 启动前 / 期间）
- 建 P2-polish issue（child YUK-88，~3pt，明确 drop cross_link picker / defer generic mention）。
- 建 "v1 closeout" coordinator issue（§14 actions）。
- YUK-143/145 归入 project（避免 orphan）。
- YUK-115 link YUK-97（related/blocks）。
- closeout 时：`Closes YUK-88` + 全子 issue 关。

## Final lane state
| Lane | Status |
|---|---|
| P6/A..D | ⬜ |
| P7 | ⬜（先写 lane plan）|
| P2-polish | ⬜（先建 issue）|
| T-PD 收尾 | ⬜ |
| v1 closeout | ⬜ |
