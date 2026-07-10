// YUK-600 (YUK-597 v2 §3.1/§3.5 语义；v3 §3.6 thin-create 第④步复用) —
// ensureSubjectRoot：建科目即建根。
//
// - root id **钉死** `seed:<subjectId>:root`（读侧一律按 id 定位，不用
//   domain+parent_id IS NULL 判据——3a topic-root 会撞）。
// - **event-sourced from birth**：真插入时同事务写 genesis 事件 +
//   materialized_id_index anchor——knowledge 侧 PROJECTION_IS_WRITER 已 LIVE，
//   裸 INSERT 会被 projection drift 判死。事件形状逐字段对齐
//   scripts/backfill-genesis-events.ts:219-235（builtin 根走 seedKnowledge 裸插
//   + backfill 补账是历史路径；运行时新建必须当场落账）。ingest_at=now →
//   memory outbox opt-out（结构种子非学习活动，ADR-0021）。
// - **幂等安全网非创建面**：ON CONFLICT DO NOTHING + returning() 空 = 根已在
//   → 不重写 genesis（goal 防线对既有科目反复调用零副作用）。
// - 调用方负责事务边界与 canonical id（alias 归一在上游完成）。

import { newId } from '@/core/ids';
import type { KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbLike = Db | Tx;

export function subjectRootId(subjectId: string): string {
  return `seed:${subjectId}:root`;
}

export async function ensureSubjectRoot(
  tx: DbLike,
  subjectId: string,
  displayName: string,
): Promise<{ created: boolean; rootId: string }> {
  const rootId = subjectRootId(subjectId);
  const now = new Date();
  // Race-safe 幂等（同 seedKnowledge 纪律）：单回合 ON CONFLICT，无 check-then-act。
  const written = await tx
    .insert(knowledge)
    .values({
      id: rootId,
      // root.name = 科目人读名（rename 联动 v2 §3.4 由 YUK-601 控制行写面负责）。
      name: displayName,
      // domain = subjectId：自别名使 resolveKnownSubjectId(domain) === subjectId，
      // 上传子 KC 经父链继承此 domain（effective-domain 派生轴；subject=view 不破）。
      domain: subjectId,
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing({ target: knowledge.id })
    .returning({ id: knowledge.id });
  if (written.length === 0) return { created: false, rootId };

  const snapshot: KnowledgeRowSnapshotT = {
    id: rootId,
    name: displayName,
    domain: subjectId,
    parent_id: null,
    merged_from: [],
    archived_at: null,
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  };
  const genesisEventId = newId();
  await writeEvent(tx, {
    id: genesisEventId,
    actor_kind: 'system',
    actor_ref: 'subject-root-create',
    action: 'experimental:genesis',
    subject_kind: 'knowledge',
    subject_id: rootId,
    outcome: 'success',
    payload: { row: snapshot },
    created_at: now,
    ingest_at: now, // outbox opt-out：结构种子非学习活动（ADR-0021）
  });
  await upsertMaterializedIdIndex(tx, {
    materialized_id: rootId,
    anchor_event_id: genesisEventId,
    subject_kind: 'knowledge',
  });
  return { created: true, rootId };
}
