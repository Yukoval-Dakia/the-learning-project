# YUK-1571 Stage1 — hub 策展算法 + 窄图输入归 kernel（交付记录）

协调线已释放的切片：笔记 hub auto-zone 对知识图的确定性策展算法
（`resolveHubMeshAtomics`，ADR-0020 §9 四条纳入规则 + 优先级 + 排除规则）
与其两个图输入读（knowledge backbone、live mesh edges）迁入 kernel；
notes 不再经 knowledge/public 取得这些值。纯搬迁 + 输入契约收窄，无运行时
registry/DI/新机制；knowledge FULL merge、tagKnowledge、pool-fetch、
subject/retrieval 面不在本片。

## Caller 知识前后对照

| 调用方 | Before | After |
|---|---|---|
| `notes/server/hub-sync-reconciliation.ts` | `resolveHubMeshAtomics`、`HubMesh*` 类型、`loadTreeSnapshot`、`listKnowledgeEdges` 全部经 `@/capabilities/knowledge/public` | 算法与 `HubMesh*` 类型走 `@/kernel/hub-mesh`；图输入走 `@/kernel/read-models/knowledge-graph`（`loadKnowledgeBackboneNodes`、`listKnowledgeMeshEdges`）；不再知 knowledge public 面 |
| `knowledge/public.ts` | hub-mesh 符号 re-export 自 `./server/hub-mesh`（实现所在地） | 同一组符号（`CuratedAtomic`/`HubMeshAtomicInput`/`HubMeshEdge` 类型 + `resolveHubMeshAtomics`）re-export 自 `@/kernel/hub-mesh`；导出面不变 |
| `knowledge/server/hub-mesh.ts` | 算法实现本体 | 显式 compat 入口：整组公开绑定 re-export 自 `@/kernel/hub-mesh`（含原模块导出但 public 未转发的 `HubMeshInput`/`HubMeshRelation`/`treeDescendantIds`），深层 import 方零改动 |

`notes/server/hub-auto-zone.ts` 的 `import type { CuratedAtomic }` 维持走
knowledge/public（type-only，不计 cross value 边；不在释放清单）。

## 归属（owner）

- `kernel/hub-mesh.ts` — 完整策展决策算法（纯函数，无 DB/IO）+ 其窄输入契约：
  `HubMeshNode {id, parent_id}`（原 `KnowledgeNode` 参数收窄为算法实际触碰的
  两字段；更宽的 `KnowledgeNode[]` 仍可赋值进入）。
- `kernel/read-models/knowledge-graph.ts` — 该算法的图输入读模型：
  `loadKnowledgeBackboneNodes`（非归档节点 id/parent_id，ORDER id，5000 cap +
  同文同构 truncation warn）与 `listKnowledgeMeshEdges`（非归档边端点三元组，
  created_at DESC + id DESC，500 cap）。

## 两个真实变更场景（before/after）

1. **auto-zone 纳入规则变化**（如 rule iv 的 `related_to` 转开放）：Before 改
   `knowledge/server/hub-mesh.ts` —— 规则住在 knowledge、唯一受益人是 notes，
   变更须过 knowledge 边界评审且 cycles 台账继续挂 notes→knowledge 条目。
   After 改 `kernel/hub-mesh.ts` —— 规则与其数据契约同处 kernel（#1837/#1852
   已确立 kernel 为受评审共享缝），knowledge 能力零改动，台账条目消失。
   真正少改的：一个跨能力评审边界。
2. **大图下 500 边截断开始咬人，hub-sync 需要全量边**：Before 改 `edges.ts`
   的 `LIST_LIMIT` —— 同一常量服务 knowledge api/ui 分页协议，爆炸半径覆盖
   全部 page 消费方。After `listKnowledgeMeshEdges` 自带独立有界契约
   （`LIST_MESH_EDGES_LIMIT`），只影响 hub 策展；knowledge 分页路径不动。
   隐式耦合（hub-sync 静默依赖分页常量）变成显式契约。

## 行为保持证据

- **算法逐字**：`git show <base>:src/capabilities/knowledge/server/hub-mesh.ts`
  与新 `src/kernel/hub-mesh.ts` 去除注释/空行/import 后 diff——可执行语句
  唯一差异是新增 `HubMeshNode` interface 声明 + 两处签名 `KnowledgeNode` →
  `HubMeshNode`（见外部 `verbatim-moves.log`）。
- **backbone 读等效**：`loadTreeSnapshot` 的 SELECT 经
  `LEFT JOIN knowledge_mastery`。view DDL（drizzle/0005）末端为
  `FROM knowledge k LEFT JOIN agg(GROUP BY knowledge_id) LEFT JOIN activity(GROUP BY k.id)`
  —— 每个 knowledge.id 至多一行 ⇒ join 对 `archived_at IS NULL + ORDER BY id +
  LIMIT 5000` 的行集与序零增删零重排；kernel 读只取算法消费的
  `{id, parent_id}`，行集/过滤/排序/cap/告警逐一镜像。synthetic:* 包含、
  无 subject 过滤（hub-sync 本就不传 subject）一致。
- **edge 读等效**：`listKnowledgeEdges(db)` 默认路径 = `archived_at IS NULL`
  + `ORDER BY created_at DESC, id DESC` + fetch 501 slice 500（第 501 行仅供
  `next_cursor`，`listKnowledgeEdges` 丢弃之）。kernel 读 `LIMIT 500` 返回同一
  行集；>500 截断是既有行为，忠实保留。
- **mastery overlay 移除的失败语义**：旧路径 = join SELECT +
  `getMasteryProjection`（mastery_state SELECT + `getRepresentativeKcBeta`
  第二批读）。新路径 = 单 SELECT。失败面严格收缩：新代码可能抛出的 pg 错误类
  全部是旧首条 SELECT 可抛出的子集；被移除的 overlay 读只会失败、不会在相同
  健康库态下产出不同结果。唯一语义差异出现在已降级库态（knowledge_mastery
  view / mastery_state 损坏时旧路径失败、新路径成功）——严格更健壮，非回归。
  分类路径不变：pg SQLSTATE → `pg_transient`，其余 → `unknown`，两者皆
  retryable。
- **每次 compute 新鲜读保留**：`computeHubDesiredState` 的
  `graph ?? {nodes: await …, edges: await …, atomics: await …}` 结构原样，
  仅换 loader；`runHubSyncCycle`/`reconcileClaim` 仍不传 `graph`，无 per-cycle
  缓存。`HubMeshGraphInputs.nodes` 收窄为 `KnowledgeBackboneNode[]`（注入缝更
  宽松：旧 `KnowledgeNode[]` 注入仍类型兼容；现存 db 测试不注入该缝）。
- **写侧零触**：`finalizeHubSync` 的 advisory lock → artifact 行锁 → cursor 锁
  → CAS → block_refs → event → ack 顺序、`claimTokenFence`、retry/backoff/
  recovery、write order 全部无 diff hunk（`git diff` 仅 import 块 + 3 处
  loader/类型换名）。
- `pnpm audit:hub-sync-writers` PASS —— topology writer 清单与 reconciler
  独占写面不变。

## 残留 compat 与退出

- `knowledge/server/hub-mesh.ts` 保留显式 re-export（深层 import 方——含可能
  直接引用的测试——绑定不变）；`knowledge/public.ts` 的 hub-mesh 符号面不变。
- 退出路径：compat 入口在全部深层消费方确认后可删；不在本片。
- 台账/baseline 归协调线：`scripts/capability-public-read-cycles.ts` 的
  owner:knowledge/consumer:notes 条目（本片后 stale）与
  `capability-boundary-baseline.json` 的 42→41/SCC 收紧由 parent 同 PR 整合，
  本片不动 scripts/CI/baseline/test。

## 指标（实测，`pnpm audit:capability-boundaries:snapshot`，base=head 各自 head）

| 指标 | base a519a05d2 | 本片 | 说明 |
|---|---|---|---|
| cross-capability value edges | 42 | 41 | `notes -> knowledge` 1→0 |
| nontrivial SCC | 5 {agency,ingestion,knowledge,notes,practice} | 4 {agency,ingestion,knowledge,practice} | notes 退出；不声称 SCC→0 |
| intra-SCC cross | 25 | 24 | #17 切除 |
| capability→server | 440 | 440 | 不变 |
| server→capability deep | 0 | 0 | 不变 |
| 非 SCC cross | 17 | 17 | 不变 |

## Revision / 外部路径

- base：`origin/main` `a519a05d2f70bc26747211740cfb04a43f32486f`
- head：以 `git rev-parse HEAD` 为准（本文件随 head 提交）
- 检查日志与逐文件 checkpoint（含 before/after snapshot log、verbatim-moves、
  files-sha256）：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/a519a05d2f70bc26747211740cfb04a43f32486f/hub-curation/`

## Commands（本机已跑）

- `pnpm exec biome check <5 touched files>` PASS（首跑 2 处 format/organize 已由
  `biome check --write` 修复并复检 PASS）
- `pnpm typecheck` PASS（两 tsconfig）
- `pnpm build` PASS（web + server/worker/migrate 三 esbuild 产物）
- `pnpm audit:capability-boundaries:snapshot` PASS（before/after 各一份封存）
- `pnpm audit:hub-sync-writers` PASS；`audit:relations` PASS；
  `audit:schema` / `audit:partition` / `audit:profile` / `audit:draft-status` /
  `audit:mastery-provenance` PASS
- `pnpm audit:capability-boundaries` **EXPECTED-FAIL**（3 条全部为
  「debt decreased → tighten baseline」：notes→knowledge 0<1、total 41<42、
  SCC 4<5；baseline 收紧归 parent）
- `pnpm audit:architecture-deepening` **EXPECTED-FAIL**（同 3 条 baseline delta
  + 1 条 stale catalog entry：capability-public-read-cycles.ts 的
  owner:knowledge/consumer:notes 条目退役归 parent）

## NOT_RUN

本机不跑任何测试套件 / DB / 运行时 / provider / 付费链路；无 tsx-eval /
合成输入验证；测试零改动。行为验收由 exact-head CI Gate 与独立审查承担。
