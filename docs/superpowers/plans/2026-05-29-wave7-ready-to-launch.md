# Wave 7 Ready-to-Launch — Living Note 反链/cross_link/hub auto-sync + Knowledge Graph 收尾

> 状态：decisions locked 2026-05-29（territory map 5-agent 勘察后）。按 master roadmap §5.1 Wave 7，本 wave 把 YUK-88 P5（cross_link 编辑 + 反链 + nightly hub auto-sync）全 ship + T-KG 知识图谱收尾（brownfield refine，非重建）+ T-PD gap-filler。收口后 Layer 5 Living Note 的关系层（cross_link L3+L2 索引 + hub 双区 auto-sync）兑现 + v2.1 brief §2.3.b graph view contract 真正达成。

## Source of truth

- `docs/superpowers/plans/2026-05-27-master-roadmap.md` §5.1 Wave 7（T-88 P5 8pt worktree A + T-KG 13pt→收尾 worktree B + T-PD ~4pt）+ §2.5 T-KG + §3.2 长链。
- `docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` §P5 lane 切分 (L161-170) + §XC-1..XC-5 cross-cutting 约束。
- `docs/adr/0020-block-tree-note-rebuild.md` §5（cross_link L3 attrs + L2 artifact_block_ref index）+ §9（hub auto-sync 双区 + iii-curated mesh + dismiss）。
- `docs/adr/0022-tiptap-pm-node-schema.md`（**权威 PM node 契约**：crossLinkBlock / AutoLinksContainer attrs 扁平形态）。
- `docs/design/2026-05-15-design-brief-v2.1.md` §2.3.b（graph view 契约）+ `docs/design/loom-design-v2.1/README.md`（Mesh 视觉决策表 + scale rule + relation→颜色/线/箭头）。
- T-88 P5 Linear：[YUK-95](https://linear.app/yukoval-studios/issue/YUK-95)（Backlog, 8pt, parent YUK-88，全 scoped，deps P2+P3 已 Done）。
- T-KG Linear：⬜ 待建（本 wave launch 前建）。

## Preflight state（2026-05-29 territory map 实测）

| Item | State | Evidence |
|---|---|---|
| `origin/main` | ✅ Wave 6 closeout `a419b2e6` | 完整 wave gate 实测全绿：typecheck/lint/3 audits/build/`pnpm test`(138 files,1091 tests)/migration(11) |
| T-88 P0-P4 | ✅ shipped Waves 1-6 | YUK-90/91/92/93/94 全 Done；body_blocks 单 SOT + 5 custom TipTap node + Living Note mutator + undo |
| `artifact_block_ref` 表 | ✅ DDL 已 ship（migration smoke 验证）| `src/db/schema.ts` L316，ADR-0020 §5 精确形态：unique(from,from_block,to,COALESCE(to_block,'')) + to_idx |
| cross_link write-through | ⬜ 不存在 | 唯一写入是 `embedded_check_generate.ts` L305（quiz ref）；`editArtifactBodyBlocks` / `note-refine-apply` / `note_generate` 都不 sync index |
| 反链读取 | ⬜ 不存在 | 全 src 零 `SELECT FROM artifact_block_ref`；无 backlink query / panel / API |
| hub_auto_sync_nightly worker | ⬜ 不存在 | 模板 = `knowledge_edge_propose_nightly`（02:30 BJT）；`hub-mesh` 复用 helper 也不存在（loadEdges + tree BFS 是 private inline） |
| AutoLinksContainer UI | ⬜ 占位 | node 存在（`tiptap-extensions.tsx`）但 NodeView 无 relation chip / dismiss；renderer 静态 |
| cross_link 选择器 | ⬜ 不存在 | crossLinkBlock node 存在但无 in-editor mention/picker UI（= P2-polish 缺口） |
| suppressed_block_refs + suppress 事件 | ⬜ 不存在 | artifact.attrs jsonb slot 在，无 write path；KnownEvent union 无 suppress action |
| **T-KG 图谱** | 🟡 **brownfield（已实现大半）** | `app/(app)/knowledge/page.tsx` 1250 行已有 Tree\|Graph toggle + 手写 SVG verlet 力导 + mesh-over-tree + 节点半径∝错题 + click→drawer + legend。缺：缩放/拖拽、contrasts 配色、组件抽取 |
| 图库 | ⬜ 未装 | package.json / lockfile 零 cytoscape/d3/react-flow；当前纯手写 SVG |
| YUK-115（drift fix）| 🟡 In Progress，未进 main | 改 NoteVerificationIssue section_id→block_id；与 Wave 7 文件基本不重叠，低碰撞；落地则 rebase Lane A |

## Decisions locked（2026-05-29）

| # | 议题 | 裁决 | 理由 |
|---|---|---|---|
| **D1** | T-KG scope | **Brownfield 收尾，非重建。~4-5pt**（原 13pt）。加 `d3-zoom`+`d3-drag`（不引整个 d3）补交互 + 修 contrasts 配色 + 抽 `KnowledgeGraph` 到 `src/ui/`。**不上 cytoscape** | /knowledge 已有能跑的 verlet 图；design-system scale rule 明确 <50 节点手写 SVG 够，>100 才 cytoscape；当前文言文 <50 节点；anti-overengineering |
| **D2** | P5 选择器 vs P2-polish picker 重叠 | **Wave 7 P5 Lane A 一次建好 cross_link 编辑 UI**；Wave 8 P2-polish 删 cross_link picker，仅留 slash/drag-drop/generic mention | ADR-0022 已把 picker UI defer 到 P2-polish；两者是同一未建物件，禁双建 |
| **D3** | cross_link attrs 形态 | **ADR-0022 扁平 `attrs={id,artifact_id,block_id?,title?}` 为权威**；`extractCrossLinkRefs` 读 `node.attrs.artifact_id`（非 `node.attrs.cross_link.*`）；XC-3 嵌套描述标过时 | ADR-0022 是 P2 后补、Accepted 的最新契约；tiptap-extensions.tsx 实际就是扁平 |
| **D4** | artifact_block_ref 写入 | 单一 owner `src/server/artifacts/block-refs.ts`：`syncBlockRefsForArtifact(tx, fromArtifactId, bodyBlocks)` **全量重算**（DELETE WHERE from_artifact_id + INSERT 当前扫描集，**含 artifactRefBlock/quiz ref 一并重算不误删**）+ `listBacklinks(db,{toArtifactId,toBlockId?})`。挂进 `editArtifactBodyBlocks`（用户存）+ `persistNoteRefineApply`（AI mutator）+ `note_generate`（AI 生成）三事务 | 避免 split/merge/delete 导致索引漂移；统一扫描比 op-level 增量简单且与 cascade 语义一致；解除 audit:schema 4 列 allowlist |
| **D5** | nightly worker 跨进程 | hub_auto_sync 跑 **02:45 BJT**（02:30 edge-propose 之后见新边，避撞）；用户睡着，靠 `persistNoteRefineApply` 乐观 version 锁（一个 replace_block 改 AutoLinksContainer），**v0 不做 DB live-edit 信号** | worker 进程 ≠ Next app 进程，看不到内存心跳；nightly 时段无并发编辑，乐观锁足够 |
| **D6** | contrasts_with 配色漂移 | globals.css `@theme` + `:root` **双块加 `--contrasts`（紫）token** 兑现 design brief；修 `edgeColor()` 用之 | 设计 brief §2.3.b + v2.1 README 都写紫色，代码误用 --hard 琥珀；无 purple token |
| **D7** | suppressed_block_refs + suppress 事件 | dismiss write path：`POST /api/hubs/[id]/dismiss-link` → `artifact.attrs.suppressed_block_refs[]` + `event(action='suppress', subject_kind='artifact')`；KnownEvent union 注册 suppress action + payload zod | ADR-0020 §9 dismiss 机制；解除 audit:schema attrs 漂移 + 过 zod parse barrier |
| **D8** | YUK-115 协调 | 当前 main 推进 Wave 7；YUK-115 落地则 rebase Lane A | 改 verifier schema，与 cross_link/hub/artifact_block_ref 文件不重叠，低碰撞 |

## Wave 7 scope

| Lane | 子项 | pts | Linear | Branch intent | Worktree |
|---|---|---|---|---|---|
| **P5/Lane-0** | `src/server/artifacts/block-refs.ts`（`syncBlockRefsForArtifact` 全量重算 + `listBacklinks`）+ 挂进 3 事务入口（editArtifactBodyBlocks / persistNoteRefineApply / note_generate）+ 解除 audit:schema allowlist | 2 | YUK-95 | `yuk-95-p5-block-refs-writethrough` | A |
| **P5/Lane-A** | block-level cross_link 选择器（TipTap Suggestion/@-mention 内联 picker 搜 artifact/block 插 crossLinkBlock）| 2 | YUK-95 | `yuk-95-p5-crosslink-picker` | A |
| **P5/Lane-B** | 反链 panel（`GET /api/artifacts/[id]/backlinks` + ArtifactBlockTree 内 panel，仿 AI-changes panel；读时过滤 retracted/superseded via artifact-corrections）| 1.5 | YUK-95 | `yuk-95-p5-backlink-panel` | A |
| **P5/Lane-C** | nightly hub auto-sync worker（`hub_auto_sync_nightly` @ 02:45 BJT + `src/server/knowledge/hub-mesh.ts` iii-curated：knowledge_ids⊆ + tree-descendant + prerequisite-in + derived_from-out + contrasts_with-sym，排除 related_to/applied_in/experimental；diff vs AutoLinksContainer children，honor suppressed_block_refs；走 persistNoteRefineApply replace_block）| 2 | YUK-95 | `yuk-95-p5-hub-auto-sync` | A |
| **P5/Lane-D** | AutoLinksContainer chip/dismiss UI（relation chip via prerequisite/派生/对比/子主题 + hover dismiss → suppressed_block_refs + suppress event；reorder-only）| 1.5 | YUK-95 | `yuk-95-p5-autolinks-ui` | A |
| **T-KG** | 知识图谱收尾（d3-zoom/d3-drag 交互 + `--contrasts` 紫 token + 抽 `KnowledgeGraph` 到 src/ui）| 4-5 | ⬜ 待建（launch 前建）| `tkg-knowledge-graph-finish` | B |
| **T-PD** | gap-filler：修 P2-basic plan stale "ADR-0021 draft" 引用（应是 ADR-0022）+ ADR-0020 §5/XC-3 嵌套→扁平 revision 注记 | ~2 | （并入 closeout）| — | gap |

Parents: [YUK-95](https://linear.app/yukoval-studios/issue/YUK-95)（P5, 8pt, parent YUK-88）+ T-KG（待建, ~5pt, independent per roadmap §3.2）。

总计：**~15-16 pts**（P5 9pt + T-KG 5pt + T-PD 2pt；T-KG 因 D1 brownfield 从 13pt 降到 ~5pt，故 wave 从 §5.1 估的 ~25pt 降到 ~16pt）。

## Chain order

1. **Worktree A（YUK-95 P5）primary track，lane 顺序**：Lane-0（block-refs 写入层）→ Lane-A（选择器，写 crossLinkBlock 即触发 write-through）→ Lane-B（反链 panel，依赖索引已写）→ Lane-C（hub auto-sync，依赖 hub-mesh + block-refs）→ Lane-D（AutoLinks chip/dismiss）。**Lane-0 必须先 land**（B/C/D 都依赖索引被正确写入）。
2. **Worktree B（T-KG）file-disjoint，并行**：只碰 `app/(app)/knowledge/page.tsx` + `src/ui/`（抽组件）+ globals.css（加 token）。与 A 唯一可能交叉是 globals.css（A 的 Lane-D 也加 chip class）——按 chain-merge 顺序 A 先 merge，B rebase 后加 token 段，避撞。
3. **T-PD doc gap-filler** 任意 worktree gap 做（doc-only）。

## Cross-cutting 约束（lane 启动必读，per phase doc §XC）

- **XC-1 block_id 稳定性**：split/merge id 规则实际在 `src/ui/block-tree/pm.ts`（**非** `src/server/blocks/anchor.ts`，后者从未建）。Lane-C 的 auto-sync 用 replace_block 改 AutoLinksContainer（不 split/merge），低风险；任何新 mutator 复用 pm.ts 语义。
- **XC-2 body_blocks 单 SOT**：禁引入 atomic/long/hub-only 物理字段；cross_link/AutoLinks 全走 body_blocks JSONB + replace_block。
- **XC-3 L3+L2 cross_link 索引**：SOT = `block.attrs`（扁平，per D3）；反链索引 = `artifact_block_ref` write-through（per D4）。**禁用 knowledge_edge 存 note ref**（mesh 仅概念关系）。
- **XC-4 knowledge_ids label**：`artifact.knowledge_ids` 是 **jsonb（非 pg text[]）**——hub-mesh containment 用 app-side set 逻辑或 jsonb 算子，**不用** pg array `@>`。atomic 恰 1 个 knowledge_id；hub N 个。
- **XC-5 event-driven 撤回**：correction event log（`artifact-corrections.ts` 已迁 block_id anchor）；反链 panel + auto-sync 渲染时复用 `getArtifactCorrectionStates` 过滤已 retract/supersede 的源块。

## Wave gate

```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build
```

UI smoke（manual，pre-merge of Lane-D + T-KG）：

- `pnpm dev` →（先查 :3000 谁占着，OrbStack 容器可能占着，dev 跳 :3001）打开一篇 atomic note → 在编辑器里 @ 触发 cross_link 选择器 → 选另一篇 artifact 插入 → 存盘 → `SELECT * FROM artifact_block_ref WHERE from_artifact_id=?` 有行。
- 打开被链接的 artifact → 反链 panel 显示来源（含 context snippet）。
- 手动跑 hub_auto_sync 一次（或临时改 cron）→ hub note 的 AutoLinksContainer 出现 curated cross_link + relation chip。
- hover 一个 auto-link chip → dismiss → 下次 auto-sync 不再加回（suppressed_block_refs 生效）。
- `/knowledge` Graph toggle → 缩放/拖拽可用 → contrasts_with 边显紫色。

Then `/audit-drift` + 更新 `docs/superpowers/status.md` + master-roadmap §5.1 Wave 7 标 ✅ + Linear close YUK-95 + T-KG issue。**push origin 前停**（per 用户 max-autonomy 边界）。

## Final lane state

| Lane | Status | Notes |
|---|---|---|
| P5/Lane-0 block-refs | ⬜ | — |
| P5/Lane-A picker | ⬜ | — |
| P5/Lane-B backlink panel | ⬜ | — |
| P5/Lane-C hub auto-sync | ⬜ | — |
| P5/Lane-D AutoLinks UI | ⬜ | — |
| T-KG graph finish | ⬜ | Linear 待建 |
| T-PD doc gap-filler | ⬜ | — |
