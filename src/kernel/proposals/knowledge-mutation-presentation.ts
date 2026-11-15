import { inArray, sql } from 'drizzle-orm';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import type {
  KnowledgeMutationTargets,
  ProposalKnowledgeMutationBlock,
  ProposalKnowledgeMutationPresentation,
  ProposalKnowledgeNodeLabel,
} from './presentation';

type KnowledgeMutationChange = Extract<
  AiProposalPayloadT,
  { kind: 'knowledge_mutation' }
>['proposed_change'];
type DbLike = Db | Tx;

function chunksOf<T>(values: readonly T[], size = 500): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

export interface KnowledgeMutationNodeRow {
  id: string;
  name: string;
  archived_at: Date | null;
  version: number;
}

/** Names, archive state and versions of every node a page's mutation cards name, batched. */
export async function loadKnowledgeMutationNodeRows(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, KnowledgeMutationNodeRow>> {
  const rows = new Map<string, KnowledgeMutationNodeRow>();
  for (const chunk of chunksOf(ids.filter(isLearnerVisibleKnowledgeId))) {
    const found = await db
      .select({
        id: knowledge.id,
        name: knowledge.name,
        archived_at: knowledge.archived_at,
        version: knowledge.version,
      })
      .from(knowledge)
      .where(inArray(knowledge.id, chunk));
    for (const row of found) rows.set(row.id, row);
  }
  return rows;
}

/**
 * Which of these archived nodes were absorbed by a merge. `merged_from` lives on the
 * absorber, so archive state alone cannot tell a merge from a plain archive.
 */
export async function loadMergedAwayKnowledgeIds(
  db: DbLike,
  ids: readonly string[],
): Promise<Set<string>> {
  const merged = new Set<string>();
  const visible = ids.filter(isLearnerVisibleKnowledgeId);
  if (visible.length === 0) return merged;
  const visibleSet = new Set(visible);
  for (const chunk of chunksOf(visible)) {
    const list = sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await db
      .select({ merged_from: knowledge.merged_from })
      .from(knowledge)
      .where(sql`${knowledge.merged_from} ?| array[${list}]`);
    for (const row of rows) {
      for (const id of row.merged_from) {
        if (visibleSet.has(id)) merged.add(id);
      }
    }
  }
  return merged;
}

export function knowledgeMutationNodeIds(change: KnowledgeMutationChange): string[] {
  switch (change.mutation) {
    case 'merge':
      return [...change.from_ids, change.into_id];
    case 'reparent':
      return change.new_parent_id === null
        ? [change.node_id]
        : [change.node_id, change.new_parent_id];
    case 'split':
      return [
        change.from_id,
        ...change.into.flatMap((entry) => (entry.parent_id === null ? [] : [entry.parent_id])),
      ];
  }
}

export function mutationNodeLabel(
  id: string,
  rows: ReadonlyMap<string, KnowledgeMutationNodeRow>,
  mergedAway: ReadonlySet<string>,
): ProposalKnowledgeNodeLabel {
  const row = rows.get(id);
  // A gone (or learner-hidden) row contributes no name and no id.
  if (!row) return { label: null, state: 'missing' };
  if (mergedAway.has(id)) return { label: row.name, state: 'merged' };
  if (row.archived_at !== null) return { label: row.name, state: 'archived' };
  return { label: row.name, state: 'live' };
}

/** The nodes whose versions the appliers check, against what the proposal expects of them. */
function knowledgeMutationVersionChanged(
  change: KnowledgeMutationChange,
  rows: ReadonlyMap<string, KnowledgeMutationNodeRow>,
): boolean {
  const differs = (id: string, expected: number | undefined) => {
    const row = rows.get(id);
    return row !== undefined && row.version !== expected;
  };
  switch (change.mutation) {
    case 'merge':
      return change.from_ids.some((id) => differs(id, change.expected_versions[id]));
    case 'reparent':
      return differs(change.node_id, change.expected_version);
    case 'split':
      return differs(change.from_id, change.expected_version);
  }
}

function knowledgeMutationBlock(
  targets: KnowledgeMutationTargets,
  versionChanged: boolean,
): ProposalKnowledgeMutationBlock | null {
  const parents =
    targets.mutation === 'reparent'
      ? [targets.parent]
      : targets.mutation === 'split'
        ? targets.into.map((piece) => piece.parent)
        : [];
  if (parents.includes(null)) return 'to_top';
  const nodes = [
    ...parents.filter((parent) => parent !== null),
    ...(targets.mutation === 'merge' ? [...targets.from, targets.into] : []),
    ...(targets.mutation === 'reparent' ? [targets.node] : []),
    ...(targets.mutation === 'split' ? [targets.from] : []),
  ];
  if (nodes.some((node) => node.state === 'missing')) return 'node_unreadable';
  if (nodes.some((node) => node.state !== 'live')) return 'node_retired';
  return versionChanged ? 'version_changed' : null;
}

export function knowledgeMutationPresentation(
  change: KnowledgeMutationChange,
  labelOf: (id: string) => ProposalKnowledgeNodeLabel,
  rows: ReadonlyMap<string, KnowledgeMutationNodeRow>,
): ProposalKnowledgeMutationPresentation {
  const targets = knowledgeMutationTargets(change, labelOf);
  return {
    ...targets,
    blocked: knowledgeMutationBlock(targets, knowledgeMutationVersionChanged(change, rows)),
  };
}

export function knowledgeMutationTargets(
  change: KnowledgeMutationChange,
  labelOf: (id: string) => ProposalKnowledgeNodeLabel,
): KnowledgeMutationTargets {
  switch (change.mutation) {
    case 'merge':
      return {
        mutation: 'merge',
        from: change.from_ids.map(labelOf),
        into: labelOf(change.into_id),
      };
    case 'reparent':
      return {
        mutation: 'reparent',
        node: labelOf(change.node_id),
        parent: change.new_parent_id === null ? null : labelOf(change.new_parent_id),
      };
    case 'split':
      return {
        mutation: 'split',
        from: labelOf(change.from_id),
        into: change.into.map((entry) => ({
          name: entry.name,
          parent: entry.parent_id === null ? null : labelOf(entry.parent_id),
        })),
      };
  }
}
