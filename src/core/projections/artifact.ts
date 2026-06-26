import { z } from 'zod';
import { applyNotePatch } from '../blocks/apply-note-patch';
import {
  ArtifactCreateExperimental,
  ArtifactLifecycleExperimental,
  BodyBlocksEditExperimental,
  NoteRefineUndoExperimental,
} from '../schema/event/artifact-events';
import {
  ArtifactRowSnapshot,
  type ArtifactRowSnapshotT,
  GenesisExperimental,
} from '../schema/event/genesis';
import { NotePatchOp } from '../schema/note-patch';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldArtifact — the W3 structural fold for a single `artifact` row (YUK-471 Wave 3, design §5.1).
// PURE artifact reducer. The fold==row invariant core — the most correctness-critical W3 lane.
// ====================================================================
//
// Projects the current structural state of ONE artifact (`artifactId`) from the event log,
// mirroring the W1 foldKnowledgeNode / W2 foldGoal·foldMistakeVariant·foldLearningItem patterns.
// Instead of mutating the `artifact` table in place, the runtime-creation sites append the BASE
// create event, body edits append a full-snapshot body_blocks_edit, lifecycle changes append an
// artifact_lifecycle event, AI Living-Note patches append a note_refine_apply — and this fold
// REPRODUCES the row the imperative writers (the 8 INSERT sites / editArtifactBodyBlocks /
// note_generate·note_verify status UPDATEs / the retract archive / persistNoteRefineApply) would
// have written. fold(events) == row is the checkable invariant the SoT flip rests on.
//
// ── BASE = create OR genesis (design §5.1, fork #2, proven by W2 mistake_variant) ──────────────
// The row's BASE/init state comes from EITHER:
//   - experimental:artifact_create — the RUNTIME creation base (the 8 INSERT sites, post-W3-C1), OR
//   - experimental:genesis         — the BACKFILL base (pre-W3 rows).
// BOTH carry the FULL initial ArtifactRowSnapshot in payload.row (full-snapshot rule: the fold
// CANNOT rebuild a row from an id-only event). genesis is backfill-only; the create event is the
// runtime-creation seed — using genesis on the creation hot path would corrupt the "genesis ⇒
// pre-W3 row" invariant, so creation gets its OWN event (mirror MistakeVariantCreate, critic A4).
// FIRST BASE WINS (backfill scoping guarantees a create + a genesis never coexist for one id; the
// guard keeps the reducer robust if that invariant ever weakens — no silent re-seed clobber).
//
// ── FULL-SNAPSHOT BODY FOLD (fork #1) ──────────────────────────────────────────────────────────
// body_blocks_edit carries the AFTER body_blocks + history_after VERBATIM (last-write-wins, NO
// op-replay, the user_verified guard has no hook here — that hard boundary lives in the write gate,
// design §4.2). The fold reads the carried after-snapshot directly. This is why hand-edits +
// inbox-accepts can both funnel to ONE event without a guard-replay conflict (critic B4).
//
// PURITY CONTRACT (identical to W1/W2): no IO, no DB, no newId(), no Date.now() / new Date(). Same
// input → byte-identical output. The reducer NEVER mints ids or timestamps — it stamps the row's
// updated_at from the relevant event's `created_at` and reads version off the event payload.
// Determinism is what makes fold(events) == row a checkable invariant.
//
// GATHER STRATEGY (design §5.3): Q1 ONLY (subject_kind='artifact' AND subject_id=artifactId →
// genesis + artifact_create + body_blocks_edit + artifact_lifecycle + note_refine_apply — EVERY
// artifact event keys on the artifact's own id). artifactId == the create event's subject_id (no
// minting indirection, unlike knowledge propose_new/split), so NO Q2 reverse index; artifacts are
// never merged-into, so NO Q3; create/edit/lifecycle are direct (not propose→accept), so NO rate
// caused_by chain. The simplest gather of the whole epic (like foldLearningItem).

// ── note_refine_apply op-replay payload (FOLD-ONLY, B4 铁律) ────────────────────────────────────
//
// The pre-existing self-sufficient `experimental:note_refine_apply` event (persistNoteRefineApply,
// note-refine-apply.ts) is NOT a reserved typed action — it carries its NotePatch `ops` +
// `previous_body_blocks` + `reverse_patch` on a LOOSE payload. The fold reproduces its body change
// by REPLAYING the ops (the live UPDATE set body_blocks = applyNotePatch(row.body_blocks, patch)).
//
// 铁律 (design §5/§7, B4): the `ops` / `reverse_patch` op-replay here is a FOLD-ONLY optimization
// for THIS pre-existing event. It MUST NEVER be reused into an online write path — every NEW
// structural body write goes through the full-snapshot body_blocks_edit event (fork #1), so the
// online path never op-replays and never re-runs the user_verified guard mid-edit. enforceUser-
// VerifiedGuard is FALSE on replay: the event already represents an APPLIED change (the guard had
// its one chance at write time; re-enforcing during a historical replay would falsely reject a
// legitimately-applied edit and diverge fold from row). `previous_body_blocks` is for revert ONLY —
// it does NOT participate in the forward fold (design §5.1).
const NoteRefineApplyPayload = z.object({
  ops: z.array(NotePatchOp),
  // The version the live UPDATE stamped (row.version + 1). The fold sets version to this verbatim
  // rather than computing +1, so a future writer change to the version rule can't silently drift.
  next_artifact_version: z.number().int().nonnegative(),
});

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns (mirrors every
// sibling reducer). Each typed branch feeds this to its dedicated schema so a malformed payload is
// rejected at the reducer boundary rather than trusted (the fold treats these events as ground
// truth — a loose fallback could silently corrupt the projection).
function toParseInput(fe: FoldEvent): unknown {
  return {
    actor_kind: fe.actor_kind,
    actor_ref: fe.actor_ref,
    action: fe.action,
    subject_kind: fe.subject_kind,
    subject_id: fe.subject_id,
    outcome: fe.outcome,
    payload: fe.payload,
    caused_by_event_id: fe.caused_by_event_id ?? undefined,
  };
}

// Stable (created_at asc, id asc) comparator — the canonical event read order (identical tiebreak
// to every sibling reducer).
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldArtifact: skipping malformed event', { action, event_id: eventId, error });
}

// seedRow — clone the snapshot into the running row so the reducer NEVER mutates the input event's
// payload object (purity). The two array columns the fold touches/returns (knowledge_ids, history)
// are copied; the nested jsonb objects (body_blocks / attrs / tool_state / verification_summary /
// generated_by / verified_by) are REPLACED wholesale by edits, never mutated in place, so the
// shallow reference is safe and deterministic (same input → same output graph).
function seedRow(snapshot: ArtifactRowSnapshotT): ArtifactRowSnapshotT {
  return {
    ...snapshot,
    knowledge_ids: [...snapshot.knowledge_ids],
    history: [...snapshot.history],
  };
}

/**
 * Pure structural fold of a single `artifact` row from the event log.
 *
 * @param artifactId  the artifact row id to project.
 * @param events      ALL candidate events (flat FoldEvent rows). The reducer internally SELECTS
 *                    which affect `artifactId` — callers pass a superset (the IO shell narrows via
 *                    the gather first, but the reducer must be correct on a superset too).
 * @returns the projected row, or `null` if `artifactId` was never created/seeded.
 */
export function foldArtifact(artifactId: string, events: FoldEvent[]): ArtifactRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: ArtifactRowSnapshotT | null = null;

  for (const fe of ordered) {
    // Route: only artifact-subject events for THIS id (uniform envelope filter — the create event's
    // superRefine guarantees subject_id === payload.row.id, so this also filters by row identity).
    if (fe.subject_kind !== 'artifact' || fe.subject_id !== artifactId) continue;

    // ---------- BASE: experimental:artifact_create (runtime creation, fork #2) ----------
    if (fe.action === 'experimental:artifact_create') {
      if (row !== null) continue; // FIRST BASE WINS
      const c = ArtifactCreateExperimental.safeParse(toParseInput(fe));
      if (!c.success) {
        warnMalformed('experimental:artifact_create', fe.id, c.error);
        continue;
      }
      // subject_id === payload.row.id is enforced by the schema superRefine; the envelope filter
      // above already pinned subject_id === artifactId, so payload.row.id === artifactId.
      row = seedRow(c.data.payload.row);
      continue;
    }

    // ---------- BASE: experimental:genesis (backfill seed of a pre-W3 row) ----------
    if (fe.action === 'experimental:genesis') {
      if (row !== null) continue; // FIRST BASE WINS
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      // The envelope is a generic genesis (subject_kind already filtered to 'artifact' above); the
      // genesis superRefine guarantees its payload.row is an artifact snapshot when subject_kind is
      // 'artifact', but re-parse defensively against ArtifactRowSnapshot (mirror sibling reducers).
      const seed = ArtifactRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = seedRow(seed.data);
      continue;
    }

    // From here a base must exist (the edit/lifecycle/refine events mutate an already-seeded row).
    if (row === null) continue;

    // ---------- body_blocks_edit — full-snapshot body replace + history + version (fork #1) ----------
    // Mirrors editArtifactBodyBlocks (body-blocks-edit.ts) post-C1: the UPDATE set body_blocks +
    // history + version in one tx, and the event carries the AFTER values VERBATIM. The fold reads
    // them directly (NO op-replay, NO guard) — last-write-wins. updated_at = the event time.
    if (fe.action === 'experimental:body_blocks_edit') {
      const e = BodyBlocksEditExperimental.safeParse(toParseInput(fe));
      if (!e.success) {
        warnMalformed('experimental:body_blocks_edit', fe.id, e.error);
        continue;
      }
      row = {
        ...row,
        body_blocks: e.data.payload.body_blocks,
        // F1: the carried after-history is the ONLY way to reproduce the history column (a history
        // push not in the payload cannot be folded — it would false-fail parity).
        history: [...e.data.payload.history_after],
        version: e.data.payload.next_artifact_version,
        updated_at: fe.created_at,
      };
      continue;
    }

    // ---------- artifact_lifecycle — archive/unarchive + generation/verification status + attrs ----------
    // Mirrors note_generate (generation_status + verification_status + generated_by), note_verify
    // (verification_status + summary + verified_by), the retract archive (archived_at), and the two
    // attrs mutators (updateArtifactTool / hub-dismiss → attrs, + updateArtifactTool's history push).
    // PRESENCE-BASED apply (W3-C1γ): the op→required-field coupling is enforced at the parse barrier
    // (artifact-events.ts superRefine — each op carries its MANDATORY target), but the reducer applies
    // EVERY carried column so a single lifecycle event can reproduce a writer that touched several
    // columns at once (note_generate's set_generation_status ALSO carries verification_status +
    // generated_by). An undefined field = the writer left that column untouched → skip (so a status op
    // never accidentally clears the verification_summary / attrs / history). version = payload.
    // next_version VERBATIM (the writer decides the per-op bump rule — archive/status keep version,
    // set_attrs may bump or not; the fold trusts it so a future writer change can't silently drift).
    // updated_at = event time.
    if (fe.action === 'experimental:artifact_lifecycle') {
      const l = ArtifactLifecycleExperimental.safeParse(toParseInput(fe));
      if (!l.success) {
        warnMalformed('experimental:artifact_lifecycle', fe.id, l.error);
        continue;
      }
      const p = l.data.payload;
      const next: ArtifactRowSnapshotT = {
        ...row,
        version: p.next_version,
        updated_at: fe.created_at,
      };
      // archived_at: archive→non-null Date, unarchive→explicit null (superRefine guarantees the
      // coupling); a non-archive op omits it (undefined → leave the column unchanged).
      if (p.archived_at !== undefined) next.archived_at = p.archived_at;
      if (p.generation_status !== undefined) next.generation_status = p.generation_status;
      if (p.verification_status !== undefined) next.verification_status = p.verification_status;
      // verification_summary: a carried null is an explicit clear and is honored; undefined leaves it.
      if (p.verification_summary !== undefined) next.verification_summary = p.verification_summary;
      if (p.generated_by !== undefined) next.generated_by = p.generated_by;
      if (p.verified_by !== undefined) next.verified_by = p.verified_by;
      // set_attrs replaces the attrs jsonb wholesale (last-write-wins); superRefine guarantees attrs
      // is carried for op='set_attrs'.
      if (p.attrs !== undefined) next.attrs = p.attrs;
      // history_after: carried only when the UPDATE pushed a history entry (updateArtifactTool); a
      // clone keeps the reducer pure (never aliases the event payload's array).
      if (p.history_after !== undefined) next.history = [...p.history_after];
      row = next;
      continue;
    }

    // ---------- note_refine_apply — op-replay (FOLD-ONLY, B4 铁律; see the payload doc above) ----------
    // The live persistNoteRefineApply UPDATE set body_blocks = applyNotePatch(row.body_blocks, patch),
    // version = row.version + 1, updated_at = now — and did NOT touch the `history` column. The fold
    // replays the SAME ops on its running body_blocks (which equals the live row's body at this point
    // if every prior event folded correctly) to reproduce the after-body. history is left unchanged.
    if (fe.action === 'experimental:note_refine_apply') {
      const parsed = NoteRefineApplyPayload.safeParse(fe.payload);
      if (!parsed.success) {
        warnMalformed('experimental:note_refine_apply', fe.id, parsed.error);
        continue;
      }
      try {
        // enforceUserVerifiedGuard:false — fold-only replay of an already-applied change (铁律 above).
        const nextBody = applyNotePatch(
          row.body_blocks,
          { ops: parsed.data.ops },
          { enforceUserVerifiedGuard: false },
        );
        row = {
          ...row,
          body_blocks: nextBody,
          version: parsed.data.next_artifact_version,
          updated_at: fe.created_at,
        };
      } catch (err) {
        // A replay throw means the ops no longer apply to the running body (e.g. a prior full-
        // snapshot edit removed the target block, or the base body was null). Mirror the sibling
        // reducers' warn+skip: leave the row untouched rather than crash the whole projection. This
        // surfaces as drift for the parity harness (C3) to investigate, never a fold crash.
        warnMalformed('experimental:note_refine_apply(replay)', fe.id, err);
      }
      // Skip to the next event — the note_refine_undo branch below is for a DIFFERENT action.
      continue;
    }

    // ---------- note_refine_undo — self-sufficient body RESTORE (full-snapshot, W3-C1γ) ----------
    // Mirrors undoNoteRefineApplyEvent (note-refine-apply.ts): the live UPDATE restored body_blocks =
    // the apply event's previous_body_blocks, bumped version, and left `history` UNCHANGED. The
    // self-sufficient event carries the restored body + next version + after-history so the fold
    // reproduces it VERBATIM (last-write-wins, NO op-replay — unlike note_refine_apply, an undo is a
    // straight body replace). A LEGACY loose undo event (no carried body_blocks — pre-C1γ) is on a
    // pre-W3 artifact with no create/genesis anchor (fold-null), so skip it gracefully.
    if (fe.action === 'experimental:note_refine_undo') {
      const u = NoteRefineUndoExperimental.safeParse(toParseInput(fe));
      if (!u.success) {
        warnMalformed('experimental:note_refine_undo', fe.id, u.error);
        continue;
      }
      const p = u.data.payload;
      // Self-sufficient form only (superRefine guarantees next_artifact_version travels with body).
      // A legacy loose undo (no carried body) is on a pre-W3 artifact (fold-null) — skip it (the
      // `continue` jumps past the restore below to the next event).
      if (p.body_blocks === undefined || p.next_artifact_version === undefined) {
        continue;
      }
      row = {
        ...row,
        body_blocks: p.body_blocks,
        version: p.next_artifact_version,
        // The undo does NOT touch history; the writer carries the row's CURRENT history so the fold
        // reproduces the column. Absent (legacy) → keep the running value.
        history: p.history_after !== undefined ? [...p.history_after] : row.history,
        updated_at: fe.created_at,
      };
      // biome-ignore lint/correctness/noUnnecessaryContinue: defensive — keeps every reducer branch uniformly terminated so appending a branch can't introduce silent fall-through.
      continue;
    }

    // ✅ ALL LIVE ARTIFACT MUTATORS ARE NOW FOLD-VISIBLE (YUK-471 W3-C1γ — flip prerequisite MET).
    // Every `subject_kind:'artifact'` write path now appends a self-sufficient event the branches
    // above reproduce: artifact_create / genesis (base) · body_blocks_edit (hand edit + section edit,
    // C1γ migrated editArtifactSection onto body_blocks_edit) · artifact_lifecycle (archive/unarchive
    // + generation/verification status + generated_by/verified_by + set_attrs for updateArtifactTool's
    // html and hub-dismiss's suppressed_block_refs) · note_refine_apply (AI patch op-replay) ·
    // note_refine_undo (self-sufficient body restore). NOTHING outstanding for the artifact flip.
    // (The legacy `experimental:artifact_body_blocks_edit` / `experimental:artifact_section_edit`
    // actions are no longer emitted — the writers migrated to `experimental:body_blocks_edit`; any
    // on-disk legacy rows sit on pre-W3 artifacts that fold-null and are kept by the guarded
    // write-through, then re-seeded by the C2 genesis backfill.)
  }

  return row;
}
