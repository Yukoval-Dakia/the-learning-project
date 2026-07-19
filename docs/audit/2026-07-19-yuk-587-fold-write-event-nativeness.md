# YUK-587 — LIVE fold 写点 event-nativeness 复核

日期：2026-07-19
范围：`knowledge` / `knowledge_edge` 已开启 projection SoT 后仍存在的非咽喉 raw row write。

## 结论

1. `src/capabilities/knowledge/server/edges.ts` 的三类写点（create / archive / reactivate）当前
   所有生产调用都与对应 `generate(create|archive)` event 位于同一调用者事务，属于
   **event-native-by-caller**，不是 fold 绕写。
2. `src/capabilities/knowledge/server/proposals.ts` 是混合文件：只有 `propose_new` 本地 gate；
   reparent / archive / merge / split 的 imperative UPDATE 无条件执行，再由同事务 accept event +
   projection 覆盖。文件级 role 应按最弱约束分类为 **event-native-by-caller**，不能继续藏在
   `gated-dual-path` 下。
3. `src/capabilities/knowledge/server/seed.ts` 原先只 INSERT live row，没有 originating event/index，
   是 fresh DB 的真实 fold 缺口。本次改为同事务写 `experimental:genesis` 与
   `materialized_id_index`；重跑冲突不会给既有行追加“当前状态 genesis”。
4. advisory 采用负向分类：LIVE sanctioned writer 只要不是 throat / reducer /
   locally-gated-dual-path / derived-maintenance，就自动进入 report。这样新增特殊 role 时默认可见，
   不再依赖容易漏项的 advisory role 白名单。
5. 全仓 strict 扫描额外暴露两个此前未登记文件：`ensure-subject-root.ts` 已是同事务 genesis +
   index（并把参数收紧为仅接受 `Tx`）；`subject-control-write.ts` 的 rename/reset 则会直改 root
   name、没有 fold event。后者登记为 **control-plane-sync** 并持续 advisory，不把已知缺口伪装成
   locally-safe；事件原生化由 YUK-728 跟踪。
6. `archiveKnowledgeEdge` 以单条 guarded `UPDATE ... RETURNING` 原子认领 live→archived 转换；
   caller 只有在 `archived=true` 时才追加 archive event。并发 contender 会 fail-loud 并回滚，避免
   row 保留首个时间戳、fold 却消费末个时间戳的漂移。

## `edges.ts` 调用者矩阵

| 写点 | 生产调用者 | 同事务 fold event |
|---|---|---|
| create | `capabilities/knowledge/api/edges.ts` | manual `generate(edge_op=create)` |
| create + archive | `capabilities/knowledge/server/propose_edge.ts::applyApprovedEdgeSupersede`（入参 `Tx`） | 新边 create + 旧边 archive 两条 `generate` |
| archive + create + reactivate | `capabilities/knowledge/server/proposals.ts::rewireKnowledgeEdges`（入参 `Tx`，create savepoint） | 每个 row write 紧邻同时间戳的 create/archive `generate` |
| archive | `server/proposals/actions.ts`（accept transaction） | archive `generate`，随后 guarded projection |
| archive | `server/revert/cascade-revert.ts`（revert transaction） | archive `generate`，内部 ledger opt-out memory |

`edges.ts` 自身仍不接受裸 `Db` 与“自动写 event”混合接口，因为不同调用者需要不同
`caused_by_event_id`、actor 与 correction provenance；约束位于 caller-owned transaction。审计 role
与本表把这项人审契约显式化，DB suites 继续钉住 row == fold。

## 其他 LIVE `knowledge` 非咽喉写点

| 文件 | 结论 | 约束/缺口 |
|---|---|---|
| `knowledge/server/proposals.ts` | event-native-by-caller | mixed file 按最弱约束分类；mutation event 与 row write 同 accept tx |
| `knowledge/server/seed.ts` | seed，已修复 | 新 root 同事务 genesis + index；既有冲突行不补晚到 snapshot |
| `subjects/ensure-subject-root.ts` | event-native-by-caller | 参数收紧为 `Tx`；genesis + index 与 INSERT 原子提交 |
| `subjects/subject-control-write.ts` | control-plane-sync，YUK-728 | rename/reset 无 knowledge fold event，rebuild 可把 root.name 洗回旧值 |

## 验证契约

- seed 首跑：每个 subject root 恰有一条 genesis、一个 materialized index anchor，且
  `gatherAndFoldKnowledgeNode(root) == knowledgeRowToSnapshot(liveRow)`。
- seed 重跑：row / event / index 数量均不变。
- 并发 archive：恰有一个 caller 认领转换、恰有一条 fold-visible archive event，且 event/row
  `archived_at` 相等；SUPERSEDE 新边 `gatherAndFoldKnowledgeEdge == live row`。
- `audit:fold-writes --json` 与文本输出共享 `result.advisories`；proposals / seed / edges 都被覆盖。
- advisory 继续 report-only；真正未登记的 raw writer 仍由 `--strict` 作为 violation 阻断。
