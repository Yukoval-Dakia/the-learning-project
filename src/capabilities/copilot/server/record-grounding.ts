// YUK-1419 — ReadReplyGrounding / RequestEvidenceGroundedReply.
//
// A reply may only claim lookup of the learner's own records when real evidence
// exists this turn: a succeeded root read receipt or the delivered learner_state
// snapshot. The model may declare each record claim in a tail envelope with the
// concrete values it states (names, numbers, dates, counts); finalization checks
// every value against the cited receipt's actual output or the snapshot text.
//
// A reply is replaced by a deterministic fallback in exactly two cases:
//  1. a declared claim fails verification (source missing/not citable, or a
//     stated value does not occur in the cited output), or
//  2. the reply says it searched/checked records while the turn carries NO
//     citable read receipt AND no delivered learner_state — the exact
//     YUK-1419 zero-evidence failure, decided by the empty real trace.
// No prose pattern alone ever replaces a reply.
//
// The envelope marker mirrors the correction envelope convention: an internal
// HTML comment stripped from all public channels.

import { z } from 'zod';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/kernel/tools/allowlists';
import type { ToolEffect } from '@/kernel/tools/types';

export const COPILOT_RECORD_GROUNDING_CONTRACT =
  '【个人记录依据——严格执行】回复中陈述学习者本人的记录事实（知识节点及其名称/数量、掌握度或能力读数、错题/失败/作答记录、复习安排与到期、记忆事实、历史练习情况）时，这些事实只能来自本会话真实依据：本回合某个已成功的读工具返回（其末尾 tool_use_id= 行为回执编号），或已注入的 role:"context" 学习者快照。有此类陈述时回复末尾应附加 <!--copilot-record-grounding {"claims":[{"claim":"该条陈述","source":{"kind":"tool_result","tool_use_id":"<对应回执编号>"},"values":["陈述中具体出现的节点名、数字、日期、条数等原值"]}]} -->；依据为 context 快照的条目 source 用 {"kind":"learner_state"}。values 必须逐字来自所引回执的输出或快照文本，服务端逐值核验：回执不存在、不是本回合成功的读工具、或任一 value 不在其输出里，整条回复会被替换为无法核验的说明。没有个人记录陈述的回复不要尾标。没有依据就先调用对应读工具；仍无据就直说「还没有查到/不知道」。「已检索/已核对/查到」类措辞只允许在确有读取或快照之后使用；本回合没有任何读回执也没有快照时写这类措辞，回复同样会被替换。禁止编造节点名、掌握度数字、错题内容、到期日或条数。学习者指出编造或误读记录时：明确承认具体是哪一条错了，重新调用读工具取回真实数据并在尾标引用新回执与新值；查不到就说未知。\n';

/**
 * Shown when the terminal reply's record claims cannot be bound to real
 * receipts. Honest downgrade, not an edit of the model's prose.
 */
export const RECORD_GROUNDING_FALLBACK_REPLY =
  '这次回复涉及你的个人学习记录，但我无法把它对应到本轮真实的查询结果，所以没有展示原稿。要查自己的记录，可以再问我一次，我会先查询再回答。';

const RecordClaimSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tool_result'),
      tool_use_id: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal('learner_state') }).strict(),
]);

export const CopilotRecordClaimSchema = z
  .object({
    claim: z.string().min(1).max(300),
    source: RecordClaimSourceSchema,
    /** Concrete values the claim asserts; each must occur verbatim in the source text. */
    values: z.array(z.string().min(1).max(120)).min(1).max(12),
  })
  .strict();

export type CopilotRecordClaim = z.infer<typeof CopilotRecordClaimSchema>;

const EnvelopeSchema = z.object({ claims: z.array(CopilotRecordClaimSchema).max(16) }).strict();

const ENVELOPE_RE = /<!--\s*copilot-record-grounding\b[\s\S]*?-->/g;

export interface ExtractedRecordGrounding {
  /** Reply text with every grounding envelope stripped. */
  text: string;
  /** Claims of the last parseable envelope, when one was emitted. */
  claims?: CopilotRecordClaim[];
  /** Any envelope was present (parseable or not). */
  hadEnvelope: boolean;
  /** At least one envelope failed to parse against the schema. */
  malformed: boolean;
}

export function extractRecordGrounding(text: string): ExtractedRecordGrounding {
  let hadEnvelope = false;
  let malformed = false;
  let claims: CopilotRecordClaim[] | undefined;
  const stripped = text.replace(ENVELOPE_RE, (marker) => {
    hadEnvelope = true;
    const jsonStart = marker.indexOf('{');
    const jsonEnd = marker.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      malformed = true;
      return '';
    }
    try {
      const parsed = EnvelopeSchema.safeParse(JSON.parse(marker.slice(jsonStart, jsonEnd + 1)));
      if (parsed.success) claims = parsed.data.claims;
      else malformed = true;
    } catch {
      malformed = true;
    }
    return '';
  });
  return { text: stripped, claims, hadEnvelope, malformed };
}

// ── Lookup-assertion signal ──────────────────────────────────────────────────
// Signals "the reply says it searched/checked records". This alone NEVER decides
// a downgrade: it only matters AND-ed with an actually empty evidence side
// (no citable read receipt, no delivered learner_state) — the zero-evidence
// failure mode from YUK-1419.

const LOOKUP_ASSERTION =
  /已(?:经)?(?:检索|查询|查阅|核对|核查|查看|检查|调取|读取|拉取|翻看|查过|查完|查了|查到|查好)|根据(?:本次|本轮|我的|你的|刚才|这次|上面|以下)(?:的)?(?:查询|检索|读取|核对|查看|调用)/;

export function replyClaimsLookup(text: string): boolean {
  return LOOKUP_ASSERTION.test(text);
}

// ── Receipt validation ───────────────────────────────────────────────────────

/** Minimal trace view the grounding check needs; satisfied by the finalizer's TraceEntry. */
export interface GroundingTraceEntry {
  readonly tool_use_id: string;
  readonly tool_name: string;
  readonly root_call: boolean;
  readonly status: 'in_flight' | 'succeeded' | 'failed';
  readonly effect: ToolEffect | null;
  readonly output_sha256: string | null;
  readonly domain_executed?: boolean;
  /** Real tool output captured at observation time; basis of value verification. */
  readonly domain_output?: unknown;
}

const DOMAIN_PREFIX = `mcp__${DOMAIN_TOOL_MCP_SERVER_NAME}__`;

/**
 * A claim may cite only a root-level tool receipt that actually settled this
 * turn: succeeded domain reads (executed, read effect) and native spawn results.
 * Remote MCP output is web evidence, never a learner record.
 */
export function isCitableRecordReceipt(entry: GroundingTraceEntry | undefined): boolean {
  if (!entry?.root_call || entry.status !== 'succeeded') return false;
  if (entry.output_sha256 === null) return false;
  if (entry.tool_name.startsWith(DOMAIN_PREFIX)) {
    return entry.domain_executed === true && entry.effect === 'read';
  }
  return !entry.tool_name.startsWith('mcp__');
}

export function hasCitableReadReceipt(trace: readonly GroundingTraceEntry[]): boolean {
  return trace.some(isCitableRecordReceipt);
}

/** Serialized real output text a declared value must occur in, verbatim. */
export function receiptOutputText(entry: GroundingTraceEntry | undefined): string | null {
  if (entry?.domain_output === undefined) return null;
  return typeof entry.domain_output === 'string'
    ? entry.domain_output
    : JSON.stringify(entry.domain_output);
}

export type CopilotRecordGroundingOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'verified'; readonly claims: readonly CopilotRecordClaim[] }
  | {
      readonly kind: 'rejected';
      readonly reason: 'unsupported_lookup_claim' | 'unverifiable_source';
      readonly claims: readonly CopilotRecordClaim[];
    };

export function evaluateCopilotRecordGrounding(input: {
  readonly declaredClaims: readonly CopilotRecordClaim[] | undefined;
  readonly replyText: string;
  readonly learnerStateText: string | null;
  readonly trace: readonly GroundingTraceEntry[];
}): CopilotRecordGroundingOutcome {
  const claims = input.declaredClaims ?? [];
  const byId = new Map(input.trace.map((entry) => [entry.tool_use_id, entry]));
  if (claims.length > 0) {
    const verifiable = claims.every((claim) => {
      const sourceText =
        claim.source.kind === 'learner_state'
          ? input.learnerStateText
          : receiptOutputText(byId.get(claim.source.tool_use_id));
      if (sourceText === null || sourceText === '') return false;
      if (
        claim.source.kind === 'tool_result' &&
        !isCitableRecordReceipt(byId.get(claim.source.tool_use_id))
      ) {
        return false;
      }
      return claim.values.every((value) => sourceText.includes(value));
    });
    return verifiable
      ? { kind: 'verified', claims }
      : { kind: 'rejected', reason: 'unverifiable_source', claims };
  }
  // No declaration: the only enforced case is the exact zero-evidence lookup
  // assertion — decided by the real trace being empty, never prose alone.
  return replyClaimsLookup(input.replyText) &&
    !hasCitableReadReceipt(input.trace) &&
    !input.learnerStateText
    ? { kind: 'rejected', reason: 'unsupported_lookup_claim', claims }
    : { kind: 'none' };
}
