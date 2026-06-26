import { describe, expect, it } from 'vitest';
import type { ArtifactBodyBlocksT, NoteVerificationResultT } from '../schema/business';
import type { ArtifactRowSnapshotT } from '../schema/event/genesis';
import { foldArtifact } from './artifact';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldArtifact — pure artifact reducer unit tests (YUK-471 Wave 3, W3-B1).
//
// No DB, no IO. Every event is constructed in-memory as a flat FoldEvent. The reducer safeParses
// internally; passing plain objects matching the schema shapes exercises that path and keeps the
// test pure. These are the GOLDEN fold==row assertions — the fold==row invariant core.
//
// BASE = experimental:artifact_create (runtime) OR experimental:genesis (backfill), both carrying
// the FULL ArtifactRowSnapshot (fork #2). body_blocks_edit is full-snapshot (fork #1); lifecycle
// drives archived_at / generation_status / verification_status; note_refine_apply op-replays
// (FOLD-ONLY, B4 铁律). updated_at = the relevant event's created_at; version = the event payload's
// declared next version (verbatim, never computed).
// ====================================================================

let seq = 0;
function nextId(prefix = 'evt'): string {
  seq += 1;
  return `${prefix}_${seq.toString().padStart(4, '0')}`;
}

const T0 = new Date('2026-06-26T00:00:00.000Z');
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

// A doc-root block with a stable attrs.id (the NotePatch anchor, ADR-0020 §2).
function block(id: string, text: string): Record<string, unknown> {
  return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] };
}
function doc(...blocks: Record<string, unknown>[]): ArtifactBodyBlocksT {
  return { type: 'doc', content: blocks } as ArtifactBodyBlocksT;
}

const verifyResult: NoteVerificationResultT = {
  verdict: 'pass',
  summary_md: 'looks good',
  issues: [],
  confidence: 0.9,
};

function artifactSnapshot(over: Partial<ArtifactRowSnapshotT> = {}): ArtifactRowSnapshotT {
  return {
    id: 'art_1',
    type: 'note',
    title: 'Pythagoras',
    parent_artifact_id: null,
    knowledge_ids: ['k_a', 'k_b'],
    intent_source: 'learning_intent',
    source: 'note_generate',
    source_ref: 'evt_origin',
    body_blocks: doc(block('a', 'A')),
    attrs: {},
    tool_kind: null,
    tool_state: null,
    generation_status: 'pending',
    verification_status: 'not_required',
    verification_summary: null,
    generated_by: null,
    verified_by: null,
    history: [],
    archived_at: null,
    created_at: T0,
    updated_at: T0,
    version: 0,
    ...over,
  };
}

// experimental:artifact_create — the runtime-creation BASE event. subject_id MUST equal row.id
// (the schema superRefine enforces it).
function create(opts: { id?: string; created_at: Date; row: ArtifactRowSnapshotT }): FoldEvent {
  return {
    id: opts.id ?? nextId('create'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'note_generate',
    action: 'experimental:artifact_create',
    subject_kind: 'artifact',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

// experimental:genesis — the backfill BASE seed. subject_id === row.id.
function genesis(opts: { id?: string; created_at: Date; row: ArtifactRowSnapshotT }): FoldEvent {
  return {
    id: opts.id ?? nextId('genesis'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'artifact',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

// experimental:body_blocks_edit — full-snapshot body replace. next > previous (schema superRefine).
function bodyEdit(opts: {
  id?: string;
  created_at: Date;
  artifactId: string;
  bodyBlocks: ArtifactBodyBlocksT;
  previousBody?: ArtifactBodyBlocksT | null;
  previousVersion: number;
  nextVersion: number;
  historyAfter?: ArtifactRowSnapshotT['history'];
}): FoldEvent {
  return {
    id: opts.id ?? nextId('edit'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'artifact_block_tree_editor',
    action: 'experimental:body_blocks_edit',
    subject_kind: 'artifact',
    subject_id: opts.artifactId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: {
      previous_artifact_version: opts.previousVersion,
      next_artifact_version: opts.nextVersion,
      body_blocks: opts.bodyBlocks,
      previous_body_blocks: opts.previousBody ?? null,
      history_after: opts.historyAfter ?? [],
    },
  };
}

// experimental:artifact_lifecycle — archive/unarchive + generation/verification status.
function lifecycle(opts: {
  id?: string;
  created_at: Date;
  artifactId: string;
  nextVersion: number;
  payload: Record<string, unknown>;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('life'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'note_lifecycle',
    action: 'experimental:artifact_lifecycle',
    subject_kind: 'artifact',
    subject_id: opts.artifactId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { next_version: opts.nextVersion, ...opts.payload },
  };
}

// experimental:note_refine_undo — the W3-C1γ self-sufficient body RESTORE event. Carries the
// restored body + next version + after-history (the live undo leaves history unchanged). Omit
// `bodyBlocks` to simulate a LEGACY loose undo (bookkeeping only) — the reducer must skip it.
function noteUndo(opts: {
  id?: string;
  created_at: Date;
  artifactId: string;
  undoneEventId?: string;
  bodyBlocks?: ArtifactBodyBlocksT;
  nextVersion?: number;
  fromVersion?: number;
  historyAfter?: ArtifactRowSnapshotT['history'];
}): FoldEvent {
  const fromVersion = opts.fromVersion ?? (opts.nextVersion ?? 1) - 1;
  const payload: Record<string, unknown> = {
    artifact_id: opts.artifactId,
    undone_event_id: opts.undoneEventId ?? 'apply_evt',
    restored_from_artifact_version: fromVersion,
    restored_to_artifact_version: opts.nextVersion ?? fromVersion + 1,
    source_previous_artifact_version: null,
  };
  if (opts.bodyBlocks !== undefined) {
    payload.body_blocks = opts.bodyBlocks;
    payload.next_artifact_version = opts.nextVersion ?? fromVersion + 1;
    payload.history_after = opts.historyAfter ?? [];
  }
  return {
    id: opts.id ?? nextId('undo'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:note_refine_undo',
    subject_kind: 'artifact',
    subject_id: opts.artifactId,
    outcome: 'success',
    caused_by_event_id: opts.undoneEventId ?? 'apply_evt',
    payload,
  };
}

// experimental:note_refine_apply — the pre-existing LOOSE self-sufficient AI patch event.
function noteRefine(opts: {
  id?: string;
  created_at: Date;
  artifactId: string;
  ops: Record<string, unknown>[];
  previousBody?: ArtifactBodyBlocksT | null;
  nextVersion: number;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('refine'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'note_refine',
    action: 'experimental:note_refine_apply',
    subject_kind: 'artifact',
    subject_id: opts.artifactId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: {
      artifact_id: opts.artifactId,
      next_artifact_version: opts.nextVersion,
      ops: opts.ops,
      previous_body_blocks: opts.previousBody ?? null,
    },
  };
}

describe('foldArtifact — base seed (create / genesis)', () => {
  it('projects a create-only artifact verbatim from payload.row', () => {
    const snap = artifactSnapshot();
    const row = foldArtifact('art_1', [create({ created_at: at(0), row: snap })]);
    expect(row).toEqual(snap);
  });

  it('seeds the full row from genesis verbatim (incl version + status + history)', () => {
    const snap = artifactSnapshot({
      version: 5,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: verifyResult,
      history: [{ version: 4, at: at(-1000), summary_md: 'prior' }],
      archived_at: at(-500),
    });
    const row = foldArtifact('art_1', [genesis({ created_at: at(0), row: snap })]);
    expect(row).toEqual(snap);
  });

  it('returns null when no event seeds/creates the artifact (no-anchor)', () => {
    expect(foldArtifact('art_unknown', [])).toBeNull();
  });

  it('returns null when only an edit exists with no base (un-anchored edit is a no-op)', () => {
    const edit = bodyEdit({
      created_at: at(1000),
      artifactId: 'art_1',
      bodyBlocks: doc(block('a', 'A')),
      previousVersion: 0,
      nextVersion: 1,
    });
    expect(foldArtifact('art_1', [edit])).toBeNull();
  });
});

describe('foldArtifact — body_blocks_edit (full-snapshot, fork #1)', () => {
  it('replaces body_blocks + history wholesale, sets version=next, updated_at=event time', () => {
    const snap = artifactSnapshot({ body_blocks: doc(block('a', 'A')), version: 0 });
    const afterBody = doc(block('a', 'A edited'), block('b', 'B'));
    const historyAfter = [{ version: 1, at: at(2000), summary_md: 'user edit' }];
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      bodyEdit({
        created_at: at(2000),
        artifactId: 'art_1',
        bodyBlocks: afterBody,
        previousBody: snap.body_blocks,
        previousVersion: 0,
        nextVersion: 1,
        historyAfter,
      }),
    ]);
    expect(row?.body_blocks).toEqual(afterBody);
    expect(row?.history).toEqual(historyAfter);
    expect(row?.version).toBe(1);
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
    // untouched columns preserved from the base.
    expect(row?.title).toBe('Pythagoras');
    expect(row?.knowledge_ids).toEqual(['k_a', 'k_b']);
  });

  it('applies two sequential edits → last-write-wins body + final version', () => {
    const snap = artifactSnapshot({ body_blocks: doc(block('a', 'v0')), version: 0 });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      bodyEdit({
        created_at: at(1000),
        artifactId: 'art_1',
        bodyBlocks: doc(block('a', 'v1')),
        previousVersion: 0,
        nextVersion: 1,
        historyAfter: [{ version: 1, at: at(1000) }],
      }),
      bodyEdit({
        created_at: at(2000),
        artifactId: 'art_1',
        bodyBlocks: doc(block('a', 'v2')),
        previousVersion: 1,
        nextVersion: 2,
        historyAfter: [
          { version: 1, at: at(1000) },
          { version: 2, at: at(2000) },
        ],
      }),
    ]);
    expect(row?.body_blocks).toEqual(doc(block('a', 'v2')));
    expect(row?.version).toBe(2);
    expect(row?.history).toHaveLength(2);
  });
});

describe('foldArtifact — lifecycle (archive / unarchive / status)', () => {
  it('archive sets archived_at + version, updated_at=event time', () => {
    const snap = artifactSnapshot({ version: 0, archived_at: null });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(3000),
        artifactId: 'art_1',
        nextVersion: 1,
        payload: { op: 'archive', archived_at: at(3000) },
      }),
    ]);
    expect(row?.archived_at?.getTime()).toBe(at(3000).getTime());
    expect(row?.version).toBe(1);
    expect(row?.updated_at.getTime()).toBe(at(3000).getTime());
  });

  it('unarchive clears archived_at back to null', () => {
    const snap = artifactSnapshot({ version: 1, archived_at: at(500) });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(3000),
        artifactId: 'art_1',
        nextVersion: 2,
        payload: { op: 'unarchive', archived_at: null },
      }),
    ]);
    expect(row?.archived_at).toBeNull();
    expect(row?.version).toBe(2);
  });

  it('set_generation_status mutates generation_status only', () => {
    const snap = artifactSnapshot({ generation_status: 'pending', version: 0 });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(1000),
        artifactId: 'art_1',
        nextVersion: 1,
        payload: { op: 'set_generation_status', generation_status: 'ready' },
      }),
    ]);
    expect(row?.generation_status).toBe('ready');
    expect(row?.verification_status).toBe('not_required'); // untouched
    expect(row?.version).toBe(1);
  });

  it('set_verification_status mutates verification_status + carried summary', () => {
    const snap = artifactSnapshot({ verification_status: 'pending', verification_summary: null });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(1000),
        artifactId: 'art_1',
        nextVersion: 1,
        payload: {
          op: 'set_verification_status',
          verification_status: 'verified',
          verification_summary: verifyResult,
        },
      }),
    ]);
    expect(row?.verification_status).toBe('verified');
    expect(row?.verification_summary).toEqual(verifyResult);
  });

  it('a status-only lifecycle op leaves verification_summary untouched (not cleared)', () => {
    const snap = artifactSnapshot({
      verification_summary: verifyResult,
      generation_status: 'pending',
    });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(1000),
        artifactId: 'art_1',
        nextVersion: 1,
        payload: { op: 'set_generation_status', generation_status: 'ready' },
      }),
    ]);
    expect(row?.verification_summary).toEqual(verifyResult); // not cleared by a generation op
  });
});

describe('foldArtifact — note_refine_apply op-replay (FOLD-ONLY, B4 铁律)', () => {
  it('replays append_block onto the running body, sets version=next, history UNCHANGED', () => {
    const baseBody = doc(block('a', 'A'));
    const snap = artifactSnapshot({
      body_blocks: baseBody,
      version: 0,
      history: [{ version: 0, at: at(0) }],
    });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      noteRefine({
        created_at: at(2000),
        artifactId: 'art_1',
        ops: [{ kind: 'append_block', block: block('b', 'B') }],
        previousBody: baseBody,
        nextVersion: 1,
      }),
    ]);
    expect(row?.body_blocks).toEqual(doc(block('a', 'A'), block('b', 'B')));
    expect(row?.version).toBe(1);
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
    // note_refine_apply does NOT touch the history column (the live UPDATE doesn't) — unchanged.
    expect(row?.history).toEqual([{ version: 0, at: at(0) }]);
  });

  it('replays a replace_block op against the doc-root child', () => {
    const baseBody = doc(block('a', 'old'), block('b', 'keep'));
    const snap = artifactSnapshot({ body_blocks: baseBody, version: 0 });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      noteRefine({
        created_at: at(1000),
        artifactId: 'art_1',
        ops: [{ kind: 'replace_block', target_block_id: 'a', block: block('a', 'new') }],
        nextVersion: 1,
      }),
    ]);
    expect(row?.body_blocks).toEqual(doc(block('a', 'new'), block('b', 'keep')));
    expect(row?.version).toBe(1);
  });

  it('a replay throw (target missing) is warn+skipped — the row is left untouched, no crash', () => {
    const baseBody = doc(block('a', 'A'));
    const snap = artifactSnapshot({ body_blocks: baseBody, version: 3 });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      noteRefine({
        created_at: at(1000),
        artifactId: 'art_1',
        // target_block_id 'zzz' does not exist → applyNotePatch throws target_not_found.
        ops: [{ kind: 'replace_block', target_block_id: 'zzz', block: block('zzz', 'X') }],
        nextVersion: 4,
      }),
    ]);
    // unchanged base — the throw is swallowed (warn+skip), version NOT bumped.
    expect(row?.body_blocks).toEqual(baseBody);
    expect(row?.version).toBe(3);
  });
});

describe('foldArtifact — lifecycle set_attrs + provenance/history (W3-C1γ)', () => {
  it('set_attrs replaces the attrs jsonb wholesale, version unchanged (hub-dismiss style)', () => {
    const snap = artifactSnapshot({ attrs: { existing: true }, version: 3 });
    const nextAttrs = { suppressed_block_refs: [{ artifact_id: 'art_x' }] };
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(1000),
        artifactId: 'art_1',
        nextVersion: 3, // hub-dismiss attrs update does NOT bump version
        payload: { op: 'set_attrs', attrs: nextAttrs },
      }),
    ]);
    expect(row?.attrs).toEqual(nextAttrs);
    expect(row?.version).toBe(3);
    expect(row?.updated_at.getTime()).toBe(at(1000).getTime());
  });

  it('set_attrs carries history_after + bumps version (updateArtifactTool style)', () => {
    const snap = artifactSnapshot({ attrs: { format: 'html', html: '<p>v0</p>' }, version: 0 });
    const nextAttrs = { format: 'html', html: '<p>v1</p>' };
    const historyAfter = [{ version: 1, at: at(2000), summary_md: 'Updated interactive HTML' }];
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(2000),
        artifactId: 'art_1',
        nextVersion: 1,
        payload: { op: 'set_attrs', attrs: nextAttrs, history_after: historyAfter },
      }),
    ]);
    expect(row?.attrs).toEqual(nextAttrs);
    expect(row?.version).toBe(1);
    expect(row?.history).toEqual(historyAfter);
  });

  it('set_generation_status carries verification_status + generated_by alongside (note_generate)', () => {
    const snap = artifactSnapshot({
      generation_status: 'pending',
      verification_status: 'not_required',
      generated_by: null,
      version: 0,
    });
    const generatedBy = { by: 'ai', task_kind: 'NoteGenerateTask', task_run_id: 'run_1' };
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(1000),
        artifactId: 'art_1',
        nextVersion: 1,
        payload: {
          op: 'set_generation_status',
          generation_status: 'ready',
          verification_status: 'queued',
          generated_by: generatedBy,
        },
      }),
    ]);
    expect(row?.generation_status).toBe('ready');
    expect(row?.verification_status).toBe('queued');
    expect(row?.generated_by).toEqual(generatedBy);
    expect(row?.version).toBe(1);
  });

  it('set_verification_status carries summary + verified_by, version UNCHANGED (note_verify)', () => {
    const snap = artifactSnapshot({
      verification_status: 'queued',
      verification_summary: null,
      verified_by: null,
      version: 1,
    });
    const verifiedBy = { by: 'ai', task_kind: 'NoteVerifyTask' };
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      lifecycle({
        created_at: at(1000),
        artifactId: 'art_1',
        nextVersion: 1, // note_verify does NOT bump version
        payload: {
          op: 'set_verification_status',
          verification_status: 'verified',
          verification_summary: verifyResult,
          verified_by: verifiedBy,
        },
      }),
    ]);
    expect(row?.verification_status).toBe('verified');
    expect(row?.verification_summary).toEqual(verifyResult);
    expect(row?.verified_by).toEqual(verifiedBy);
    expect(row?.version).toBe(1);
  });
});

describe('foldArtifact — note_refine_undo (self-sufficient body RESTORE, W3-C1γ)', () => {
  it('restores prior body_blocks + version + after-history from the carried snapshot', () => {
    const baseBody = doc(block('a', 'A'));
    const editedBody = doc(block('a', 'A'), block('b', 'B'));
    const snap = artifactSnapshot({ body_blocks: baseBody, version: 0, history: [] });
    const historyAfterEdit = [{ version: 1, at: at(1000), summary_md: 'apply' }];
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      // an apply landed the edited body at v1 (model with note_refine_apply op-replay).
      noteRefine({
        created_at: at(1000),
        artifactId: 'art_1',
        ops: [{ kind: 'append_block', block: block('b', 'B') }],
        previousBody: baseBody,
        nextVersion: 1,
      }),
      // the undo RESTORES the prior body at v2, history carried unchanged (the live undo doesn't push).
      noteUndo({
        created_at: at(2000),
        artifactId: 'art_1',
        bodyBlocks: baseBody,
        fromVersion: 1,
        nextVersion: 2,
        historyAfter: historyAfterEdit,
      }),
    ]);
    expect(row?.body_blocks).toEqual(baseBody);
    expect(row?.version).toBe(2);
    expect(row?.history).toEqual(historyAfterEdit);
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
    // confirm the edited block is gone (restore is a full body replace, not a merge).
    expect(row?.body_blocks).not.toEqual(editedBody);
  });

  it('a LEGACY loose undo (no carried body) is skipped — base body/version untouched', () => {
    const baseBody = doc(block('a', 'A'));
    const snap = artifactSnapshot({ body_blocks: baseBody, version: 5 });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      noteUndo({ created_at: at(1000), artifactId: 'art_1' }), // no bodyBlocks → legacy shape
    ]);
    expect(row?.body_blocks).toEqual(baseBody);
    expect(row?.version).toBe(5); // untouched (legacy undo folds to a no-op)
  });
});

describe('foldArtifact — interleaving, ordering, dedup, isolation', () => {
  it('interleaves edit → lifecycle → edit in chronological order', () => {
    const snap = artifactSnapshot({ body_blocks: doc(block('a', 'v0')), version: 0 });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      bodyEdit({
        created_at: at(1000),
        artifactId: 'art_1',
        bodyBlocks: doc(block('a', 'v1')),
        previousVersion: 0,
        nextVersion: 1,
        historyAfter: [{ version: 1, at: at(1000) }],
      }),
      lifecycle({
        created_at: at(2000),
        artifactId: 'art_1',
        nextVersion: 2,
        payload: { op: 'set_generation_status', generation_status: 'ready' },
      }),
      bodyEdit({
        created_at: at(3000),
        artifactId: 'art_1',
        bodyBlocks: doc(block('a', 'v2')),
        previousVersion: 2,
        nextVersion: 3,
        historyAfter: [{ version: 3, at: at(3000) }],
      }),
    ]);
    expect(row?.body_blocks).toEqual(doc(block('a', 'v2')));
    expect(row?.generation_status).toBe('ready');
    expect(row?.version).toBe(3);
    expect(row?.updated_at.getTime()).toBe(at(3000).getTime());
  });

  it('is order-independent: shuffled input folds identically (sort by created_at,id)', () => {
    const snap = artifactSnapshot({ body_blocks: doc(block('a', 'v0')), version: 0 });
    const c = create({ created_at: at(0), row: snap });
    const e1 = bodyEdit({
      created_at: at(1000),
      artifactId: 'art_1',
      bodyBlocks: doc(block('a', 'v1')),
      previousVersion: 0,
      nextVersion: 1,
      historyAfter: [{ version: 1, at: at(1000) }],
    });
    const l = lifecycle({
      created_at: at(2000),
      artifactId: 'art_1',
      nextVersion: 2,
      payload: { op: 'archive', archived_at: at(2000) },
    });
    const inOrder = foldArtifact('art_1', [c, e1, l]);
    const shuffled = foldArtifact('art_1', [l, e1, c]);
    expect(shuffled).toEqual(inOrder);
    expect(inOrder?.version).toBe(2);
    expect(inOrder?.archived_at?.getTime()).toBe(at(2000).getTime());
  });

  it('tiebreaks events at the SAME created_at by id (stable application order)', () => {
    const snap = artifactSnapshot({ body_blocks: doc(block('a', 'v0')), version: 0 });
    const c = create({ id: 'aaa_create', created_at: T0, row: snap });
    // Two edits at the SAME ms; (created_at,id) order applies 'mmm' before 'zzz'.
    const eMid = bodyEdit({
      id: 'mmm_edit',
      created_at: at(1000),
      artifactId: 'art_1',
      bodyBlocks: doc(block('a', 'mid')),
      previousVersion: 0,
      nextVersion: 1,
    });
    const eLate = bodyEdit({
      id: 'zzz_edit',
      created_at: at(1000),
      artifactId: 'art_1',
      bodyBlocks: doc(block('a', 'late')),
      previousVersion: 1,
      nextVersion: 2,
    });
    const row = foldArtifact('art_1', [eLate, c, eMid]);
    expect(row?.body_blocks).toEqual(doc(block('a', 'late'))); // zzz_edit applied last
    expect(row?.version).toBe(2);
  });

  it('FIRST BASE WINS: a duplicate create base is ignored (idempotent re-seed guard)', () => {
    const snap = artifactSnapshot({ title: 'First', version: 0 });
    const dup = artifactSnapshot({ title: 'Second', version: 9 });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: snap }),
      create({ created_at: at(1000), row: dup }), // second base — ignored
    ]);
    expect(row?.title).toBe('First');
    expect(row?.version).toBe(0);
  });

  it('is pure / deterministic: same input twice → deep-equal output (no Date/newId)', () => {
    const snap = artifactSnapshot({ body_blocks: doc(block('a', 'A')), version: 0 });
    const events = [
      create({ id: 'c1', created_at: at(0), row: snap }),
      bodyEdit({
        id: 'e1',
        created_at: at(1000),
        artifactId: 'art_1',
        bodyBlocks: doc(block('a', 'A2')),
        previousVersion: 0,
        nextVersion: 1,
        historyAfter: [{ version: 1, at: at(1000) }],
      }),
    ];
    const first = foldArtifact('art_1', events);
    const second = foldArtifact('art_1', events);
    expect(first).toEqual(second);
  });

  it('ignores events for other artifact ids (superset input)', () => {
    const s1 = artifactSnapshot({ id: 'art_1', title: 'One' });
    const s2 = artifactSnapshot({ id: 'art_2', title: 'Two' });
    const row = foldArtifact('art_1', [
      create({ created_at: at(0), row: s1 }),
      create({ created_at: at(0), row: s2 }),
      bodyEdit({
        created_at: at(1000),
        artifactId: 'art_2',
        bodyBlocks: doc(block('a', 'other')),
        previousVersion: 0,
        nextVersion: 1,
      }),
    ]);
    expect(row?.id).toBe('art_1');
    expect(row?.title).toBe('One');
    expect(row?.body_blocks).toEqual(doc(block('a', 'A'))); // art_2's edit did not touch art_1
  });
});
