import { createHash } from 'node:crypto';
import type { AiTaskKind } from '@/ai/task-prompts';
import { getTaskSystemPrompt } from '@/ai/task-prompts';
import type { SubjectProfile } from '@/subjects/profile';

export const JUDGE_PROMPT_ENVELOPE_VERSION = 1 as const;
export const JUDGE_PROMPT_TEMPLATE_REVISION = 'judge-prompt-v1' as const;

// Reserved, non-confusable canonicalization marker. Any plain object that
// happens to carry this key is escaped below, so a synthetic JSON object can
// never alias the byte / escape envelopes. `v` version-tags each envelope so a
// future canonicalization change produces a structurally different (therefore
// non-colliding) hash instead of silently aliasing today's form.
const CANON_MARKER = '__ykv_canon__';

function bytesEnvelope(value: Uint8Array): Record<string, unknown> {
  return {
    [CANON_MARKER]: {
      v: 1,
      t: 'bytes',
      byteLength: value.byteLength,
      sha256: createHash('sha256').update(value).digest('hex'),
    },
  };
}

export function stableCanonicalValue(value: unknown): unknown {
  if (value instanceof URL) return value.toString();
  if (value instanceof Uint8Array) return bytesEnvelope(value);
  // YUK-589 (J4) — canonicalization must be TOTAL and non-colliding, never
  // throwing for advisory metadata while silently aliasing distinct inputs.
  //  - BigInt: JSON.stringify throws on it, which would abort the whole hash.
  //    Tag it in a versioned, non-confusable envelope so it produces a stable,
  //    unique digest instead. (Number and BigInt render to different envelopes,
  //    so `1` and `1n` never collide.)
  //  - Map / Set / RegExp / other exotic non-plain objects: these fall into the
  //    `typeof === 'object'` branch below and JSON.stringify them as `{}`,
  //    silently colliding every distinct instance. Refuse them loudly so the
  //    caller's fail-closed guard (invoker metadata try/catch) skips the
  //    fingerprint rather than trusting a colliding hash.
  if (typeof value === 'bigint') {
    return { [CANON_MARKER]: { v: 1, t: 'bigint', value: value.toString() } };
  }
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (value && typeof value === 'object') {
    // Date is intentionally NOT rejected: it serializes losslessly via toJSON
    // (ISO string), so it neither throws nor collides. These exotics DO collide
    // (JSON.stringify renders them as `{}` or a lossy shape), so refuse them.
    if (
      value instanceof Map ||
      value instanceof Set ||
      value instanceof RegExp ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      throw new Error(`non-canonicalizable value: ${value.constructor?.name ?? typeof value}`);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = stableCanonicalValue(source[key]);
    }
    // A plain object that itself uses the reserved marker key is wrapped in a
    // distinct escape envelope so it can never collide with a `bytes` envelope
    // (or a nested escape envelope) produced for real binary data.
    if (Object.hasOwn(source, CANON_MARKER)) {
      return { [CANON_MARKER]: { v: 1, t: 'escaped', body: out } };
    }
    return out;
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableCanonicalValue(value)) ?? 'null')
    .digest('hex');
}

export function taskInputHash(input: unknown): string {
  return sha256Canonical(input);
}

export function judgePromptFingerprint(input: {
  taskKind: AiTaskKind;
  taskInput: unknown;
  subjectProfile: SubjectProfile;
  judgeRoute: string;
}): string {
  return sha256Canonical({
    version: JUDGE_PROMPT_ENVELOPE_VERSION,
    task_kind: input.taskKind,
    canonical_model_input: {
      system: getTaskSystemPrompt(input.taskKind, input.subjectProfile),
      user:
        typeof input.taskInput === 'string'
          ? input.taskInput
          : JSON.stringify(stableCanonicalValue(input.taskInput)),
    },
    subject_profile: { id: input.subjectProfile.id, version: input.subjectProfile.version },
    judge_route: input.judgeRoute,
    prompt_template_revision: JUDGE_PROMPT_TEMPLATE_REVISION,
  });
}
