// YUK-95 P5 Lane-D (Wave 7), ADR-0020 §9 — single-owner write path + pure helpers
// for the hub auto-link dismiss flow. `persistHubLinkDismiss` is the sole owner of
// the artifact/event writes (attrs suppressed_block_refs + suppress event +
// immediate-removal note_refine_apply, all atomic in one tx); the pure helpers
// below stay here (not in the route) because Next.js route files may only export
// route handlers, which also keeps them unit/db-testable in isolation.

import { eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { SuppressArtifactLink } from '@/core/schema/event';
import type { NotePatchT } from '@/core/schema/note-patch';
import type { Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { persistNoteRefineApply } from '@/capabilities/notes/server/note-refine-apply';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';

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
 * Append `{ artifact_id }` to `attrs.suppressed_block_refs`, deduping on
 * artifact_id. Returns the new attrs object (caller writes it). Tolerant of
 * legacy/missing shapes.
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
 * Build a single `replace_block` patch that drops the auto crossLinkBlock whose
 * `attrs.artifact_id === suppressedArtifactId` from the doc-root
 * AutoLinksContainer. Returns null when there is no container or no matching
 * auto child (idempotent: the child is already gone, or this hub has no
 * auto-zone).
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
  // No matching auto child → nothing to remove.
  if (remaining.length === children.length) return null;

  const replacement = {
    type: AUTO_LINKS_CONTAINER_NODE,
    attrs: { ...recordOrEmpty(container.attrs), id: containerId },
    content: remaining,
  };
  return { ops: [{ kind: 'replace_block', target_block_id: containerId, block: replacement }] };
}

/**
 * Single-owner write path for dismissing one system-maintained auto-link from a
 * hub. In the passed transaction this: (1) appends `{ artifact_id }` to
 * `attrs.suppressed_block_refs` (dedup) so `hub_auto_sync_nightly` skips it
 * forever; (2) writes an append-only `suppress` event (XC-5 traceable); and
 * (3) immediately removes the dismissed crossLinkBlock from the AutoLinksContainer
 * via `persistNoteRefineApply` (undoable; no-op when the child is already gone).
 *
 * Idempotent: dismissing the same target twice keeps a single suppressed entry
 * and still appends a suppress event, but the removal patch becomes a no-op.
 * The version bump is owned by the inner `persistNoteRefineApply` (so the attrs
 * update here deliberately does NOT bump version — both writes stay consistent
 * inside the one tx). Throws `ApiError` for unknown hub / non-hub artifact.
 */
export async function persistHubLinkDismiss(
  tx: Tx,
  params: { hubId: string; suppressedArtifactId: string; relation?: SuppressRelation },
): Promise<{ suppress_event_id: string; removed: boolean }> {
  const { hubId, suppressedArtifactId, relation } = params;

  // Validate the suppress event against the canonical KnownEvent schema so the
  // wire contract is the single source of truth (same pattern as the correct route).
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

  // FOR UPDATE row lock serializes concurrent dismisses + the nightly auto-sync
  // on the SAME hub. Without it, two dismisses of different auto-links race on the
  // read-modify-write of attrs.suppressed_block_refs (JS append) and the later
  // commit silently drops the earlier suppressed entry (lost update); it also
  // closes the stale window between this body_blocks read and persistNoteRefineApply
  // re-reading the live body — while the lock is held no concurrent tx can mutate
  // either field. The lock is released on tx commit/rollback.
  const [hub] = await tx
    .select({
      id: artifact.id,
      type: artifact.type,
      attrs: artifact.attrs,
      body_blocks: artifact.body_blocks,
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

  // 1. Persist the dedup'd suppressed_block_refs on attrs (no version bump — the
  //    immediate-removal apply below owns the version bump + optimistic guard).
  await tx
    .update(artifact)
    .set({ attrs: nextAttrs as never, updated_at: new Date() })
    .where(eq(artifact.id, hubId));

  // 2. Append-only suppress event (XC-5 traceable).
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
    created_at: new Date(),
  });

  // 3. Immediately remove the dismissed auto crossLinkBlock from the container
  //    (undoable note_refine_apply). No-op when the child is already gone.
  const patch = buildRemoveAutoLinkPatch(hub.body_blocks, suppressedArtifactId);
  let removed = false;
  if (patch) {
    const applied = await persistNoteRefineApply({
      db: tx,
      artifactId: hubId,
      patch,
      actorRef: SUPPRESS_ACTOR_REF,
      triggerEventId: suppressEventId,
    });
    removed = applied.status === 'applied';
  }

  return { suppress_event_id: suppressEventId, removed };
}
