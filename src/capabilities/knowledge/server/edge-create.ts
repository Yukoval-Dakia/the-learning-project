import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { wakeHubSyncAfterCommit } from '@/server/boss/hub-sync-wake';
import { CreateKnowledgeEdgeBodySchema } from '../api/contracts';
import { acquireEdgeEndpointLocks, withEdgeEndpointLockRetry } from './edge-topology-write';
import { createKnowledgeEdge } from './edges';

export async function createManualKnowledgeEdge(db: Db, raw: unknown) {
  const parsed = CreateKnowledgeEdgeBodySchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  // Event-sourced: row and generate event share one transaction, actor and timestamp,
  // so the edge folds to its row. Ignore the request's created_by and use the manual
  // user actor, matching what the fold derives.
  const now = new Date();
  const fromId = parsed.data.from_knowledge_id;
  const toId = parsed.data.to_knowledge_id;
  const endpointIds = Array.from(new Set([fromId, toId]));
  // Same locks and topology gate as proposal accept, so a direct call cannot close a
  // prerequisite cycle.
  const id = await withEdgeEndpointLockRetry(
    () =>
      db.transaction(async (tx) => {
        await acquireEdgeEndpointLocks(tx, fromId, toId, endpointIds);
        const edgeId = await createKnowledgeEdge(tx, {
          from_knowledge_id: fromId,
          to_knowledge_id: toId,
          relation_type: parsed.data.relation_type,
          weight: parsed.data.weight,
          reasoning: parsed.data.reasoning ?? null,
          actor_kind: 'user',
          actor_ref: 'self',
          created_at: now,
        });
        return edgeId;
      }),
    {
      uniqueViolationMessage: `edge already exists: ${fromId} --${parsed.data.relation_type}--> ${toId}`,
    },
  );
  // Fire-and-forget wake; the trigger already marked hubs dirty, this just
  // shortcuts recovery. The seam swallows its own errors.
  void wakeHubSyncAfterCommit();
  return { id };
}
