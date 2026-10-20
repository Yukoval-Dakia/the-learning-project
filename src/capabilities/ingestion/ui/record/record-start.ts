// How a recording starts (YUK-1473): what the material is, which lane reads it, and the start
// state per recording (one Idempotency-Key per lane start, so a manual retry replays the same
// start instead of starting twice). Read by components through useSyncExternalStore.

import { useSyncExternalStore } from 'react';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import {
  type UsePolicy,
  createDocxSession,
  createSession,
  startLane,
  uploadPages,
} from './record-api';

export type Lane = 'extract' | 'agent';

/**
 * Lane a multi-page paper (several photos or a PDF) starts in when the learner changes nothing.
 * Set to 'extract' until the backend weekly launch quota for the agent ships; then flip to 'agent'.
 */
export const PAPER_DEFAULT_LANE: Lane = 'extract';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MB = 1_000_000;

export type Material =
  | { kind: 'photo' | 'pages'; files: File[] }
  | { kind: 'pdf' | 'docx'; files: [File] }
  | { kind: 'invalid'; files: File[]; reason: string };

/** Identity of a picked file; the same file picked twice counts once. */
export const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isDocx = (f: File) => /\.docx$/i.test(f.name);

/** Decides what the learner handed over; the learner never picks a mode. */
export function readMaterial(files: File[]): Material {
  const docs = files.filter((f) => isPdf(f) || isDocx(f));
  if (docs.length > 0) {
    const [doc] = docs;
    if (files.length > 1) {
      return { kind: 'invalid', files, reason: 'PDF 或 Word 文件请单独放，一次一个。' };
    }
    if (isPdf(doc)) {
      return doc.size > 30 * MB
        ? { kind: 'invalid', files, reason: 'PDF 最大 30 MB、15 页。' }
        : { kind: 'pdf', files: [doc] };
    }
    return doc.size > 20 * MB
      ? { kind: 'invalid', files, reason: 'Word 文件最大 20 MB。' }
      : { kind: 'docx', files: [doc] };
  }
  if (files.some((f) => !IMAGE_TYPES.has(f.type))) {
    return { kind: 'invalid', files, reason: '照片只认 JPG、PNG、WebP。' };
  }
  if (files.some((f) => f.size > 8 * MB)) {
    return { kind: 'invalid', files, reason: '每张照片最大 8 MB。' };
  }
  if (files.length > 15) return { kind: 'invalid', files, reason: '一次最多 15 张照片。' };
  return { kind: files.length === 1 ? 'photo' : 'pages', files };
}

/** The agent reads papers only, and only material the learner allows beyond these questions. */
export function agentPossible(material: Material, policy: UsePolicy): boolean {
  return (material.kind === 'pages' || material.kind === 'pdf') && policy === 'allow';
}

// ── Start state per recording ──────────────────────────────────────────────

export type StartProblem =
  | 'quota_used'
  | 'quota_busy'
  | 'quota_settling'
  | 'quota_unknown'
  | 'agent_not_allowed'
  | 'other';

export interface StartState {
  lane: Lane;
  key: string;
  status: 'starting' | 'started' | 'failed';
  problem: StartProblem | null;
  /** When the start request settled (ms); reads keep polling a little past it. */
  at: number;
}

export interface DraftState {
  previews: string[];
  material: Material;
  policy: UsePolicy;
  lane: Lane;
  done: number;
  failed: string | null;
}

const starts = new Map<string, StartState>();
let draft: DraftState | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useStartState(sessionId: string): StartState | null {
  return useSyncExternalStore(subscribe, () => starts.get(sessionId) ?? null);
}

export function useDraft(): DraftState | null {
  return useSyncExternalStore(subscribe, () => draft);
}

function problemOf(err: unknown): StartProblem {
  if (!(err instanceof ApiError)) return 'other';
  if (err.status === 429 && err.code === 'ingestion_weekly_budget_exceeded') return 'quota_used';
  if (err.status === 503 && err.code === 'ingestion_weekly_budget_unavailable') {
    const reason = String(
      err.details.reason ?? (err.details.details as { reason?: string })?.reason ?? '',
    );
    if (/run|progress|active|concurr|busy/i.test(reason)) return 'quota_busy';
    if (/settl|pending|unsettled|reconcil/i.test(reason)) return 'quota_settling';
    return 'quota_unknown';
  }
  if (err.status === 422 && err.code === 'derivation_policy_forbids_agent') {
    return 'agent_not_allowed';
  }
  return 'other';
}

async function run(sessionId: string, state: StartState) {
  starts.set(sessionId, { ...state, status: 'starting', problem: null, at: Date.now() });
  emit();
  try {
    await startLane(sessionId, state.lane, state.key);
    starts.set(sessionId, { ...state, status: 'started', problem: null, at: Date.now() });
  } catch (err) {
    // 409 conflict = this recording is already running or done; nothing to fix.
    const already = err instanceof ApiError && err.status === 409 && err.code === 'conflict';
    starts.set(sessionId, {
      ...state,
      status: already ? 'started' : 'failed',
      problem: already ? null : problemOf(err),
      at: Date.now(),
    });
  }
  emit();
}

/** First start, or a switch to another lane (a new key: it is a different request). */
export function startRecording(sessionId: string, lane: Lane) {
  return run(sessionId, { lane, key: randomId(), status: 'starting', problem: null, at: 0 });
}

/** A learner-pressed retry: same lane, same key, so the server returns the original handle. */
export function retryStart(sessionId: string) {
  const prev = starts.get(sessionId);
  if (prev) return run(sessionId, prev);
}

function setDraft(next: DraftState | null) {
  if (draft && draft.previews !== next?.previews) {
    for (const url of draft.previews) URL.revokeObjectURL(url);
  }
  draft = next;
  emit();
}

export function dropDraft() {
  setDraft(null);
}

/** Uploads the material, creates the recording and starts its lane. Resolves to its id. */
export async function recordMaterial(input: Omit<DraftState, 'done' | 'failed'>) {
  setDraft({ ...input, done: 0, failed: null });
  const { material, policy, lane } = input;
  try {
    let sessionId: string;
    if (material.kind === 'docx') {
      sessionId = await createDocxSession(material.files[0], policy);
    } else {
      const assetIds = await uploadPages(material.files, (done) => {
        if (draft) setDraft({ ...draft, done });
      });
      sessionId = await createSession({
        entrypoint: material.kind === 'photo' ? 'vision_single' : 'vision_paper',
        assetIds,
        policy,
      });
    }
    // A Word file is already being read when it comes back; other material needs a start.
    if (material.kind !== 'docx') void startRecording(sessionId, lane);
    setDraft(null);
    return sessionId;
  } catch (err) {
    const message = err instanceof Error && !(err instanceof ApiError) ? err.message : null;
    if (draft) setDraft({ ...draft, failed: message ?? '没有传上去。检查一下网络，再试一次。' });
    return null;
  }
}
