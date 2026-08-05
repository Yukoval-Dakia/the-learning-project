import {
  type CopilotEvidenceReviewOutput,
  CopilotEvidenceReviewOutputSchema,
  type CopilotEvidenceVerificationOutput,
  CopilotEvidenceVerificationOutputSchema,
} from '@/ai/registry';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type { ToolExecutionResultObservation } from '@/server/ai/tools/mcp-bridge';

export const MAX_EVIDENCE_REQUEST_UNITS = 32;
export const MAX_EVIDENCE_REPLY_UNITS = 192;
const MAX_REPLY_UNIT_CHARS = 800;

export interface EvidenceTextUnit {
  index: number;
  start_utf16: number;
  end_utf16: number;
  text: string;
  text_sha256: string;
  syntax_only: boolean;
}

export interface BoundCopilotEvidenceReference {
  output: CopilotEvidenceReviewOutput;
  digest_sha256: string;
}

export interface BoundCopilotEvidenceComparison {
  output: CopilotEvidenceVerificationOutput;
  verdict: 'pass' | 'fail';
  violations: string[];
  digest_sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function syntaxOnlyMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.replace(/[\p{Cf}\uFEFF]/gu, '').length === 0) return true;
  if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) return true;
  if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(trimmed)) return true;
  // react-markdown renders these structural atoms as empty elements. They may
  // never satisfy a material request merely because a comparator attaches a
  // sealed point to them.
  if (/^(?:[-+*]|\d{1,9}[.)])$/.test(trimmed)) return true;
  if (/^#{1,6}(?:\s+#+)?$/.test(trimmed)) return true;
  if (/^(?:>\s*)+$/.test(trimmed)) return true;
  if (/^(?:`{3,}|~{3,})[^\r\n]*$/.test(trimmed)) return true;
  if (/^\[\s*\]\([^)]*\)$/.test(trimmed)) return true;
  if (/^<!--[\s\S]*-->$/.test(trimmed)) return true;
  if (/^<([A-Za-z][\w:-]*)(?:\s[^<>]*)?>\s*<\/\1>$/.test(trimmed)) return true;
  if (/^(?:&nbsp;|&#160;|&#x0*a0;|&#8203;|&#x0*200b;)+$/i.test(trimmed)) return true;
  return false;
}

function pushUnit(units: EvidenceTextUnit[], source: string, start: number, end: number): void {
  let boundedStart = start;
  let boundedEnd = end;
  while (boundedStart < boundedEnd && /\s/u.test(source[boundedStart] ?? '')) boundedStart += 1;
  while (boundedEnd > boundedStart && /\s/u.test(source[boundedEnd - 1] ?? '')) boundedEnd -= 1;
  if (boundedStart >= boundedEnd) return;
  const text = source.slice(boundedStart, boundedEnd);
  units.push({
    index: units.length,
    start_utf16: boundedStart,
    end_utf16: boundedEnd,
    text,
    text_sha256: sha256CanonicalJson({ text }),
    syntax_only: syntaxOnlyMarkdown(text),
  });
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function lineRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text[index] !== '\n') continue;
    const end = index > start && text[index - 1] === '\r' ? index - 1 : index;
    ranges.push({ start, end });
    start = index + 1;
  }
  return ranges;
}

const LABELED_REQUEST_ANCHOR =
  /(?<![\p{L}\p{N}_])\p{Lu}[\p{L}\p{N}_-]*\p{N}[\p{L}\p{N}_-]*(?![\p{L}\p{N}_])/gu;
const NUMBERED_REQUEST_ANCHOR =
  /(?<![\p{L}\p{N}_])(?:\d{1,2}|[一二三四五六七八九十]{1,3})[.)、．）](?=\s*\S)/gu;

function pushRequestRange(
  units: EvidenceTextUnit[],
  source: string,
  start: number,
  end: number,
): void {
  const slice = source.slice(start, end);
  const anchors = [
    ...[...slice.matchAll(LABELED_REQUEST_ANCHOR)].map((match) => start + (match.index ?? 0)),
    ...[...slice.matchAll(NUMBERED_REQUEST_ANCHOR)].map((match) => start + (match.index ?? 0)),
  ].sort((left, right) => left - right);
  if (anchors.length <= 1) {
    pushUnit(units, source, start, end);
    return;
  }
  let atomStart = start;
  for (const anchorStart of anchors.slice(1)) {
    pushUnit(units, source, atomStart, anchorStart);
    atomStart = anchorStart;
  }
  pushUnit(units, source, atomStart, end);
}

/** Deterministic, language-agnostic structural units; no semantic regex gate. */
export function segmentEvidenceReply(text: string): EvidenceTextUnit[] {
  const units: EvidenceTextUnit[] = [];
  for (const line of lineRanges(text)) {
    let segmentStart = line.start;
    for (let index = line.start; index < line.end; index += 1) {
      const char = text[index] ?? '';
      if (!'。！？!?；;'.includes(char)) continue;
      // `!` is structural rather than sentence punctuation in HTML comments
      // and Markdown image openers; keep the atom intact for visibility checks.
      if (
        char === '!' &&
        (text[index + 1] === '[' || text.slice(index - 1, index + 3) === '<!--')
      ) {
        continue;
      }
      let chunkStart = segmentStart;
      while (chunkStart < index + 1) {
        const chunkEnd = Math.min(index + 1, chunkStart + MAX_REPLY_UNIT_CHARS);
        pushUnit(units, text, chunkStart, chunkEnd);
        chunkStart = chunkEnd;
      }
      segmentStart = index + 1;
    }
    while (segmentStart < line.end) {
      const end = Math.min(line.end, segmentStart + MAX_REPLY_UNIT_CHARS);
      pushUnit(units, text, segmentStart, end);
      segmentStart = end;
    }
  }
  if (units.length === 0) throw new Error('selected reply has no reviewable units');
  if (units.length > MAX_EVIDENCE_REPLY_UNITS) {
    throw new Error(`selected reply exceeds ${MAX_EVIDENCE_REPLY_UNITS} review units`);
  }
  return units;
}

export function segmentEvidenceRequest(requestContext: unknown): EvidenceTextUnit[] {
  if (!isRecord(requestContext) || typeof requestContext.user_message !== 'string') {
    throw new Error('request_context.user_message is required for sealed evidence review');
  }
  const text = requestContext.user_message;
  const units: EvidenceTextUnit[] = [];
  for (const line of lineRanges(text)) {
    let segmentStart = line.start;
    for (let index = line.start; index < line.end; index += 1) {
      // Ordinary product requests often enumerate independent asks with comma
      // or 顿号 rather than issue labels. Split them deterministically here so
      // the blind reviewer cannot self-declare omitted siblings out of scope.
      // Keep ASCII thousands separators intact (e.g. 1,761).
      const char = text[index] ?? '';
      if (!'。！？!?；;，,、'.includes(char)) continue;
      if (char === ',' && isAsciiDigit(text[index - 1]) && isAsciiDigit(text[index + 1])) {
        continue;
      }
      pushRequestRange(units, text, segmentStart, index + 1);
      segmentStart = index + 1;
    }
    pushRequestRange(units, text, segmentStart, line.end);
  }
  if (units.length === 0) throw new Error('request has no reviewable units');
  if (units.length > MAX_EVIDENCE_REQUEST_UNITS) {
    throw new Error(`request exceeds ${MAX_EVIDENCE_REQUEST_UNITS} review units`);
  }
  return units;
}

function uniqueDenseIndices(values: number[], expectedLength: number, label: string): void {
  if (values.length !== expectedLength) {
    throw new Error(`${label} must contain exactly ${expectedLength} entries`);
  }
  const expected = Array.from({ length: expectedLength }, (_, index) => index);
  if (values.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must be dense and ordered from zero`);
  }
}

function uniqueIndices(values: number[], upperExclusive: number, label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} contains duplicate indices`);
  if (values.some((value) => value < 0 || value >= upperExclusive)) {
    throw new Error(`${label} references an out-of-range index`);
  }
}

function decodeJsonPointer(pointer: string): string[] {
  if (!pointer.startsWith('/') || pointer === '/') {
    throw new Error('evidence source pointer must target a concrete non-root path');
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => {
      if (/~(?:[^01]|$)/.test(segment))
        throw new Error('evidence source pointer has invalid escape');
      return segment.replaceAll('~1', '/').replaceAll('~0', '~');
    });
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of decodeJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
        throw new Error('array evidence pointer segment is not a canonical index');
      }
      const index = Number(segment);
      if (index >= current.length) throw new Error('array evidence pointer index is absent');
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new Error('evidence source pointer path is absent');
    }
    current = current[segment];
  }
  if (
    current !== null &&
    typeof current === 'object' &&
    (Array.isArray(current) ? current.length > 0 : Object.keys(current).length > 0)
  ) {
    throw new Error('evidence source pointer must resolve to a scalar or explicit empty value');
  }
  return current;
}

type SourceRef = CopilotEvidenceReviewOutput['evidence_points'][number]['source_refs'][number];

function bindSourceRef(ref: SourceRef, toolTrace: readonly ToolExecutionResultObservation[]): void {
  const observation = toolTrace[ref.call_index];
  if (
    !observation ||
    observation.effect !== 'read' ||
    !observation.executed ||
    observation.error_reason !== null
  ) {
    throw new Error('evidence source ref does not name a successful read observation');
  }
  resolveJsonPointer(
    ref.side === 'input' ? observation.input : observation.output,
    ref.json_pointer,
  );
}

function sourceRefKey(ref: SourceRef): string {
  return `${ref.call_index}:${ref.side}:${ref.json_pointer}:${ref.role}`;
}

function sameIndexSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function bindCopilotEvidenceReference(input: {
  value: unknown;
  requestUnits: readonly EvidenceTextUnit[];
  toolTrace: readonly ToolExecutionResultObservation[];
}): BoundCopilotEvidenceReference {
  const output = CopilotEvidenceReviewOutputSchema.parse(input.value);
  uniqueDenseIndices(
    output.evidence_points.map((point) => point.point_index),
    output.evidence_points.length,
    'evidence_points',
  );
  uniqueDenseIndices(
    output.request_coverage.map((coverage) => coverage.request_unit_index),
    input.requestUnits.length,
    'request_coverage',
  );

  for (const point of output.evidence_points) {
    uniqueIndices(point.request_unit_indices, input.requestUnits.length, 'request_unit_indices');
    for (const ref of point.source_refs) bindSourceRef(ref, input.toolTrace);
    if (
      point.kind === 'observed_fact' &&
      !point.source_refs.some(
        (ref) => ref.side === 'output' && (ref.role === 'value' || ref.role === 'relation'),
      )
    ) {
      throw new Error('observed fact lacks an output value or relation source');
    }
    if (
      (point.kind === 'scope_boundary' || point.kind === 'actual_gap') &&
      !point.source_refs.some((ref) => ref.role === 'scope' || ref.role === 'coverage')
    ) {
      throw new Error('scope or gap point lacks a scope/coverage source');
    }
  }
  for (const coverage of output.request_coverage) {
    uniqueIndices(
      coverage.evidence_point_indices,
      output.evidence_points.length,
      'request coverage evidence_point_indices',
    );
    const expected = output.evidence_points
      .filter((point) => point.request_unit_indices.includes(coverage.request_unit_index))
      .map((point) => point.point_index);
    if (!sameIndexSet(coverage.evidence_point_indices, expected) || expected.length === 0) {
      throw new Error('request coverage does not bind every ledger point for its request unit');
    }
    if (
      coverage.status === 'actual_gap' &&
      !coverage.evidence_point_indices.some(
        (index) => output.evidence_points[index]?.kind === 'actual_gap',
      )
    ) {
      throw new Error('actual_gap request coverage lacks a bound actual-gap point');
    }
    if (
      coverage.status === 'answerable' &&
      coverage.evidence_point_indices.some(
        (index) => output.evidence_points[index]?.kind === 'actual_gap',
      )
    ) {
      throw new Error('answerable request coverage contains an actual gap point');
    }
  }
  uniqueDenseIndices(
    output.trace_coverage.map((coverage) => coverage.call_index),
    input.toolTrace.length,
    'trace_coverage',
  );
  for (const coverage of output.trace_coverage) {
    uniqueIndices(
      coverage.request_unit_indices,
      input.requestUnits.length,
      'trace coverage request_unit_indices',
    );
    uniqueIndices(
      coverage.evidence_point_indices,
      output.evidence_points.length,
      'trace coverage evidence_point_indices',
    );
    const observation = input.toolTrace[coverage.call_index];
    const successfulRead =
      observation?.effect === 'read' && observation.executed && observation.error_reason === null;
    if (!successfulRead) {
      if (
        coverage.relevance !== 'unusable' ||
        coverage.request_unit_indices.length > 0 ||
        coverage.evidence_point_indices.length > 0
      ) {
        throw new Error('non-successful-read trace call must be explicitly unusable');
      }
      continue;
    }
    if (coverage.relevance === 'unusable') {
      throw new Error('successful read trace call cannot be marked unusable');
    }
    if (coverage.relevance === 'not_material') {
      if (coverage.request_unit_indices.length > 0 || coverage.evidence_point_indices.length > 0) {
        throw new Error('non-material trace call cannot bind request or evidence indices');
      }
      continue;
    }
    if (
      coverage.request_unit_indices.length === 0 ||
      coverage.evidence_point_indices.length === 0
    ) {
      throw new Error('material trace call lacks request/evidence bindings');
    }
    const coveredPoints = coverage.evidence_point_indices.map(
      (index) => output.evidence_points[index],
    );
    if (
      coveredPoints.some(
        (point) => !point?.source_refs.some((ref) => ref.call_index === coverage.call_index),
      )
    ) {
      throw new Error('trace coverage cites a point that does not cite the trace call');
    }
    const expectedRequestUnits = Array.from(
      new Set(coveredPoints.flatMap((point) => point?.request_unit_indices ?? [])),
    );
    if (!sameIndexSet(coverage.request_unit_indices, expectedRequestUnits)) {
      throw new Error('trace coverage request indices do not match its evidence points');
    }
    if (
      coverage.relevance === 'scope_only' &&
      coveredPoints.some((point) => point?.kind === 'observed_fact')
    ) {
      throw new Error('scope-only trace call binds an observed-fact point');
    }
  }
  for (const point of output.evidence_points) {
    for (const ref of point.source_refs) {
      const coverage = output.trace_coverage[ref.call_index];
      if (!coverage || coverage.relevance === 'not_material' || coverage.relevance === 'unusable') {
        throw new Error('evidence point cites a trace call not sealed as material');
      }
      if (!coverage.evidence_point_indices.includes(point.point_index)) {
        throw new Error('evidence point is absent from its trace coverage entry');
      }
    }
  }
  if (output.safe_reply.includes('<!--primary_view')) {
    throw new Error('blind reference reply must not nominate a primary view');
  }
  return { output, digest_sha256: sha256CanonicalJson(output) };
}

const nonFailureReasonCodes = new Set(['supported', 'actual_gap_disclosed', 'non_evidentiary']);

export function bindCopilotEvidenceComparison(input: {
  value: unknown;
  requestUnits: readonly EvidenceTextUnit[];
  replyUnits: readonly EvidenceTextUnit[];
  selectedReplySha256: string;
  reference: BoundCopilotEvidenceReference;
  toolTrace: readonly ToolExecutionResultObservation[];
  sourceComplete: boolean;
}): BoundCopilotEvidenceComparison {
  const output = CopilotEvidenceVerificationOutputSchema.parse(input.value);
  uniqueDenseIndices(
    output.reply_checks.map((check) => check.reply_unit_index),
    input.replyUnits.length,
    'reply_checks',
  );
  uniqueDenseIndices(
    output.request_checks.map((check) => check.request_unit_index),
    input.requestUnits.length,
    'request_checks',
  );

  let passes = true;
  const violations = new Set<string>();
  for (const check of output.reply_checks) {
    uniqueIndices(
      check.evidence_point_indices,
      input.reference.output.evidence_points.length,
      'reply evidence_point_indices',
    );
    for (const ref of check.source_refs) bindSourceRef(ref, input.toolTrace);
    const sealedSourceRefs = new Set(
      check.evidence_point_indices.flatMap((index) =>
        (input.reference.output.evidence_points[index]?.source_refs ?? []).map(sourceRefKey),
      ),
    );
    if (check.source_refs.some((ref) => !sealedSourceRefs.has(sourceRefKey(ref)))) {
      throw new Error('reply check source ref is not sealed by its evidence points');
    }
    const unit = input.replyUnits[check.reply_unit_index];
    if (!unit) throw new Error('reply check references absent unit');

    if (check.status === 'supported') {
      if (unit.syntax_only) {
        if (
          check.evidence_point_indices.length > 0 ||
          check.source_refs.length > 0 ||
          check.reason_codes.length !== 1 ||
          check.reason_codes[0] !== 'non_evidentiary'
        ) {
          throw new Error('syntax-only reply unit cannot carry material evidence');
        }
        continue;
      }
      const hasEvidence = check.evidence_point_indices.length > 0 || check.source_refs.length > 0;
      if (!hasEvidence) {
        throw new Error('supported reply unit has no bound evidence');
      }
      if (
        check.evidence_point_indices.some(
          (index) => input.reference.output.evidence_points[index]?.kind === 'actual_gap',
        )
      ) {
        passes = false;
        violations.add('requested_chain_incomplete');
      }
      if (check.reason_codes.some((code) => code !== 'supported' && code !== 'non_evidentiary')) {
        throw new Error('supported reply unit carries a failure or gap reason');
      }
      continue;
    }

    if (check.status === 'explicit_gap') {
      if (unit.syntax_only) throw new Error('syntax-only reply unit cannot disclose a gap');
      const gapPoint = check.evidence_point_indices.some((index) => {
        const kind = input.reference.output.evidence_points[index]?.kind;
        return kind === 'scope_boundary' || kind === 'actual_gap';
      });
      const gapRef = check.source_refs.some(
        (ref) => ref.role === 'scope' || ref.role === 'coverage',
      );
      if (!gapPoint && !gapRef) throw new Error('explicit gap lacks bound gap evidence');
      if (!check.reason_codes.includes('actual_gap_disclosed')) {
        throw new Error('explicit gap lacks actual_gap_disclosed reason');
      }
      if (check.reason_codes.some((code) => !nonFailureReasonCodes.has(code))) {
        throw new Error('explicit gap carries a violation code');
      }
      continue;
    }

    passes = false;
    const failureCodes = check.reason_codes.filter((code) => !nonFailureReasonCodes.has(code));
    if (failureCodes.length === 0) throw new Error('unsupported reply unit lacks violation code');
    for (const code of failureCodes) violations.add(code);
  }

  const replyPointCoverage = new Map<number, Set<number>>();
  for (const check of output.reply_checks) {
    replyPointCoverage.set(check.reply_unit_index, new Set(check.evidence_point_indices));
  }
  for (const check of output.request_checks) {
    uniqueIndices(check.reply_unit_indices, input.replyUnits.length, 'request reply_unit_indices');
    uniqueIndices(
      check.evidence_point_indices,
      input.reference.output.evidence_points.length,
      'request evidence_point_indices',
    );
    const referenceCoverage = input.reference.output.request_coverage[check.request_unit_index];
    const expected = referenceCoverage?.evidence_point_indices ?? [];
    const completeReferenceCoverage = sameIndexSet(check.evidence_point_indices, expected);
    const allowedReplyStatuses =
      check.status === 'answered' ? new Set(['supported']) : new Set(['supported', 'explicit_gap']);
    const replyCoversEveryPoint = expected.every((pointIndex) =>
      check.reply_unit_indices.some((replyIndex) => {
        const replyCheck = output.reply_checks[replyIndex];
        return (
          replyCheck !== undefined &&
          allowedReplyStatuses.has(replyCheck.status) &&
          input.replyUnits[replyIndex]?.syntax_only === false &&
          replyPointCoverage.get(replyIndex)?.has(pointIndex)
        );
      }),
    );

    if (check.status === 'missing') {
      passes = false;
      const failureCodes = check.reason_codes.filter((code) => !nonFailureReasonCodes.has(code));
      if (failureCodes.length === 0) throw new Error('missing request unit lacks violation code');
      for (const code of failureCodes) violations.add(code);
      continue;
    }
    if (check.reply_unit_indices.length === 0) {
      throw new Error('answered request unit has no bound reply unit');
    }
    if (!completeReferenceCoverage || !replyCoversEveryPoint) {
      passes = false;
      violations.add('requested_chain_incomplete');
    }
    if (referenceCoverage?.status === 'answerable' && check.status !== 'answered') {
      passes = false;
      violations.add('requested_chain_incomplete');
    }
    if (referenceCoverage?.status === 'actual_gap' && check.status !== 'explicit_gap') {
      passes = false;
      violations.add('requested_chain_incomplete');
    }
    if (check.status === 'explicit_gap') {
      if (!check.reason_codes.includes('actual_gap_disclosed')) {
        throw new Error('request explicit_gap lacks actual_gap_disclosed reason');
      }
      const failureCodes = check.reason_codes.filter((code) => !nonFailureReasonCodes.has(code));
      if (failureCodes.length > 0) {
        passes = false;
        for (const code of failureCodes) violations.add(code);
      }
      const actualGapPoints = expected.filter(
        (pointIndex) => input.reference.output.evidence_points[pointIndex]?.kind === 'actual_gap',
      );
      const explicitGapReplyCoversGap = actualGapPoints.some((pointIndex) =>
        check.reply_unit_indices.some((replyIndex) => {
          const replyCheck = output.reply_checks[replyIndex];
          return (
            replyCheck?.status === 'explicit_gap' &&
            input.replyUnits[replyIndex]?.syntax_only === false &&
            replyCheck.evidence_point_indices.includes(pointIndex)
          );
        }),
      );
      if (actualGapPoints.length === 0 || !explicitGapReplyCoversGap) {
        passes = false;
        violations.add('requested_chain_incomplete');
      }
    }
    if (check.status === 'answered') {
      const linkedReplyChecks = check.reply_unit_indices.map(
        (replyIndex) => output.reply_checks[replyIndex],
      );
      if (
        linkedReplyChecks.some((replyCheck) => !replyCheck || replyCheck.status !== 'supported')
      ) {
        passes = false;
        violations.add('requested_chain_incomplete');
      }
      if (check.reason_codes.some((code) => code !== 'supported' && code !== 'non_evidentiary')) {
        throw new Error('answered request unit carries a failure or gap reason');
      }
    }
  }

  if (!input.sourceComplete) {
    const allRequestsDiscloseGap = output.request_checks.every(
      (check) => check.status === 'explicit_gap',
    );
    if (!allRequestsDiscloseGap) {
      passes = false;
      violations.add('requested_chain_incomplete');
    }
  }

  return {
    output,
    verdict: passes ? 'pass' : 'fail',
    violations: [...violations],
    digest_sha256: sha256CanonicalJson({
      selected_reply_sha256: input.selectedReplySha256,
      reference_sha256: input.reference.digest_sha256,
      output,
      verdict: passes ? 'pass' : 'fail',
    }),
  };
}

export function safeValidationErrorDetail(error: unknown): string {
  if (isRecord(error) && Array.isArray(error.issues)) {
    return error.issues
      .slice(0, 6)
      .map((issue) => {
        if (!isRecord(issue)) return '<root>:invalid';
        const path = Array.isArray(issue.path) ? issue.path.join('.') : '<root>';
        return `${path || '<root>'}:${String(issue.code ?? 'invalid')}`;
      })
      .join(', ');
  }
  if (error instanceof Error) {
    // This helper is called only around the strict parser and this module's
    // fixed invariant errors; neither message contains provider output. Keep a
    // bounded single-line message for paid-run diagnosis without persisting
    // raw JSON, user prose, safe_reply, or reasoning.
    if (error.name === 'SyntaxError') return 'SyntaxError:output JSON syntax invalid';
    if (error.name === 'Error') {
      const message = error.message
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return message ? `Error:${message}`.slice(0, 240) : 'Error';
    }
    return error.name;
  }
  return 'invalid';
}
