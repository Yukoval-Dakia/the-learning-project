import { eq, inArray, or } from 'drizzle-orm';
import { KnowledgeEdgeRowSnapshot, KnowledgeRowSnapshot } from '@/core/schema/event/genesis';
import { ProposeKnowledge, RateEvent } from '@/core/schema/event/known';
import { KnowledgeMutationProposalChange } from '@/core/schema/proposal';
import type { Tx } from '@/db/client';
import { event, materialized_id_index } from '@/db/schema';

/** Deployment-only provenance checks before any legacy snapshot can conceal missing history.
 * Pending proposals are not structural history. Previously accepted, later retracted proposals
 * still require their original acceptance/index chain; effective-state parity runs separately.
 */
export async function validateKnowledgeHistory(tx: Tx): Promise<void> {
  const rows = await tx
    .select()
    .from(event)
    .where(
      or(inArray(event.subject_kind, ['knowledge', 'knowledge_edge']), eq(event.action, 'rate')),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const indexes = await tx
    .select()
    .from(materialized_id_index)
    .where(inArray(materialized_id_index.subject_kind, ['knowledge', 'knowledge_edge']));
  const indexById = new Map(indexes.map((row) => [row.materialized_id, row]));
  const bases = new Set<string>();
  const touched = new Set<string>();
  const key = (kind: string, id: string) => `${kind}:${id}`;
  function fail(id: string, reason: string): never {
    throw new Error(`[canonical-projections] knowledge history ${id}: ${reason}`);
  }
  const accepts = new Map<string, typeof rows>();
  const generated = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.subject_kind !== 'knowledge_edge' || row.action !== 'generate') continue;
    for (const id of new Set([row.caused_by_event_id, row.payload.propose_event_id])) {
      if (typeof id !== 'string') continue;
      generated.set(id, [...(generated.get(id) ?? []), row]);
    }
  }
  for (const row of rows) {
    if (
      row.action === 'rate' &&
      row.subject_kind === 'knowledge_edge' &&
      ['accept', 'reverse', 'change_type'].includes(String(row.payload.rating))
    ) {
      const origin = row.caused_by_event_id ? byId.get(row.caused_by_event_id) : undefined;
      if (!origin || origin.subject_kind !== 'knowledge_edge' || origin.action !== 'propose')
        fail(row.id, 'missing edge proposal');
      const effects = generated.get(origin.id) ?? [];
      const archived = effects.some((effect) => effect.payload.edge_op === 'archive');
      const created = effects.some((effect) => effect.payload.edge_op !== 'archive');
      const op = row.payload.edge_op ?? origin.payload.edge_op;
      if (op === 'archive' ? !archived : op === 'supersede' ? !archived || !created : !created)
        fail(row.id, 'missing accepted edge effect');
      continue;
    }
    if (row.action !== 'rate' || row.payload.rating !== 'accept' || !row.caused_by_event_id)
      continue;
    const origin = byId.get(row.caused_by_event_id);
    const mintedIds = (row.payload.materialized_ids as { knowledge?: unknown } | undefined)
      ?.knowledge;
    if (!origin && Array.isArray(mintedIds) && mintedIds.length > 0)
      fail(row.id, 'missing originating event for materialized acceptance');
    if (!origin || origin.subject_kind !== 'knowledge') continue;
    if (
      !RateEvent.safeParse({
        actor_kind: row.actor_kind,
        actor_ref: row.actor_ref,
        action: row.action,
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        outcome: row.outcome,
        payload: row.payload,
        caused_by_event_id: row.caused_by_event_id,
      }).success ||
      row.subject_id !== row.caused_by_event_id
    )
      fail(row.id, 'invalid acceptance envelope');
    const list = accepts.get(row.caused_by_event_id) ?? [];
    list.push(row);
    accepts.set(row.caused_by_event_id, list);
  }
  for (const row of rows) {
    if (row.subject_kind !== 'knowledge' && row.subject_kind !== 'knowledge_edge') continue;
    const subjectKey = key(row.subject_kind, row.subject_id);
    if (row.action === 'experimental:genesis') {
      const parsed = (
        row.subject_kind === 'knowledge' ? KnowledgeRowSnapshot : KnowledgeEdgeRowSnapshot
      ).safeParse(row.payload.row);
      if (!parsed.success || parsed.data.id !== row.subject_id)
        fail(row.id, 'invalid genesis identity');
      bases.add(subjectKey);
    } else if (row.subject_kind === 'knowledge_edge' && row.action === 'generate') {
      touched.add(subjectKey);
      if (row.payload.edge_op !== 'archive') {
        if (
          ![
            row.payload.from_knowledge_id,
            row.payload.to_knowledge_id,
            row.payload.relation_type,
          ].every((v) => typeof v === 'string' && v.length > 0)
        ) {
          fail(row.id, 'incomplete edge creation');
        }
        bases.add(subjectKey);
      }
    } else if (row.action === 'experimental:auto_tag_kc_created') {
      if (
        typeof row.payload.name !== 'string' ||
        !row.payload.name ||
        typeof row.payload.parent_id !== 'string' ||
        !row.payload.parent_id
      )
        fail(row.id, 'invalid automatic creation');
      bases.add(subjectKey);
    } else if (row.action === 'experimental:subject_root_name_update') {
      touched.add(subjectKey);
    }

    const decisions = accepts.get(row.id) ?? [];
    if (row.subject_kind !== 'knowledge' || decisions.length === 0) continue;
    if (row.action === 'propose' || row.action === 'experimental:knowledge_split') {
      if (
        row.action === 'propose' &&
        !ProposeKnowledge.safeParse({
          actor_kind: row.actor_kind,
          actor_ref: row.actor_ref,
          action: row.action,
          subject_kind: row.subject_kind,
          subject_id: row.subject_id,
          outcome: row.outcome,
          payload: row.payload,
          caused_by_event_id: row.caused_by_event_id ?? undefined,
          session_id: row.session_id ?? undefined,
          task_run_id: row.task_run_id ?? undefined,
        }).success
      ) {
        fail(row.id, 'malformed accepted knowledge creation');
      }
      const split =
        row.action === 'experimental:knowledge_split'
          ? KnowledgeMutationProposalChange.safeParse({ mutation: 'split', ...row.payload })
          : null;
      if (split && (!split.success || split.data.mutation !== 'split'))
        fail(row.id, 'invalid accepted split');
      const count = split?.success && split.data.mutation === 'split' ? split.data.into.length : 1;
      for (const decision of decisions) {
        const materialized = decision.payload.materialized_ids as
          | { knowledge?: unknown }
          | undefined;
        const ids = materialized?.knowledge;
        if (
          !Array.isArray(ids) ||
          ids.length !== count ||
          new Set(ids).size !== count ||
          !ids.every((id) => typeof id === 'string' && id.length > 0)
        )
          fail(row.id, 'missing or invalid accepted materialized IDs');
        for (const id of ids as string[]) {
          const index = indexById.get(id);
          if (index?.anchor_event_id !== row.id || index.subject_kind !== 'knowledge')
            fail(id, 'missing or mismatched creation index');
          bases.add(key('knowledge', id));
        }
      }
    }
    if (
      row.action.startsWith('experimental:knowledge_') &&
      row.action !== 'experimental:knowledge_archive'
    ) {
      const parsed = KnowledgeMutationProposalChange.safeParse({
        mutation: row.action.replace('experimental:knowledge_', ''),
        ...row.payload,
      });
      if (!parsed.success) fail(row.id, 'malformed accepted mutation');
      const mutation = parsed.data;
      if (row.action !== `experimental:knowledge_${mutation.mutation}`)
        fail(row.id, 'mutation action mismatch');
      if (mutation.mutation === 'merge') {
        if (
          row.subject_id !== mutation.into_id ||
          mutation.from_ids.includes(mutation.into_id) ||
          new Set(mutation.from_ids).size !== mutation.from_ids.length ||
          mutation.from_ids.some((id) => !(id in mutation.expected_versions))
        )
          fail(row.id, 'invalid merge identity or versions');
        for (const id of [mutation.into_id, ...mutation.from_ids])
          touched.add(key('knowledge', id));
      } else {
        const id = mutation.mutation === 'split' ? mutation.from_id : mutation.node_id;
        if (row.subject_id !== id) fail(row.id, 'mutation subject mismatch');
        touched.add(key('knowledge', id));
      }
    } else if (row.action === 'experimental:knowledge_archive') {
      if (row.payload.node_id !== row.subject_id) fail(row.id, 'archive subject mismatch');
      touched.add(subjectKey);
    }
  }
  for (const index of indexes) {
    const origin = byId.get(index.anchor_event_id);
    if (!origin || origin.subject_kind !== index.subject_kind)
      fail(index.materialized_id, 'missing originating event');
    const direct =
      origin.subject_id === index.materialized_id &&
      (origin.action === 'experimental:genesis' ||
        origin.action === 'experimental:auto_tag_kc_created' ||
        (origin.subject_kind === 'knowledge_edge' &&
          origin.action === 'generate' &&
          origin.payload.edge_op !== 'archive'));
    const minted = (accepts.get(origin.id) ?? []).some((rate) => {
      const ids = (rate.payload.materialized_ids as { knowledge?: unknown } | undefined)?.knowledge;
      return Array.isArray(ids) && ids.includes(index.materialized_id);
    });
    if (
      !direct &&
      !(
        index.subject_kind === 'knowledge' &&
        (origin.action === 'propose' || origin.action === 'experimental:knowledge_split') &&
        minted
      )
    )
      fail(index.materialized_id, 'unreconstructible creation anchor');
  }
  for (const id of touched)
    if (!bases.has(id)) fail(id, 'structural history without a creation base');
}
