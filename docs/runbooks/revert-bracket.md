# Runbook — θ̂ revert-bracket（YUK-561 / #10）

> 单元 `G3/F8 revert-bracket`，设计 SoT：`docs/design/2026-07-04-revert-bracket-spec.md`。
> ADR：`docs/adr/0044-event-sourcing-foundation-redesign.md` §Addendum（YUK-561）。
> 首个 live caller = rejudge overturn（`src/capabilities/practice/jobs/rejudge.ts`）；orchestrator =
> `src/server/revert/cascade-revert.ts`；写侧 = `src/capabilities/practice/server/attempt-snapshot.ts`。

judge-overturn（申诉重判）在双触发门成立时**撤 θ̂ 段**（O2 双 sibling：只撤 θ̂ 不碰 FSRS），
与改判写同一 `db.transaction` 原子提交。revert-only 只抹错误 transition、不 re-apply 正确 outcome
（第二实例原则）——每次触及 θ̂ 的 overturn 都写 `experimental:reproject_deferred` marker 喂第二
实例重投影引擎。本 runbook 是最小充分的**手动**操作 + 观测面（专家 owner + psql/脚本权限；无一键 UI）。

## 拓扑速查（O2 双 sibling）

每 attempt `E` 按段各写一对 checkpoint + snapshot（各 iff 该轴移动）：

```
E (attempt/review, caused_by=null, irreversible)
├── C_θ  experimental:grading_checkpoint  id=${E}:checkpoint:theta  (caused_by=E, event_layer)
│    └── S_θ  experimental:state_snapshot  id=${E}:snapshot:theta   (caused_by=C_θ, A-class, θ̂ 段)
└── C_f  experimental:grading_checkpoint  id=${E}:checkpoint:fsrs   (caused_by=E, event_layer)
     └── S_f  experimental:state_snapshot  id=${E}:snapshot:fsrs    (caused_by=C_f, A-class, FSRS 段)
```

**段选择 = 撤哪个 checkpoint**（无 `revertSegments` 参数）：
- 撤 θ̂ 段：`orchestrateCascadeRevert(db, '${E}:checkpoint:theta')`。
- 撤 FSRS 段：`orchestrateCascadeRevert(db, '${E}:checkpoint:fsrs')`（本波 live caller 不撤 FSRS——`C_f`/`S_f`
  已写 inert，future-ready）。

θ̂ 段撤了不碰 FSRS 段的 `S_f`，二者 append-only 独立墓碑（**无「段过滤」概念**）。

## 手动 revert（专家操作）

对一次 attempt 的 θ̂ 段做手动倒带（例：误判已 baked 进 θ̂，需回退到作答前）：

```ts
import { db } from '@/db/client';
import { orchestrateCascadeRevert } from '@/server/revert/cascade-revert';

const result = await orchestrateCascadeRevert(db, `${attemptEventId}:checkpoint:theta`, {
  reasonContext: { note: 'manual revert — <原因>' },
});
// result.ok === true → mastery_state 行 verbatim 还原到作答前（含 counts/precision/rt/grid）。
// result.ok === false → 见下「refusal 四态处置」。
```

verbatim 全行还原：θ̂ + evidence/success/fail counts + theta_precision + last_theta_delta +
last_outcome_at + rt_correct_ms + theta_grid_json 都回到作答前值（冷启 attempt → 行被 DELETE）。

## refusal 四态处置

`orchestrateCascadeRevert` 返回 `{ ok:false, refusal }` 时：

| refusal | 含义 | 处置 |
|---|---|---|
| `no_checkpoint` | 该段/attempt 未 bracket（pre-S2 旧 attempt，或该段没动） | **正常**——排队等第二实例全量重投影。overturn 路径自动写 `reproject_deferred(full_reprojection, no_checkpoint)`。无需人工。 |
| `legacy_snapshot` | pre-S1 on-disk 快照带 bare-number `before`（不可 verbatim 还原） | **正常**——排队（生产不可达：legacy 快照无 checkpoint，先返 no_checkpoint）。绝不 lossy restore。 |
| `conflict` | 后续 attempt 动过该 KC（current θ̂ ≠ snapshot.after），或 KC-merge renamed（loser 行搬进 winner） | **等第二实例**——撤会 clobber 合法信号。overturn 写 `reproject_deferred(full_reprojection, later_theta_movement)` + best-effort `merged_into`。看 deferred 队列。 |
| `truncated` | cascade 超 depth/node 硬顶 | **人工**——θ̂ checkpoint 闭包只有单 snapshot，结构上不该 truncate。若发生 = 拓扑异常，查 `caused_by` 环。 |
| `irreversible` | 闭包含真 learner fact（attempt/judge 等）——传错 checkpoint | **caller bug**——fail-loud。θ̂ checkpoint 闭包只该有 snapshot + checkpoint，不该含 learner fact。查传入 checkpoint id 是否为 `:checkpoint:theta` 后缀。 |

overturn 路径对 `truncated`/`irreversible`（结构性不可能）**fail-loud throw**（回滚整个 overturn，
pg-boss 重试 / DLQ 可见，绝不假完成）。

## forensic 溯源

一次 revert 留三类痕迹（全 append-only）：

1. **retract 补偿行**：`action='correct' AND subject_id='${E}:snapshot:theta'`（θ̂ 段）/ `:fsrs`（FSRS 段）
   ——`subject_id` 即段身份（无 `reverted_segments` 字段）。`payload.reason_md` 含
   `appeal:<id> (prior→new)` 溯源到 overturn。
2. **reproject_deferred marker**：`action='experimental:reproject_deferred' AND caused_by_event_id=<appeal_id>`
   ——`payload` 带 `residual`（reapply_correct_outcome / full_reprojection）+ `reason`
   （reverted / no_checkpoint / later_theta_movement）+ `answer_event_id` + `prior_outcome`/`new_outcome`
   + 可选 `kc_conflict`/`merged_into`。这是第二实例重投影引擎的完整 worklist 行。
3. **新 judge event + correction(supersede)**：改判本体（既有 D6 链）。

## 观测查询（warning 水位，零干预只告知）

```sql
-- revert 成功数（happy-path）：cascade_revert 写的 retract 行计数。
SELECT count(*) FROM event
WHERE action = 'correct' AND actor_ref = 'cascade_revert';

-- deferred 积压（第二实例引擎的输入）：按 residual/reason 分桶。
SELECT payload->>'residual' AS residual, payload->>'reason' AS reason, count(*)
FROM event
WHERE action = 'experimental:reproject_deferred'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

`conflict`/`no_checkpoint` 占比 + 积压量是第二实例引擎该消费的队列深度。硬顶（depth 64 / node cap 10k /
冲突守卫）已在 orchestrator 内，不改。

## 预期管理（Q2e，诚实标注）

- **多 KC 合取题的 overturn 以 defer 为主**：冲突守卫检查 payload 内**所有** θ̂ 项，任一 KC 被后续
  attempt 动过 → 整体 conflict → defer。「θ̂ 自愈」只在该 attempt 全部 KC 此后未再被练时兑现。不当卖点。
- **手评 solo / 位未翻转的 overturn 零 marker**（O3）：无 θ̂ 残留则无可审计之物，overturn 本身在
  rejudge 事件链可查。
