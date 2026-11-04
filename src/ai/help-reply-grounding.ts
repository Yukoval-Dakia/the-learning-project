// Sealed help-explanation receipts. Every published hint or teaching explanation
// writes a receipt binding the published text to its input face and the run
// evidence (task run, provider/model, cost). Unknown cost stays null.
// readReplyGrounding also accepts the legacy `help_explanation_replay` payload
// shape so rows sealed before receipts remain readable.

import { createHash } from 'node:crypto';
import type { HelpCost } from '@/ai/help-latency';

export type HelpExplanationVerdict = 'pass' | 'fail' | 'ungrounded';

export interface HelpExplanationEvidence {
  readonly task_run_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly cost: HelpCost;
}

export interface SealedHelpExplanationReceipt {
  readonly kind: 'help_explanation_receipt';
  readonly input_digest: string;
  readonly output_digest: string;
  readonly published_digest: string;
  readonly task_run_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly cost: HelpCost;
}

/** Payload shape sealed before receipts existed; read-only, never written. */
export interface SealedHelpExplanationReplay {
  readonly kind: 'help_explanation_replay';
  readonly blind: true;
  readonly gold_ids: readonly string[];
  readonly verdict: HelpExplanationVerdict;
  readonly published_source: 'model' | 'sealed_gloss';
  readonly input_digest: string;
  readonly output_digest: string;
  readonly published_digest: string;
  readonly task_run_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly cost: HelpCost;
}

export type SealedReplyGrounding = SealedHelpExplanationReceipt | SealedHelpExplanationReplay;

const DIGEST = /^[a-f0-9]{64}$/;

/** Seal one published explanation with digests of its input face and output. */
export function sealHelpExplanation(input: {
  prompt: string;
  explanation: string;
  evidence: HelpExplanationEvidence;
}): { text_md: string; receipt: SealedHelpExplanationReceipt } {
  const digest = sha256(input.explanation);
  return {
    text_md: input.explanation,
    receipt: {
      kind: 'help_explanation_receipt',
      input_digest: sha256(input.prompt),
      output_digest: digest,
      published_digest: digest,
      task_run_id: input.evidence.task_run_id,
      provider: input.evidence.provider,
      model: input.evidence.model,
      cost: input.evidence.cost,
    },
  };
}

export function readReplyGrounding(value: unknown): SealedReplyGrounding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'help_explanation_receipt') return readReceipt(record);
  if (record.kind === 'help_explanation_replay') return readReplay(record);
  return undefined;
}

function readReceipt(record: Record<string, unknown>): SealedHelpExplanationReceipt | undefined {
  if (!isDigest(record.input_digest) || !isDigest(record.output_digest)) return undefined;
  if (!isDigest(record.published_digest)) return undefined;
  const cost = readCost(record.cost);
  if (!cost) return undefined;
  return {
    kind: 'help_explanation_receipt',
    input_digest: record.input_digest,
    output_digest: record.output_digest,
    published_digest: record.published_digest,
    task_run_id: optionalId(record.task_run_id),
    provider: optionalId(record.provider),
    model: optionalId(record.model),
    cost,
  };
}

function readReplay(record: Record<string, unknown>): SealedHelpExplanationReplay | undefined {
  if (record.blind !== true) return undefined;
  if (record.verdict !== 'pass' && record.verdict !== 'fail' && record.verdict !== 'ungrounded') {
    return undefined;
  }
  if (record.published_source !== 'model' && record.published_source !== 'sealed_gloss') {
    return undefined;
  }
  if (!isDigest(record.input_digest) || !isDigest(record.output_digest)) return undefined;
  if (!isDigest(record.published_digest)) return undefined;
  if (!Array.isArray(record.gold_ids) || record.gold_ids.some((id) => typeof id !== 'string')) {
    return undefined;
  }
  const cost = readCost(record.cost);
  if (!cost) return undefined;
  return {
    kind: 'help_explanation_replay',
    blind: true,
    gold_ids: record.gold_ids as string[],
    verdict: record.verdict,
    published_source: record.published_source,
    input_digest: record.input_digest,
    output_digest: record.output_digest,
    published_digest: record.published_digest,
    task_run_id: optionalId(record.task_run_id),
    provider: optionalId(record.provider),
    model: optionalId(record.model),
    cost,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function optionalId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readCost(value: unknown): HelpCost | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const cost = value as { basis?: unknown; usd?: unknown };
  if (cost.basis === 'unknown' && cost.usd === null) return { basis: 'unknown', usd: null };
  if (
    (cost.basis === 'reported' || cost.basis === 'estimated') &&
    typeof cost.usd === 'number' &&
    Number.isFinite(cost.usd) &&
    cost.usd >= 0
  ) {
    return { basis: cost.basis, usd: cost.usd };
  }
  return undefined;
}
