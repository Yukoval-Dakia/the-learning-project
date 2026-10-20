# YUK-1571 Stage1 — hub 策展算法 + 知识图读引擎归 kernel（交付记录，R2 修正版）

协调线释放的切片：笔记 hub auto-zone 对知识图的确定性策展算法
（`resolveHubMeshAtomics`，ADR-0020 §9 四条纳入规则 + 优先级 + 排除规则）
与其两个图输入读迁入 kernel；notes 不再经 knowledge/public 取得这些值。
纯搬迁，无运行时 registry/DI/新机制；knowledge FULL merge、tagKnowledge、
pool-fetch、subject/retrieval 面不在本片。

**R2 修正（协调线 2026-10-20）**：首版把 backbone 读收窄为
`{id, parent_id}`、丢弃 mastery join/overlay——这会把「损坏数据本失败」变成
「成功」，不按行为保持接受。本片改为 `tree.ts` 完整 `loadTreeSnapshot` 读
引擎逐字迁入 kernel（mastery join/overlay/effective_domain 链/subject 过滤/
5000 cap/告警/全部失败传播原样）；notes 消费同一完整快照，不机械丢失败
路径。边读同样改回真实语义：全列 select + LIMIT+1 fetch + slice 500。

## Caller 知识前后对照

| 调用方 | Before | After |
|---|---|---|
| `notes/server/hub-sync-reconciliation.ts` | `resolveHubMeshAtomics`、`HubMesh*` 类型、`loadTreeSnapshot`、`listKnowledgeEdges` 全部经 `@/capabilities/knowledge/public` | 算法与 `HubMesh*` 类型走 `@/kernel/hub-mesh`；图输入走 `@/kernel/read-models/knowledge-graph`（`loadTreeSnapshot`、`listKnowledgeMeshEdges`）；不再知 knowledge public 面 |
| `knowledge/public.ts` | hub-mesh 符号 re-export 自 `./server/hub-mesh`（实现所在地） | 同一组符号 re-export 自 `@/kernel/hub-mesh`；导出面不变。`loadTreeSnapshot`/`listKnowledgeEdges` 等其他导出维持原指向不动（仅算法出口迁指） |
| `knowledge/server/hub-mesh.ts` | 算法实现本体 | 显式 compat 入口：整组公开绑定 re-export 自 `@/kernel/hub-mesh`（含 `HubMeshInput`/`HubMeshRelation`/`treeDescendantIds`），深层 import 方零改动 |
| `knowledge/server/tree.ts` | `loadTreeSnapshot` 读引擎本体（join/overlay/domain 链/subject 过滤） | 显式 compat 入口：`loadTreeSnapshot`/`warnIfTreeSnapshotTruncated`/`LOAD_TREE_SNAPSHOT_LIMIT`/`KnowledgeNode` re-export 自 `@/kernel/read-models/knowledge-graph`；`propose_edge`/`frontier_fill_nightly`/`api/tree`/`public.ts` 深层路径零改动 |

`notes/server/hub-auto-zone.ts` 的 `import type { CuratedAtomic }` 维持走
knowledge/public（type-only，不计 cross value 边；不在释放清单）。

## 归属（owner）

- `kernel/hub-mesh.ts` — 完整策展决策算法（纯函数，无 DB/IO）+ 其窄输入契约：
  `HubMeshNode {id, parent_id}`（`KnowledgeNode[]` 等更宽行型仍可赋值进入；
  算法只读这两字段）。
- `kernel/read-models/knowledge-graph.ts` — 知识图读引擎的双段：
  1. `loadTreeSnapshot` 完整引擎（`KnowledgeRow`/`KnowledgeNode`/
     `LOAD_TREE_SNAPSHOT_LIMIT`/`warnIfTreeSnapshotTruncated` + 私有
     effective_domain/byId/subject 逻辑），自 tree.ts 逐字迁入，服务 hub-sync
     与既有全部消费方；类型绑定只在本文件与旧 tree.ts，无跨域类型 facade。
  2. `listKnowledgeMeshEdges` — hub 策展的 live-edge 输入读，镜像
     `listKnowledgeEdges` 默认路径真实语义（全列 select / LIMIT+1 fetch /
     slice 500）。

## 两个真实变更场景（before/after）

1. **auto-zone 纳入规则变化**（如 rule iv 的 `related_to` 转开放）：Before 改
   `knowledge/server/hub-mesh.ts` —— 规则住在 knowledge、唯一受益人是 notes，
   变更须过 knowledge 边界评审且 cycles 台账继续挂 notes→knowledge 条目。
   After 改 `kernel/hub-mesh.ts` —— 规则与其数据契约同处 kernel，knowledge
   能力零改动，台账条目消失。真正少改的：一个跨能力评审边界。
2. **大图下 500 边截断开始咬人，hub-sync 需要全量边**：Before 改 `edges.ts`
   的 `LIST_LIMIT` —— 同一常量服务 knowledge api/ui 分页协议，爆炸半径覆盖
   全部 page 消费方。After `listKnowledgeMeshEdges` 自带独立有界契约
   （`LIST_MESH_EDGES_LIMIT`），只影响 hub 策展；knowledge 分页路径不动。
   隐式耦合（hub-sync 静默依赖分页常量）变成显式契约。

## 行为保持证据

- **算法逐字**：`git show <base>:src/capabilities/knowledge/server/hub-mesh.ts`
  与 `src/kernel/hub-mesh.ts` 去除注释/空行/import 后 diff——可执行语句
  唯一差异是新增 `HubMeshNode` interface 声明 + 两处签名 `KnowledgeNode` →
  `HubMeshNode`（`verbatim-moves.log`）。
- **读引擎逐字**：合并后 `tree.ts`（0f722b073，`getMasteryProjection` 已指
  kernel mastery-projection）`interface KnowledgeRow` 至 `loadTreeSnapshot`
  收尾共 144 行与新 kernel 文件引擎区逐字节一致（`verbatim-tree-engine.log`
  零 diff）。mastery join、`getMasteryProjection` overlay、effective_domain
  byId 链、subject 过滤尾、5000 cap、`tree_snapshot_truncated` 告警、全部
  失败传播——**未删一行**：读失败面与旧路径完全相同（相同 SELECT 相同
  顺序），健康库态下产出完全相同。
- **边读等效**：`listKnowledgeEdges(db)` 默认路径 = 全列 select +
  `archived_at IS NULL` + `ORDER BY created_at DESC, id DESC` + fetch 501
  slice 500。kernel 读保留全部真实语义（全列 select 保持列解码失败面、
  LIMIT+1 fetch + slice 500 保持读工与行集），仅不产出被消费者丢弃的
  `next_cursor`；>500 截断是既有行为，忠实保留。
- **每次 compute 新鲜读保留**：`computeHubDesiredState` 的
  `graph ?? {nodes: await …, edges: await …, atomics: await …}` 结构原样，
  仅换 loader 归属路径；`runHubSyncCycle`/`reconcileClaim` 仍不传 `graph`，
  无 per-cycle 缓存。`HubMeshGraphInputs.nodes` 回到
  `Awaited<ReturnType<typeof loadTreeSnapshot>>`（KnowledgeNode[]，与原版
  同型；现存 db 测试不注入该缝，结构兼容）。
- **写侧零触**：`finalizeHubSync` 的 advisory lock → artifact 行锁 → cursor 锁
  → CAS → block_refs → event → ack 顺序、`claimTokenFence`、retry/backoff/
  recovery、write order 全部无 diff hunk。
- `pnpm audit:hub-sync-writers` PASS —— topology writer 清单与 reconciler
  独占写面不变。

## 残留 compat 与退出

- `knowledge/server/hub-mesh.ts`、`knowledge/server/tree.ts` 保留显式
  re-export（深层 import 方——`propose_edge`/`frontier_fill_nightly`/
  `api/tree`/`public.ts` 及可能的测试——绑定不变）；`knowledge/public.ts`
  全部符号面不变。
- 退出路径：compat 入口在全部深层消费方确认后可删；不在本片。
- 台账/baseline 归协调线：`scripts/capability-public-read-cycles.ts` 的
  owner:knowledge/consumer:notes 条目（本片后 stale）与
  `capability-boundary-baseline.json` 的 42→41/SCC 收紧由 parent 同 PR 整合，
  本片不动 scripts/CI/baseline/test。

## 指标（实测，`pnpm audit:capability-boundaries:snapshot`）

| 指标 | merge 后基线 (0f722b073) | 本片 | 说明 |
|---|---|---|---|
| cross-capability value edges | 42 | 41 | `notes -> knowledge` 1→0 |
| nontrivial SCC | 5 {agency,ingestion,knowledge,notes,practice} | 4 {agency,ingestion,knowledge,practice} | notes 退出；不声称 SCC→0 |
| intra-SCC cross | 25 | 24 | #17 切除 |
| capability→server | 432 | 432 | 不变（#1881 已自 440 收紧） |
| server→capability deep | 0 | 0 | 不变 |
| 非 SCC cross | 17 | 17 | 不变 |

（首版曾在 a519a05d2 基测 42/SCC5/440；本片经普通 merge origin/main #1881
后在合并树上复测，capability→server 基线已是 432。）

## Revision / 外部路径

- base：`origin/main` `a519a05d2`（分支点），普通 merge `0f722b073`（#1881）
- head：以 `git rev-parse HEAD` 为准（本文件随 head 提交）
- 检查日志与逐文件 checkpoint：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/a519a05d2f70bc26747211740cfb04a43f32486f/hub-curation/`（before/ 首版基测；post-merge/ 修正版全量检查；files-final/ 终版 blob + sha256；verbatim-moves.log / verbatim-tree-engine.log 逐字证据）

## Commands（本机已跑，修正版）

- `pnpm exec biome check <6 touched files>` PASS（format/organize 由
  `biome check --write` 修复后复检 PASS）
- `pnpm typecheck` PASS（两 tsconfig）
- `pnpm build` PASS（web + server/worker/migrate 三 esbuild 产物）
- `pnpm audit:capability-boundaries:snapshot` PASS（post-merge 实测封存）
- `pnpm audit:hub-sync-writers` PASS；`audit:relations` PASS；
  `audit:mastery-provenance` PASS；`audit:schema` / `audit:partition` /
  `audit:profile` / `audit:draft-status` PASS
- `pnpm audit:capability-boundaries` **EXPECTED-FAIL**（3 条全部为
  「debt decreased → tighten baseline」：notes→knowledge 0<1、total 41<42、
  SCC 4<5；baseline 收紧归 parent）
- `pnpm audit:architecture-deepening` **EXPECTED-FAIL**（同 3 条 baseline delta
  + 1 条 stale catalog entry：capability-public-read-cycles.ts 的
  owner:knowledge/consumer:notes 条目退役归 parent）

## NOT_RUN

本机不跑任何测试套件 / DB / 运行时 / provider / 付费链路；无 tsx-eval /
合成输入验证；测试零改动。行为验收由 exact-head CI Gate 与独立审查承担。
