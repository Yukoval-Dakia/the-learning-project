import {
  COPILOT_EVIDENCE_MAX_TRACE_CALLS,
  COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME,
  COPILOT_EVIDENCE_SUBMISSION_TOOLS,
} from '@/core/copilot-evidence';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type { SdkMcpServer, ToolExecutionResultObservation } from '@/server/ai/tools/mcp-bridge';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CopilotEvidenceReviewOutput, CopilotEvidenceVerificationOutput } from '../contracts';
import {
  type BoundCopilotEvidenceComparison,
  type BoundCopilotEvidenceReference,
  type EvidenceTextUnit,
  MAX_EVIDENCE_REPLY_UNITS,
  MAX_EVIDENCE_REQUEST_UNITS,
  bindCopilotEvidenceComparison,
  bindCopilotEvidenceReference,
} from './evidence-contract';

/**
 * Per-paid-run in-memory collectors for the FULL validator. These local MCP
 * tools only append bounded observations; they cannot read or mutate product
 * state. Finalization canonicalizes into the existing evidence schemas and
 * sends the result through the existing sealed binders.
 */

const MAX_EVIDENCE_POINTS = 96;
const MAX_POINT_CHUNK = 12;
const MAX_TRACE_CHUNK = 12;
const MAX_REPLY_CHECK_CHUNK = 12;
const MAX_SAFE_REPLY_CHARS = 64_000;

const SourceRoleSchema = z.enum(['value', 'scope', 'coverage', 'relation']);
const EvidenceKindSchema = z.enum(['observed_fact', 'scope_boundary', 'actual_gap']);
const ReplyStatusSchema = z.enum(['supported', 'explicit_gap', 'unsupported']);
const ReasonCodeSchema = z.enum([
  'supported',
  'actual_gap_disclosed',
  'non_evidentiary',
  'noncausal_relation',
  'unsupported_necessity_or_sufficiency',
  'incomplete_scope_or_pagination',
  'projection_boundary_crossed',
  'queue_or_count_unknown_promoted',
  'requested_chain_incomplete',
  'tool_claim_not_observed',
  'internal_contradiction',
]);

const AppendEvidencePointsSchema = z
  .object({
    points: z
      .array(
        z
          .object({
            request_unit_indices: z
              .array(
                z
                  .number()
                  .int()
                  .min(0)
                  .max(MAX_EVIDENCE_REQUEST_UNITS - 1),
              )
              .min(1)
              .max(MAX_EVIDENCE_REQUEST_UNITS),
            kind: EvidenceKindSchema,
            statement_md: z.string().trim().min(1).max(600),
            sources: z
              .array(
                z
                  .object({
                    source_id: z
                      .string()
                      .regex(/^s(?:0|[1-9]\d*)$/)
                      .max(16),
                    role: SourceRoleSchema,
                  })
                  .strict(),
              )
              .min(1)
              .max(12),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_POINT_CHUNK),
  })
  .strict();

const MarkTraceCallsNotMaterialSchema = z
  .object({
    calls: z
      .array(
        z
          .object({
            call_index: z
              .number()
              .int()
              .min(0)
              .max(COPILOT_EVIDENCE_MAX_TRACE_CALLS - 1),
            rationale_md: z.string().trim().min(1).max(400),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TRACE_CHUNK),
  })
  .strict();

const SetSafeReplySchema = z
  .object({ safe_reply: z.string().trim().min(1).max(MAX_SAFE_REPLY_CHARS) })
  .strict();

const AppendReplyChecksSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            reply_unit_index: z
              .number()
              .int()
              .min(0)
              .max(MAX_EVIDENCE_REPLY_UNITS - 1),
            request_unit_indices: z
              .array(
                z
                  .number()
                  .int()
                  .min(0)
                  .max(MAX_EVIDENCE_REQUEST_UNITS - 1),
              )
              .max(MAX_EVIDENCE_REQUEST_UNITS),
            status: ReplyStatusSchema,
            evidence_point_indices: z.array(z.number().int().min(0).max(95)).max(24),
            reason_codes: z.array(ReasonCodeSchema).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_REPLY_CHECK_CHUNK),
  })
  .strict();

type AppendEvidencePointsInput = z.infer<typeof AppendEvidencePointsSchema>;
type MarkTraceCallsNotMaterialInput = z.infer<typeof MarkTraceCallsNotMaterialSchema>;
type SetSafeReplyInput = z.infer<typeof SetSafeReplySchema>;
type AppendReplyChecksInput = z.infer<typeof AppendReplyChecksSchema>;

type SubmissionResult = ({ ok: true } & Record<string, unknown>) | { ok: false; reason: string };

export interface CopilotEvidenceSourceCatalogEntry {
  source_id: string;
  call_index: number;
  side: 'input' | 'output';
  json_pointer: string;
}

export interface CopilotEvidenceSourceCatalogCall {
  call_index: number;
  /** Compact [source_id, RFC6901 path] tuples; side is the containing property. */
  input: Array<[source_id: string, json_pointer: string]>;
  output: Array<[source_id: string, json_pointer: string]>;
}

export interface CopilotEvidenceModelTraceCall {
  call_index: number;
  tool_name: string;
  effect: ToolExecutionResultObservation['effect'];
  status: 'successful_read' | 'unusable';
  /**
   * Successful reads retain the exact JSON shape, but every scalar/null/explicit
   * empty value is replaced by [source_id, exact_value]. The server keeps the
   * full trace + RFC6901 catalog for binding; the model does not need both large
   * representations on every SDK turn.
   */
  input?: unknown;
  output?: unknown;
  executed?: boolean;
  error_reason?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encodePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectLeafPointers(value: unknown, path: string, output: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (path) output.push(path);
      return;
    }
    for (let index = 0; index < value.length; index += 1) {
      collectLeafPointers(value[index], `${path}/${index}`, output);
    }
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      if (path) output.push(path);
      return;
    }
    for (const key of keys) {
      collectLeafPointers(value[key], `${path}/${encodePointerSegment(key)}`, output);
    }
    return;
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new Error('source_catalog_non_json_value');
  }
  if (path) output.push(path);
}

function isSuccessfulRead(observation: ToolExecutionResultObservation | undefined): boolean {
  return (
    observation?.effect === 'read' && observation.executed && observation.error_reason === null
  );
}

export function buildCopilotEvidenceSourceCatalog(
  toolTrace: readonly ToolExecutionResultObservation[],
): CopilotEvidenceSourceCatalogEntry[] {
  const catalog: CopilotEvidenceSourceCatalogEntry[] = [];
  for (let callIndex = 0; callIndex < toolTrace.length; callIndex += 1) {
    const observation = toolTrace[callIndex];
    if (!isSuccessfulRead(observation)) continue;
    for (const side of ['input', 'output'] as const) {
      const pointers: string[] = [];
      collectLeafPointers(observation?.[side], '', pointers);
      for (const jsonPointer of pointers) {
        if (jsonPointer.length > 512) throw new Error('source_catalog_pointer_too_long');
        catalog.push({
          source_id: `s${catalog.length}`,
          call_index: callIndex,
          side,
          json_pointer: jsonPointer,
        });
      }
    }
  }
  return catalog;
}

export function projectCopilotEvidenceSourceCatalog(
  catalog: readonly CopilotEvidenceSourceCatalogEntry[],
  traceCallCount: number,
): CopilotEvidenceSourceCatalogCall[] {
  return Array.from({ length: traceCallCount }, (_, callIndex) => ({
    call_index: callIndex,
    input: catalog.flatMap((source) =>
      source.call_index === callIndex && source.side === 'input'
        ? [[source.source_id, source.json_pointer] as [string, string]]
        : [],
    ),
    output: catalog.flatMap((source) =>
      source.call_index === callIndex && source.side === 'output'
        ? [[source.source_id, source.json_pointer] as [string, string]]
        : [],
    ),
  }));
}

function sourceCatalogKey(
  callIndex: number,
  side: 'input' | 'output',
  jsonPointer: string,
): string {
  return `${callIndex}:${side}:${jsonPointer}`;
}

function tagEvidenceLeaves(
  value: unknown,
  path: string,
  sourceIds: ReadonlyMap<string, string>,
  callIndex: number,
  side: 'input' | 'output',
): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      const sourceId = sourceIds.get(sourceCatalogKey(callIndex, side, path));
      if (!sourceId) throw new Error('model_trace_source_id_missing');
      return [sourceId, []];
    }
    return value.map((item, index) =>
      tagEvidenceLeaves(item, `${path}/${index}`, sourceIds, callIndex, side),
    );
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      const sourceId = sourceIds.get(sourceCatalogKey(callIndex, side, path));
      if (!sourceId) throw new Error('model_trace_source_id_missing');
      return [sourceId, {}];
    }
    return Object.fromEntries(
      keys.map((key) => [
        key,
        tagEvidenceLeaves(
          value[key],
          `${path}/${encodePointerSegment(key)}`,
          sourceIds,
          callIndex,
          side,
        ),
      ]),
    );
  }
  const sourceId = sourceIds.get(sourceCatalogKey(callIndex, side, path));
  if (!sourceId) throw new Error('model_trace_source_id_missing');
  return [sourceId, value];
}

/**
 * Model-facing lossless projection of successful product reads.
 *
 * The old input sent both the full nested trace and a second 90KB-ish pointer
 * catalog. This projection embeds each short source id beside its exact leaf
 * value, preserving the readable JSON structure while the server privately
 * retains the canonical pointer map used by binders and digests.
 */
export function projectCopilotEvidenceModelTrace(
  toolTrace: readonly ToolExecutionResultObservation[],
  catalog: readonly CopilotEvidenceSourceCatalogEntry[],
): CopilotEvidenceModelTraceCall[] {
  const sourceIds = new Map(
    catalog.map((source) => [
      sourceCatalogKey(source.call_index, source.side, source.json_pointer),
      source.source_id,
    ]),
  );
  return toolTrace.map((observation, callIndex) => {
    if (!isSuccessfulRead(observation)) {
      return {
        call_index: callIndex,
        tool_name: observation.name,
        effect: observation.effect,
        status: 'unusable' as const,
        executed: observation.executed,
        error_reason: observation.error_reason,
      };
    }
    return {
      call_index: callIndex,
      tool_name: observation.name,
      effect: observation.effect,
      status: 'successful_read' as const,
      input: tagEvidenceLeaves(observation.input, '', sourceIds, callIndex, 'input'),
      output: tagEvidenceLeaves(observation.output, '', sourceIds, callIndex, 'output'),
    };
  });
}

function uniqueBoundedIndices(values: readonly number[], upperExclusive: number): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value) => value >= 0 && value < upperExclusive)
  );
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function mcpTextResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function safeSubmissionReason(error: unknown): string {
  if (error instanceof z.ZodError) return 'invalid_submission_shape';
  if (!(error instanceof Error)) return 'submission_failed';
  return error.message
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function asSubmissionResult(fn: () => SubmissionResult): SubmissionResult {
  try {
    return fn();
  } catch (error) {
    return { ok: false, reason: safeSubmissionReason(error) };
  }
}

export interface ReferenceEvidenceSubmission {
  mcpServer: SdkMcpServer;
  appendEvidencePoints(input: AppendEvidencePointsInput): SubmissionResult;
  markTraceCallsNotMaterial(input: MarkTraceCallsNotMaterialInput): SubmissionResult;
  setSafeReply(input: SetSafeReplyInput): SubmissionResult;
  completeReference(): SubmissionResult;
  completedReference(): BoundCopilotEvidenceReference | undefined;
  progress(): {
    evidence_point_count: number;
    not_material_call_count: number;
    safe_reply_set: boolean;
    completed: boolean;
  };
}

export function createReferenceEvidenceSubmission(input: {
  requestUnits: readonly EvidenceTextUnit[];
  toolTrace: readonly ToolExecutionResultObservation[];
  sourceCatalog: readonly CopilotEvidenceSourceCatalogEntry[];
}): ReferenceEvidenceSubmission {
  const sourceById = new Map(input.sourceCatalog.map((source) => [source.source_id, source]));
  const points: CopilotEvidenceReviewOutput['evidence_points'] = [];
  const notMaterialCalls = new Map<number, string>();
  let safeReply: string | undefined;
  let completed: BoundCopilotEvidenceReference | undefined;

  const appendEvidencePoints = (raw: AppendEvidencePointsInput): SubmissionResult =>
    asSubmissionResult(() => {
      if (completed) throw new Error('submission_already_completed');
      const parsed = AppendEvidencePointsSchema.parse(raw);
      if (points.length + parsed.points.length > MAX_EVIDENCE_POINTS) {
        throw new Error('evidence_point_limit_exceeded');
      }
      const pending = parsed.points.map((point, offset) => {
        if (!uniqueBoundedIndices(point.request_unit_indices, input.requestUnits.length)) {
          throw new Error('invalid_request_unit_indices');
        }
        if (!uniqueStrings(point.sources.map((source) => source.source_id))) {
          throw new Error('duplicate_source_id');
        }
        const refs = point.sources.map((citation) => {
          const source = sourceById.get(citation.source_id);
          if (!source) throw new Error('unknown_source_id');
          if (notMaterialCalls.has(source.call_index)) {
            throw new Error('source_call_already_not_material');
          }
          return {
            call_index: source.call_index,
            side: source.side,
            json_pointer: source.json_pointer,
            role: citation.role,
          };
        });
        if (
          point.kind === 'observed_fact' &&
          !refs.some(
            (ref) => ref.side === 'output' && (ref.role === 'value' || ref.role === 'relation'),
          )
        ) {
          throw new Error('observed_fact_requires_output_value_or_relation');
        }
        if (
          point.kind !== 'observed_fact' &&
          !refs.some((ref) => ref.role === 'scope' || ref.role === 'coverage')
        ) {
          throw new Error('gap_requires_scope_or_coverage_source');
        }
        return {
          point_index: points.length + offset,
          request_unit_indices: point.request_unit_indices,
          kind: point.kind,
          statement_md: point.statement_md,
          source_refs: refs,
        };
      });
      points.push(...pending);
      return {
        ok: true,
        accepted_point_indices: pending.map((point) => point.point_index),
        evidence_point_count: points.length,
        ...tryAutoCompleteReference(),
      };
    });

  const markTraceCallsNotMaterial = (raw: MarkTraceCallsNotMaterialInput): SubmissionResult =>
    asSubmissionResult(() => {
      if (completed) throw new Error('submission_already_completed');
      const parsed = MarkTraceCallsNotMaterialSchema.parse(raw);
      if (
        !uniqueBoundedIndices(
          parsed.calls.map((call) => call.call_index),
          input.toolTrace.length,
        )
      ) {
        throw new Error('invalid_trace_call_indices');
      }
      for (const call of parsed.calls) {
        if (!isSuccessfulRead(input.toolTrace[call.call_index])) {
          throw new Error('not_material_requires_successful_read');
        }
        if (notMaterialCalls.has(call.call_index)) throw new Error('duplicate_trace_call');
        if (
          points.some((point) =>
            point.source_refs.some((source) => source.call_index === call.call_index),
          )
        ) {
          throw new Error('referenced_call_cannot_be_not_material');
        }
      }
      for (const call of parsed.calls) {
        notMaterialCalls.set(call.call_index, call.rationale_md);
      }
      return {
        ok: true,
        not_material_call_count: notMaterialCalls.size,
        ...tryAutoCompleteReference(),
      };
    });

  const setSafeReply = (raw: SetSafeReplyInput): SubmissionResult =>
    asSubmissionResult(() => {
      if (completed) throw new Error('submission_already_completed');
      if (safeReply !== undefined) throw new Error('safe_reply_already_set');
      const parsed = SetSafeReplySchema.parse(raw);
      if (parsed.safe_reply.includes('<!--primary_view')) {
        throw new Error('safe_reply_contains_primary_view_marker');
      }
      safeReply = parsed.safe_reply;
      return { ok: true, ...tryAutoCompleteReference() };
    });

  const completeReference = (): SubmissionResult =>
    asSubmissionResult(() => {
      if (completed) {
        return {
          ok: true,
          digest_sha256: completed.digest_sha256,
          evidence_point_count: completed.output.evidence_points.length,
          trace_call_count: completed.output.trace_coverage.length,
        };
      }
      if (points.length === 0) throw new Error('evidence_points_missing');
      if (!safeReply) throw new Error('safe_reply_missing');
      const requestCoverage = input.requestUnits.map((unit) => {
        const evidencePointIndices = points
          .filter((point) => point.request_unit_indices.includes(unit.index))
          .map((point) => point.point_index);
        if (evidencePointIndices.length === 0) throw new Error('request_unit_evidence_missing');
        return {
          request_unit_index: unit.index,
          status: evidencePointIndices.some((index) => points[index]?.kind === 'actual_gap')
            ? ('actual_gap' as const)
            : ('answerable' as const),
          evidence_point_indices: evidencePointIndices,
        };
      });
      const traceCoverage = input.toolTrace.map((observation, callIndex) => {
        if (!isSuccessfulRead(observation)) {
          return {
            call_index: callIndex,
            relevance: 'unusable' as const,
            request_unit_indices: [],
            evidence_point_indices: [],
            rationale_md: 'Server observed that this call was not a successful read.',
          };
        }
        const coveredPoints = points.filter((point) =>
          point.source_refs.some((source) => source.call_index === callIndex),
        );
        if (coveredPoints.length === 0) {
          const rationale = notMaterialCalls.get(callIndex);
          if (!rationale) throw new Error('successful_read_classification_missing');
          return {
            call_index: callIndex,
            relevance: 'not_material' as const,
            request_unit_indices: [],
            evidence_point_indices: [],
            rationale_md: rationale,
          };
        }
        if (notMaterialCalls.has(callIndex)) throw new Error('trace_call_classification_conflict');
        return {
          call_index: callIndex,
          relevance: coveredPoints.some((point) => point.kind === 'observed_fact')
            ? ('material' as const)
            : ('scope_only' as const),
          request_unit_indices: Array.from(
            new Set(coveredPoints.flatMap((point) => point.request_unit_indices)),
          ),
          evidence_point_indices: coveredPoints.map((point) => point.point_index),
          rationale_md: 'Server derived coverage from accepted evidence source ids.',
        };
      });
      completed = bindCopilotEvidenceReference({
        value: {
          protocol_version: 1,
          evidence_points: points,
          request_coverage: requestCoverage,
          trace_coverage: traceCoverage,
          safe_reply: safeReply,
        },
        requestUnits: input.requestUnits,
        toolTrace: input.toolTrace,
      });
      return {
        ok: true,
        digest_sha256: completed.digest_sha256,
        evidence_point_count: completed.output.evidence_points.length,
        trace_call_count: completed.output.trace_coverage.length,
      };
    });

  const tryAutoCompleteReference = (): Record<string, unknown> => {
    if (completed) {
      return { auto_completed: true, digest_sha256: completed.digest_sha256 };
    }
    // Do not turn an accepted append into an error merely because later chunks
    // are still absent. The bounded reason lets the model add only the missing
    // records; once all server-derived obligations are present, the same append
    // atomically seals the canonical record and removes one paid tool round-trip.
    if (points.length === 0 || safeReply === undefined) return { auto_completed: false };
    const completion = completeReference();
    return completion.ok
      ? { auto_completed: true, ...completion }
      : { auto_completed: false, completion_pending_reason: completion.reason };
  };

  const mcpServer = createSdkMcpServer({
    name: COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME,
    tools: [
      tool(
        COPILOT_EVIDENCE_SUBMISSION_TOOLS.appendEvidencePoints,
        `Append 1-${MAX_POINT_CHUNK} evidence points. The server assigns point indices and resolves short source ids to sealed JSON pointers.`,
        AppendEvidencePointsSchema.shape,
        async (args) => mcpTextResult(appendEvidencePoints(args)),
      ),
      tool(
        COPILOT_EVIDENCE_SUBMISSION_TOOLS.markTraceCallsNotMaterial,
        `Mark 1-${MAX_TRACE_CHUNK} successful read calls that are not material. Do not mark calls cited by evidence points.`,
        MarkTraceCallsNotMaterialSchema.shape,
        async (args) => mcpTextResult(markTraceCallsNotMaterial(args)),
      ),
      tool(
        COPILOT_EVIDENCE_SUBMISSION_TOOLS.setSafeReply,
        'Set the one complete fallback reply after the evidence points are submitted. A complete ledger is sealed by this same call; stop when auto_completed=true.',
        SetSafeReplySchema.shape,
        async (args) => mcpTextResult(setSafeReply(args)),
      ),
      tool(
        COPILOT_EVIDENCE_SUBMISSION_TOOLS.completeReference,
        'Idempotent recovery finalizer for a blind reference that did not already return auto_completed=true.',
        {},
        async () => mcpTextResult(completeReference()),
      ),
    ],
  });

  return {
    mcpServer,
    appendEvidencePoints,
    markTraceCallsNotMaterial,
    setSafeReply,
    completeReference,
    completedReference: () => completed,
    progress: () => ({
      evidence_point_count: points.length,
      not_material_call_count: notMaterialCalls.size,
      safe_reply_set: safeReply !== undefined,
      completed: completed !== undefined,
    }),
  };
}

export interface ComparisonEvidenceSubmission {
  mcpServer: SdkMcpServer;
  appendReplyChecks(input: AppendReplyChecksInput): SubmissionResult;
  completeComparison(): SubmissionResult;
  completedComparison(): BoundCopilotEvidenceComparison | undefined;
  progress(): { reply_check_count: number; completed: boolean };
}

const nonFailureReasonCodes = new Set(['supported', 'actual_gap_disclosed', 'non_evidentiary']);

export function createComparisonEvidenceSubmission(input: {
  requestUnits: readonly EvidenceTextUnit[];
  replyUnits: readonly EvidenceTextUnit[];
  selectedReply: string;
  reference: BoundCopilotEvidenceReference;
  toolTrace: readonly ToolExecutionResultObservation[];
  sourceComplete: boolean;
}): ComparisonEvidenceSubmission {
  type SubmittedCheck = z.infer<typeof AppendReplyChecksSchema>['checks'][number];
  const checks = new Map<number, SubmittedCheck>();
  let completed: BoundCopilotEvidenceComparison | undefined;
  const selectedReplySha256 = sha256CanonicalJson({ text: input.selectedReply });

  const appendReplyChecks = (raw: AppendReplyChecksInput): SubmissionResult =>
    asSubmissionResult(() => {
      if (completed) throw new Error('submission_already_completed');
      const parsed = AppendReplyChecksSchema.parse(raw);
      if (
        !uniqueBoundedIndices(
          parsed.checks.map((check) => check.reply_unit_index),
          input.replyUnits.length,
        )
      ) {
        throw new Error('invalid_reply_unit_indices');
      }
      for (const check of parsed.checks) {
        if (checks.has(check.reply_unit_index)) throw new Error('duplicate_reply_unit');
        if (!uniqueBoundedIndices(check.request_unit_indices, input.requestUnits.length)) {
          throw new Error('invalid_request_unit_indices');
        }
        if (
          !uniqueBoundedIndices(
            check.evidence_point_indices,
            input.reference.output.evidence_points.length,
          )
        ) {
          throw new Error('invalid_evidence_point_indices');
        }
        if (!uniqueStrings(check.reason_codes)) throw new Error('duplicate_reason_code');
        const unit = input.replyUnits[check.reply_unit_index];
        if (!unit) throw new Error('reply_unit_missing');
        if (unit.syntax_only) {
          if (
            check.request_unit_indices.length > 0 ||
            check.status !== 'supported' ||
            check.evidence_point_indices.length > 0 ||
            check.reason_codes.length !== 1 ||
            check.reason_codes[0] !== 'non_evidentiary'
          ) {
            throw new Error('invalid_syntax_only_reply_check');
          }
          continue;
        }
        if (check.request_unit_indices.length === 0) {
          throw new Error('material_reply_requires_request_unit');
        }
        if (check.status === 'supported') {
          if (check.evidence_point_indices.length === 0) {
            throw new Error('supported_reply_requires_evidence');
          }
          if (check.reason_codes.some((code) => code !== 'supported')) {
            throw new Error('supported_reply_has_invalid_reason');
          }
        }
        if (check.status === 'explicit_gap') {
          const hasGapPoint = check.evidence_point_indices.some((index) => {
            const kind = input.reference.output.evidence_points[index]?.kind;
            return kind === 'scope_boundary' || kind === 'actual_gap';
          });
          if (!hasGapPoint || !check.reason_codes.includes('actual_gap_disclosed')) {
            throw new Error('explicit_gap_requires_gap_evidence');
          }
          if (check.reason_codes.some((code) => !nonFailureReasonCodes.has(code))) {
            throw new Error('explicit_gap_has_failure_reason');
          }
        }
        if (
          check.status === 'unsupported' &&
          check.reason_codes.every((code) => nonFailureReasonCodes.has(code))
        ) {
          throw new Error('unsupported_reply_requires_failure_reason');
        }
      }
      for (const check of parsed.checks) checks.set(check.reply_unit_index, check);
      return {
        ok: true,
        reply_check_count: checks.size,
        ...tryAutoCompleteComparison(),
      };
    });

  const completeComparison = (): SubmissionResult =>
    asSubmissionResult(() => {
      if (completed) return { ok: true, verdict: completed.verdict };
      if (checks.size !== input.replyUnits.length) throw new Error('reply_checks_incomplete');
      const replyChecks: CopilotEvidenceVerificationOutput['reply_checks'] = input.replyUnits.map(
        (unit) => {
          const check = checks.get(unit.index);
          if (!check) throw new Error('reply_check_missing');
          return {
            reply_unit_index: unit.index,
            status: check.status,
            evidence_point_indices: check.evidence_point_indices,
            source_refs: [],
            reason_codes: check.reason_codes,
          };
        },
      );
      const requestChecks: CopilotEvidenceVerificationOutput['request_checks'] =
        input.requestUnits.map((unit) => {
          const referenceCoverage = input.reference.output.request_coverage[unit.index];
          if (!referenceCoverage) throw new Error('reference_request_coverage_missing');
          const linked = [...checks.values()]
            .filter((check) => check.request_unit_indices.includes(unit.index))
            .sort((left, right) => left.reply_unit_index - right.reply_unit_index);
          const failureCodes = Array.from(
            new Set(
              linked.flatMap((check) =>
                check.reason_codes.filter((code) => !nonFailureReasonCodes.has(code)),
              ),
            ),
          );
          let status: 'answered' | 'explicit_gap' | 'missing' = 'missing';
          if (
            linked.length > 0 &&
            linked.every((check) => check.status === 'supported') &&
            referenceCoverage.status === 'answerable'
          ) {
            status = 'answered';
          } else if (
            linked.length > 0 &&
            linked.every((check) => check.status !== 'unsupported') &&
            linked.some((check) => check.status === 'explicit_gap') &&
            referenceCoverage.status === 'actual_gap'
          ) {
            status = 'explicit_gap';
          }
          const reasonCodes =
            status === 'answered'
              ? (['supported'] as const)
              : status === 'explicit_gap'
                ? (['actual_gap_disclosed'] as const)
                : failureCodes.length > 0
                  ? failureCodes
                  : (['requested_chain_incomplete'] as const);
          return {
            request_unit_index: unit.index,
            status,
            reply_unit_indices: linked.map((check) => check.reply_unit_index),
            evidence_point_indices: referenceCoverage.evidence_point_indices,
            reason_codes: [...reasonCodes],
          };
        });
      completed = bindCopilotEvidenceComparison({
        value: { protocol_version: 1, reply_checks: replyChecks, request_checks: requestChecks },
        requestUnits: input.requestUnits,
        replyUnits: input.replyUnits,
        selectedReplySha256,
        reference: input.reference,
        toolTrace: input.toolTrace,
        sourceComplete: input.sourceComplete,
      });
      return {
        ok: true,
        verdict: completed.verdict,
        violation_count: completed.violations.length,
        digest_sha256: completed.digest_sha256,
      };
    });

  const tryAutoCompleteComparison = (): Record<string, unknown> => {
    if (completed) {
      return {
        auto_completed: true,
        verdict: completed.verdict,
        digest_sha256: completed.digest_sha256,
      };
    }
    if (checks.size !== input.replyUnits.length) return { auto_completed: false };
    const completion = completeComparison();
    return completion.ok
      ? { auto_completed: true, ...completion }
      : { auto_completed: false, completion_pending_reason: completion.reason };
  };

  const mcpServer = createSdkMcpServer({
    name: COPILOT_EVIDENCE_SUBMISSION_SERVER_NAME,
    tools: [
      tool(
        COPILOT_EVIDENCE_SUBMISSION_TOOLS.appendReplyChecks,
        `Append 1-${MAX_REPLY_CHECK_CHUNK} per-reply checks. The server derives request coverage and the verdict; the final complete chunk seals automatically and returns auto_completed=true.`,
        AppendReplyChecksSchema.shape,
        async (args) => mcpTextResult(appendReplyChecks(args)),
      ),
      tool(
        COPILOT_EVIDENCE_SUBMISSION_TOOLS.completeComparison,
        'Idempotent recovery finalizer for a comparison that did not already return auto_completed=true.',
        {},
        async () => mcpTextResult(completeComparison()),
      ),
    ],
  });

  return {
    mcpServer,
    appendReplyChecks,
    completeComparison,
    completedComparison: () => completed,
    progress: () => ({ reply_check_count: checks.size, completed: completed !== undefined }),
  };
}

export function sourceCatalogDigest(catalog: readonly CopilotEvidenceSourceCatalogEntry[]): string {
  return sha256CanonicalJson(
    catalog.map(({ source_id, call_index, side, json_pointer }) => ({
      source_id,
      call_index,
      side,
      json_pointer,
    })),
  );
}
