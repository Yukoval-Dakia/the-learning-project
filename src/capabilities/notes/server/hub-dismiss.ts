// Single owner of the dismiss writes: suppression, event, and immediate removal
// stay in one tx. Helpers live here rather than in the route so they stay
// testable.

import { eq } from 'drizzle-orm';

import { emitArtifactLifecycleEvent } from '@/capabilities/notes/server/artifacts/mutation-events';
import { persistNoteRefineApply } from '@/capabilities/notes/server/note-refine-apply';
import { newId } from '@/core/ids';
import { SuppressArtifactLink } from '@/core/schema/event';
import type { NotePatchT } from '@/core/schema/note-patch';
import type { Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';

const HUB_TYPE = 'note_hub';
const SUPPRESS_ACTOR_REF = 'hub_dismiss_link';

type SuppressRelation = 'subtopic' | 'prerequisite' | 'derived_from' | 'contrasts_with';

export const AUTO_LINKS_CONTAINER_NODE = 'autoLinksContainer';
export const CROSS_LINK_BLOCK_NODE = 'crossLinkBlock';

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Append the target id, deduping on it, and return the new attrs. Tolerant of
 * missing or legacy shapes.
 */
export function appendSuppressedRef(
  attrs: Record<string, unknown> | null | undefined,
  artifactId: string,
): { attrs: Record<string, unknown>; added: boolean } {
  const base = recordOrEmpty(attrs);
  const rawList = Array.isArray(base.suppressed_block_refs) ? base.suppressed_block_refs : [];
  const already = rawList.some((entry) => recordOrEmpty(entry).artifact_id === artifactId);
  if (already) {
    return { attrs: { ...base, suppressed_block_refs: rawList }, added: false };
  }
  return {
    attrs: { ...base, suppressed_block_refs: [...rawList, { artifact_id: artifactId }] },
    added: true,
  };
}

/**
 * Build the replace_block patch that drops this auto link, or null when there is
 * no container or no matching child.
 */
export function buildRemoveAutoLinkPatch(
  bodyBlocks: unknown,
  suppressedArtifactId: string,
): NotePatchT | null {
  const doc = recordOrEmpty(bodyBlocks);
  const content = Array.isArray(doc.content) ? (doc.content as Record<string, unknown>[]) : [];
  const container = content.find((n) => recordOrEmpty(n).type === AUTO_LINKS_CONTAINER_NODE);
  if (!container) return null;

  const containerId = recordOrEmpty(container.attrs).id;
  if (typeof containerId !== 'string' || containerId.length === 0) return null;

  const children = Array.isArray(container.content)
    ? (container.content as Record<string, unknown>[])
    : [];
  const remaining = children.filter((child) => {
    const attrs = recordOrEmpty(child.attrs);
    const isAutoTarget =
      child.type === CROSS_LINK_BLOCK_NODE &&
      attrs.auto === true &&
      attrs.artifact_id === suppressedArtifactId;
    return !isAutoTarget;
  });
  if (remaining.length === children.length) return null;

  const replacement = {
    type: AUTO_LINKS_CONTAINER_NODE,
    attrs: { ...recordOrEmpty(container.attrs), id: containerId },
    content: remaining,
  };
  return { ops: [{ kind: 'replace_block', target_block_id: containerId, block: replacement }] };
}

/**
 * Dismiss one auto link in the passed transaction: record the suppression so the
 * nightly sync skips it, write an append-only suppress event, and remove the
 * chip immediately (undoable). A repeat dismissal adds no second entry and the
 * removal is a no-op. The inner apply owns the version bump.
 */
export async function persistHubLinkDismiss(
  tx: Tx,
  params: { hubId: string; suppressedArtifactId: string; relation?: SuppressRelation },
): Promise<{ suppress_event_id: string; removed: boolean }> {
  const { hubId, suppressedArtifactId, relation } = params;

  // Validate against the canonical event schema; the wire contract stays the
  // single source of truth.
  const parsedEvent = SuppressArtifactLink.safeParse({
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'suppress',
    subject_kind: 'artifact',
    subject_id: hubId,
    outcome: 'success',
    payload: { suppressed_artifact_id: suppressedArtifactId, ...(relation ? { relation } : {}) },
  });
  if (!parsedEvent.success) {
    throw new ApiError('validation_error', 'invalid suppress payload', 400);
  }

  // Serialize dismissals and the nightly sync on this hub. Two appends would
  // otherwise race on the attrs read-modify-write and lose one; the lock also
  // closes the stale window between this read and the inner apply's re-read.
  const [hub] = await tx
    .select({
      id: artifact.id,
      type: artifact.type,
      attrs: artifact.attrs,
      body_blocks: artifact.body_blocks,
      // The attrs update does not bump this; the inner apply does.
      version: artifact.version,
    })
    .from(artifact)
    .where(eq(artifact.id, hubId))
    .for('update');
  if (!hub) {
    throw new ApiError('not_found', `hub ${hubId} not found`, 404);
  }
  if (hub.type !== HUB_TYPE) {
    throw new ApiError('validation_error', `artifact ${hubId} is not a hub`, 400);
  }

  const { attrs: nextAttrs } = appendSuppressedRef(
    hub.attrs as Record<string, unknown> | null,
    suppressedArtifactId,
  );

  // One clock for the attrs write and both events; the inner apply runs at
  // now + 1ms so the unchanged-version set_attrs always folds before the bump.
  const now = new Date();

  // 1. Suppression only; the apply below owns the version bump.
  await tx
    .update(artifact)
    .set({ attrs: nextAttrs as never, updated_at: now })
    .where(eq(artifact.id, hubId));

  // 2. Append-only suppress event.
  const suppressEventId = newId();
  await writeEvent(tx, {
    id: suppressEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'suppress',
    subject_kind: 'artifact',
    subject_id: hubId,
    outcome: 'success',
    payload: parsedEvent.data.payload,
    created_at: now,
  });

  // 2b. Fold event for the attrs write, before the apply's version bump.
  await emitArtifactLifecycleEvent(tx, {
    subjectId: hubId,
    op: 'set_attrs',
    attrs: nextAttrs,
    nextVersion: hub.version,
    actorKind: 'user',
    actorRef: SUPPRESS_ACTOR_REF,
    causedByEventId: suppressEventId,
    createdAt: now,
  });

  // 3. Remove the chip now (undoable); now + 1ms keeps it after the fold above.
  const patch = buildRemoveAutoLinkPatch(hub.body_blocks, suppressedArtifactId);
  let removed = false;
  if (patch) {
    const applied = await persistNoteRefineApply({
      db: tx,
      artifactId: hubId,
      patch,
      actorRef: SUPPRESS_ACTOR_REF,
      triggerEventId: suppressEventId,
      now: new Date(now.getTime() + 1),
    });
    removed = applied.status === 'applied';
  }

  return { suppress_event_id: suppressEventId, removed };
}
