// YUK-1419 — ReadReplyGrounding / RequestEvidenceGroundedReply.
//
// Every statement about the learner's own records (knowledge nodes, mastery or
// ability readings, mistakes/attempts, review schedule, memory facts) must trace
// to a real receipt: a tool result from this turn or the session-anchored
// learner_state snapshot actually delivered in the run input. The model declares
// each claim in a tail envelope; reply finalization validates every citation
// against the observed execution trace and replaces the reply with a
// deterministic fallback when the claims cannot be verified. Detection of
// undeclared record claims is a narrow deterministic tripwire — the evidence
// side is always the real trace, never prose matching.
//
// The envelope marker mirrors the correction envelope convention: it is an
// internal HTML comment stripped from all public channels.

import { z } from 'zod';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/kernel/tools/allowlists';
import type { ToolEffect } from '@/kernel/tools/types';

export const COPILOT_RECORD_GROUNDING_CONTRACT =
  '【个人记录依据——严格执行】回复中凡陈述学习者本人的记录事实（知识节点及其归属/数量、掌握度或能力读数、错题/失败/作答记录、复习安排与到期、记忆事实、历史练习情况），每条都必须有本会话真实依据：本回合某个已成功的读工具返回（其末尾 tool_use_id= 行为回执编号），或已注入的 role:"context" 学习者快照。有此类陈述时回复末尾必须附加 <!--copilot-record-grounding {"claims":[{"claim":"该条陈述的原文或压缩摘要","source":{"kind":"tool_result","tool_use_id":"<对应回执编号>"}}]} -->；依据为 context 快照的条目 source 用 {"kind":"learner_state"}。没有个人记录陈述的回复不要尾标。服务端逐条核验回执：回执不存在、不是本回合成功的读工具、或正文有未声明的个人记录陈述时，整条回复会被替换为无法核验的说明。没有依据就先调用对应读工具；仍无据就直说「还没有查到/不知道」，禁止写「已检索/已核对/查到」类措辞，禁止编造节点名、掌握度数字、错题内容、到期日或条数。学习者指出编造或误读记录时：明确承认具体是哪一条错了，重新调用读工具取回真实数据并在尾标引用新回执；查不到就说未知。\n';

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

// ── Undeclared-claim tripwire ────────────────────────────────────────────────
// Narrow, high-precision signals for the failure mode in YUK-1419: asserting a
// lookup happened, or stating facts about the learner's stored records. The
// tripwire only decides whether a declaration was required; the verdict always
// comes from the real trace.

const LOOKUP_ASSERTION =
  /已(?:经)?(?:检索|查询|查阅|核对|核查|查看|检查|调取|读取|拉取|翻看)|根据(?:本次|本轮|我的|你的|刚才|这次|上面|以下)(?:的)?(?:查询|检索|读取|核对|查看|调用)/;

const RECORD_FACT =
  /你的[^。\n]{0,12}(?:错题|失败记录|掌握|复习|到期|待复习|学习记录|答题|作答|记忆|知识点|知识节点|知识图谱)|(?:没有|尚未|暂无)[^。\n]{0,12}(?:知识节点|知识点|知识条目|错题|失败|掌握|复习|学习记录|到期)|(?:错题|失败记录|掌握度|掌握情况|复习安排|复习队列|待复习|学习记录|答题记录|作答记录|记忆事实)[^。\n]{0,16}\d|\d+\s*(?:条|道|项|个|张|次)[^。\n]{0,12}(?:错题|失败|错误|复习|记录|知识点|知识节点|到期|记忆)|来自你/;

export function replyAssertsLearnerRecords(text: string): boolean {
  return LOOKUP_ASSERTION.test(text) || RECORD_FACT.test(text);
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

export type CopilotRecordGroundingOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'verified'; readonly claims: readonly CopilotRecordClaim[] }
  | {
      readonly kind: 'rejected';
      readonly reason: 'missing_declaration' | 'unverifiable_source';
      readonly claims: readonly CopilotRecordClaim[];
    };

export function evaluateCopilotRecordGrounding(input: {
  readonly declaredClaims: readonly CopilotRecordClaim[] | undefined;
  readonly replyText: string;
  readonly learnerStateDelivered: boolean;
  readonly trace: readonly GroundingTraceEntry[];
}): CopilotRecordGroundingOutcome {
  const claims = input.declaredClaims ?? [];
  const byId = new Map(input.trace.map((entry) => [entry.tool_use_id, entry]));
  if (claims.length > 0) {
    const resolvable = claims.every((claim) =>
      claim.source.kind === 'learner_state'
        ? input.learnerStateDelivered
        : isCitableRecordReceipt(byId.get(claim.source.tool_use_id)),
    );
    return resolvable
      ? { kind: 'verified', claims }
      : { kind: 'rejected', reason: 'unverifiable_source', claims };
  }
  // No usable declaration (absent, malformed, or claims:[]): the tripwire alone
  // decides whether one was owed. Evidence still comes from the real trace.
  return replyAssertsLearnerRecords(input.replyText)
    ? { kind: 'rejected', reason: 'missing_declaration', claims }
    : { kind: 'none' };
}
