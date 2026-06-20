import type { NoteRefineTriggerKind } from '@/capabilities/notes/jobs/note-refine';
import type { Db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';

export const NOTE_REFINE_TRIGGER_DEBOUNCE_MS = 60 * 60_000;

// M3 (YUK-317, D6)：error_rate 信号已删（内嵌自测链路裁撤）。
// YUK-358 决定6 (ADR-0040)：dwell 信号已裁（editing presence 不再触发 refine）。
const FLAG_BY_KIND: Record<NoteRefineTriggerKind, string> = {
  mark_wrong: 'WAVE6_TRIGGER_MARK_WRONG_ENABLED',
  mastery_change: 'WAVE6_TRIGGER_MASTERY_ENABLED',
  dreaming: 'WAVE6_TRIGGER_DREAMING_ENABLED',
  // YUK-358 决定7 (ADR-0040)：verify 是 note_verify→refine 的新 trigger，OPT-IN。
  verify: 'WAVE6_TRIGGER_VERIFY_ENABLED',
};

// YUK-358 决定7 — per-kind DEFAULT state (the value when the flag env var is
// UNSET/empty). The real-signal kinds are default-ON (an unset flag means "run");
// `verify` is default-OFF so removing note_verify's dead proposal does NOT
// silently light up a new background AI-cost path. To turn verify→refine on,
// the owner sets WAVE6_TRIGGER_VERIFY_ENABLED="true" explicitly. (Red line 2.)
// YUK-358 决定6 — dwell removed (editing presence no longer triggers refine).
const DEFAULT_ENABLED_BY_KIND: Record<NoteRefineTriggerKind, boolean> = {
  mark_wrong: true,
  mastery_change: true,
  dreaming: true,
  verify: false,
};

type BossSend = (
  queue: 'note_refine',
  data: {
    artifact_id: string;
    trigger: {
      kind: NoteRefineTriggerKind;
      context_md?: string;
      evidence_ids?: string[];
      trigger_event_id?: string;
    };
  },
) => Promise<unknown>;

const lastEnqueuedAt = new Map<string, number>();

export type NoteRefineTriggerResult =
  | { status: 'enqueued'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:disabled'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:debounced'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:test_env'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'failed'; artifact_id: string; kind: NoteRefineTriggerKind; error: string };

export function resetNoteRefineTriggerStateForTests(): void {
  lastEnqueuedAt.clear();
}

export function noteRefineTriggerEnabled(
  kind: NoteRefineTriggerKind,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[FLAG_BY_KIND[kind]];
  // YUK-358 决定7 — unset/empty falls back to the per-kind default (verify=OFF,
  // the other 4=ON). When set, an explicit literal wins for EVERY kind: "false"
  // disables, "true" enables — so verify is a pure opt-in ("true") and the others
  // keep their kill-switch ("false") semantics. Any other non-empty value keeps
  // the kind's default (no accidental flip from a typo'd flag).
  if (value === undefined || value === '') return DEFAULT_ENABLED_BY_KIND[kind];
  const normalized = value.toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'true') return true;
  return DEFAULT_ENABLED_BY_KIND[kind];
}

export async function enqueueNoteRefineTrigger(input: {
  db?: Db;
  artifactId: string;
  kind: NoteRefineTriggerKind;
  contextMd?: string;
  evidenceIds?: string[];
  triggerEventId?: string;
  now?: Date;
  bossSend?: BossSend;
  env?: NodeJS.ProcessEnv;
}): Promise<NoteRefineTriggerResult> {
  const now = input.now ?? new Date();
  if (!noteRefineTriggerEnabled(input.kind, input.env ?? process.env)) {
    return { status: 'skipped:disabled', artifact_id: input.artifactId, kind: input.kind };
  }
  const key = `${input.kind}:${input.artifactId}`;
  const last = lastEnqueuedAt.get(key);
  if (last !== undefined && now.getTime() - last < NOTE_REFINE_TRIGGER_DEBOUNCE_MS) {
    return { status: 'skipped:debounced', artifact_id: input.artifactId, kind: input.kind };
  }

  // Same hazard class as YUK-239 (STB-5): a bare VITEST key would silently skip
  // real enqueues if prod ever set it. Route through the central guard (NODE_ENV
  // === 'test' OR VITEST) — injected bossSend (test fakes) still bypasses the skip.
  if (!input.bossSend && !shouldEnqueueBackgroundJobs()) {
    return { status: 'skipped:test_env', artifact_id: input.artifactId, kind: input.kind };
  }

  try {
    let send = input.bossSend;
    if (!send) {
      const boss = await getStartedBoss();
      send = boss.send.bind(boss);
    }
    await send('note_refine', {
      artifact_id: input.artifactId,
      trigger: {
        kind: input.kind,
        context_md: input.contextMd,
        evidence_ids: input.evidenceIds,
        trigger_event_id: input.triggerEventId,
      },
    });
    lastEnqueuedAt.set(key, now.getTime());
    return { status: 'enqueued', artifact_id: input.artifactId, kind: input.kind };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[note_refine:${input.kind}] enqueue failed for ${input.artifactId}:`, err);
    return { status: 'failed', artifact_id: input.artifactId, kind: input.kind, error };
  }
}

export const enqueueMarkWrongNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  blockId?: string;
  reasonMd?: string;
  triggerEventId?: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'mark_wrong',
    contextMd: [
      'User marked an artifact block as wrong.',
      input.blockId ? `block_id=${input.blockId}` : null,
      input.reasonMd ? `reason=${input.reasonMd}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

// YUK-358 决定7 (ADR-0040) — the note_verify→refine bridge. When note_verify
// returns verdict=needs_review, instead of writing a dead patch-less note_update
// proposal (deleted), it enqueues a verify-kind refine carrying the verifier
// summary/issues as context_md. This is flag-gated OPT-IN (default-OFF, see
// DEFAULT_ENABLED_BY_KIND) so it does NOT silently add background AI cost. The
// refine then flows through the NORMAL gate (decideNoteRefineMode +
// patchTouchesVerifiedBlock) — verify gets ZERO privilege at that gate (red
// line 1). The debounce key is `verify:${artifactId}`, isolated from the
// mark_wrong/mastery keys (red line 6).
export const enqueueVerifyNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  contextMd?: string;
  triggerEventId?: string;
  bossSend?: BossSend;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'verify',
    contextMd:
      input.contextMd ?? 'Note verification flagged issues; consider a small corrective patch.',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

// YUK-358 决定6 (ADR-0040) — enqueueDwellNoteRefine producer RETIRED. Editing
// presence (the /api/editing-session/heartbeat heartbeat) no longer enqueues a
// note_refine; it is now a pure presence write feeding the editing_presence DEFER
// arbitration only. The dwell signal was a low-value AI-cost driver (no concrete
// learning event behind it). The 3 real-signal producers below (mark_wrong /
// mastery_change / dreaming) plus the verify bridge (决定7) remain.

// ADR-0040 决定2 — honest rename: the signal was historically labelled
// `review_success` (a pure pass/fail proxy that reads NO real mastery value). It is
// renamed to the honest `mastery_change` (the `kind` was already `mastery_change`;
// the misleading "Review success" context_md label is removed here).
//
// PHASE-DEFERRED (ADR-0040 决定2): the trigger STILL fires on outcome===success
// during the N-week instrumentation window — ZERO behaviour change to WHEN it fires.
// The p(L)-cross-threshold gating (fire only when the learner's p(L) crosses a
// threshold) is deferred until that threshold is CHOSEN from telemetry. The threshold
// is an n=1 magic number; the companion emitMasteryProgressSignal
// (mastery-progress-signal.ts) reads the real p(L)/Δθ̂ from mastery_state and emits it
// as `experimental:mastery_progress` events so the threshold can be set after N weeks.
// Do NOT hardcode a threshold here; do NOT change the trigger CONDITION yet.
export const enqueueMasteryNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  questionId?: string;
  triggerEventId?: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'mastery_change',
    contextMd: input.questionId
      ? `Mastery signal raised for question ${input.questionId} (attempt succeeded).`
      : 'Mastery signal raised (attempt succeeded).',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

export const enqueueDreamingNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  triggerEventId?: string;
  bossSend?: BossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'dreaming',
    contextMd: 'Dreaming scan found this artifact as a Living Note refresh candidate.',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });
