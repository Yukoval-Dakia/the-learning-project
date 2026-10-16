// YUK-1445 (Stage 1 / G2) — per-scoring-unit method calibration.
//
// For every resolved unit we freeze a probe set (digest-pinned) and execute it
// through the SAME evaluateSubmissionCore real submissions use — no second
// grader, no heuristic re-implementation. Probe classes (design §4 step 4):
//   - reference      : the agreed key itself must score full marks
//   - equivalent     : claimed-equivalent forms must score identically
//   - typical_wrong  : common wrong answers must NOT score full marks
//   - over_select    : (select) key ∪ one wrong item must not score full marks
//   - blank_state    : explicit blank obeys basis.blank_scores_zero policy
//   - unknown_state  : unreadable must land pending, never a fake zero
// Any failing/pending-unexpected probe blocks admission; changing method or
// rule produces a new method_fingerprint and forces recalibration.

import { canonicalHash } from '@/core/migration/canonical';
import { evaluateSubmissionCore } from '@/core/schema/assessment/evaluation';
import { compareItemSets } from '@/core/schema/assessment/grade';
import type { ResponseSlotT, SelectSlotT, SlotResponseT } from '@/core/schema/assessment/response';
import type { PublishedQuestionRevisionT } from '@/core/schema/assessment/revision';
import type { ScoringUnitT } from '@/core/schema/assessment/scoring';
import {
  type RuleFacts,
  type RuleResult,
  evaluateScoringRule,
} from '@/core/schema/assessment/scoring-rule';
import type { AdmissionUnitSpec } from './contract';
import type { AdmissionKey } from './solve';

export type ProbeExpected =
  | { kind: 'scored'; points: number }
  | { kind: 'scored_unknown_points' }
  | { kind: 'pending'; reason: string };

export interface AdmissionProbe {
  probe_id: string;
  scoring_unit_id: string;
  slot_id: string;
  kind:
    | 'reference'
    | 'equivalent'
    | 'typical_wrong'
    | 'over_select'
    | 'blank_state'
    | 'unknown_state';
  /** 冻结探针作答（只含该 unit 的主槽位 entry）。 */
  entry: SlotResponseT;
  expected: ProbeExpected;
  /** 备注（equivalent/wrong 的来源说明）。 */
  note?: string;
}

export interface ProbeOutcome {
  probe_id: string;
  scoring_unit_id: string;
  kind: AdmissionProbe['kind'];
  expected: ProbeExpected;
  actual:
    | { kind: 'scored'; points_awarded: number | null }
    | { kind: 'pending'; reason: string }
    | { kind: 'evaluation_error'; detail: string };
  ok: boolean;
}

/** 方法与规则的指纹 —— 任一变化即产生新 fingerprint，旧校准自动失效。 */
export function methodFingerprint(
  unit: ScoringUnitT,
  slot: ResponseSlotT,
  comparator: string,
): string {
  return canonicalHash({
    v: 1,
    scoring_unit_id: unit.scoring_unit_id,
    criterion: unit.criterion,
    rule: unit.rule ?? null,
    points: unit.points,
    comparator,
    slot:
      slot.kind === 'select'
        ? { kind: 'select', items: slot.items.map((i) => i.item_id).sort(), pick: slot.pick }
        : { kind: slot.kind },
  });
}

/** probe 集冻结 digest —— 覆盖全部探针 envelope + expected + method fingerprint。 */
export function probeSetDigest(probes: readonly AdmissionProbe[]): string {
  return canonicalHash({ v: 1, probes });
}

function ruleExpectation(facts: RuleFacts, rule: ScoringUnitT['rule']): ProbeExpected {
  if (rule == null) return { kind: 'pending', reason: 'unjudgeable' };
  const result: RuleResult = evaluateScoringRule(rule, facts);
  return result.kind === 'points'
    ? { kind: 'scored', points: result.points }
    : { kind: 'scored_unknown_points' };
}

function setFacts(picked: readonly string[], key: readonly string[]): RuleFacts {
  const comparison = compareItemSets(picked, key);
  return { kind: 'set', ...comparison };
}

const blankFacts = (correct: 0 | 1): RuleFacts => ({ kind: 'single', correct });

/**
 * 冻结一个已解析单元的探针集。slot 必须是 resolved spec 中的 select/blank 槽；
 * wrong 探针若与键归一化等价会被跳过（如实记录 skipped）。
 */
export function freezeProbes(
  unit: ScoringUnitT,
  unitSpec: AdmissionUnitSpec,
  slot: ResponseSlotT,
  key: AdmissionKey,
  basis: { blank_scores_zero: boolean },
  probeCandidates?: {
    equivalent_forms?: { item_ids?: string[]; text?: string }[];
    typical_wrong?: { item_ids?: string[]; text?: string; reason_md?: string }[];
  },
): { probes: AdmissionProbe[]; skipped: { kind: string; reason: string }[] } {
  const probes: AdmissionProbe[] = [];
  const skipped: { kind: string; reason: string }[] = [];
  const slotId = slot.slot_id;
  const unitId = unit.scoring_unit_id;
  const rule = unit.rule;
  let seq = 0;
  const push = (
    kind: AdmissionProbe['kind'],
    entry: SlotResponseT,
    expected: ProbeExpected,
    note?: string,
  ) => {
    probes.push({
      probe_id: `${unitId}::p${seq++}`,
      scoring_unit_id: unitId,
      slot_id: slotId,
      kind,
      entry,
      expected,
      ...(note != null ? { note } : {}),
    });
  };
  const skip = (kind: string, reason: string) => skipped.push({ kind, reason });

  if (slot.kind === 'select' && key.kind === 'select') {
    const keyIds = key.accepted_item_ids;
    const universe = new Set(slot.items.map((i) => i.item_id));
    const nonKey = slot.items.filter((i) => !keyIds.includes(i.item_id)).map((i) => i.item_id);
    push(
      'reference',
      { slot_id: slotId, kind: 'select', state: 'answered', item_ids: keyIds },
      ruleExpectation(setFacts(keyIds, keyIds), rule),
      'agreed key must score full marks',
    );
    if (keyIds.length > 1) {
      push(
        'equivalent',
        { slot_id: slotId, kind: 'select', state: 'answered', item_ids: [...keyIds].reverse() },
        ruleExpectation(setFacts(keyIds, keyIds), rule),
        'envelope order must not affect set grading',
      );
    }
    for (const wrongId of nonKey) {
      push(
        'typical_wrong',
        { slot_id: slotId, kind: 'select', state: 'answered', item_ids: [wrongId] },
        ruleExpectation(setFacts([wrongId], keyIds), rule),
      );
    }
    const firstNonKey = nonKey[0];
    if (firstNonKey != null && overSelectAllowed(slot, keyIds, firstNonKey)) {
      const picked = [...keyIds, firstNonKey];
      push(
        'over_select',
        { slot_id: slotId, kind: 'select', state: 'answered', item_ids: picked },
        ruleExpectation(setFacts(picked, keyIds), rule),
        'key + one wrong item',
      );
    } else if (nonKey.length > 0) {
      skip('over_select', 'at_most_per_coordinate forbids the over-selection envelope');
    }
    for (const form of probeCandidates?.equivalent_forms ?? []) {
      if (form.item_ids == null) continue;
      if (form.item_ids.some((id) => !universe.has(id))) {
        skip('equivalent', 'solver emitted an item id outside the declared universe');
        continue;
      }
      push(
        'equivalent',
        { slot_id: slotId, kind: 'select', state: 'answered', item_ids: form.item_ids },
        ruleExpectation(setFacts(form.item_ids, keyIds), rule),
        'solver-claimed equivalent form',
      );
    }
    for (const wrong of probeCandidates?.typical_wrong ?? []) {
      if (wrong.item_ids == null) continue;
      if (wrong.item_ids.some((id) => !universe.has(id))) {
        skip('typical_wrong', 'solver emitted an item id outside the declared universe');
        continue;
      }
      push(
        'typical_wrong',
        { slot_id: slotId, kind: 'select', state: 'answered', item_ids: wrong.item_ids },
        ruleExpectation(setFacts(wrong.item_ids, keyIds), rule),
        wrong.reason_md,
      );
    }
  } else if (slot.kind === 'blank' && (key.kind === 'blank_text' || key.kind === 'blank_numeric')) {
    const reference =
      key.kind === 'blank_text'
        ? (key.accepted[0] ?? '')
        : key.expected_unit != null
          ? `${key.expected} ${key.expected_unit}`
          : String(key.expected);
    push(
      'reference',
      { slot_id: slotId, kind: 'blank', state: 'answered', text: reference },
      ruleExpectation(blankFacts(1), rule),
      'agreed key must score full marks',
    );
    if (key.kind === 'blank_text') {
      for (const variant of key.accepted.slice(1)) {
        push(
          'equivalent',
          { slot_id: slotId, kind: 'blank', state: 'answered', text: variant },
          ruleExpectation(blankFacts(1), rule),
          'declared accepted variant must score full marks',
        );
      }
      // normalization 探针：按声明的归一化能力生成等价变体（如 trim/casefold）。
      const normalization = unitSpec.blank_normalization;
      if (normalization?.trim_outer || normalization?.collapse_whitespace) {
        push(
          'equivalent',
          { slot_id: slotId, kind: 'blank', state: 'answered', text: `  ${reference}  ` },
          ruleExpectation(blankFacts(1), rule),
          'outer whitespace must normalize away',
        );
      }
      if (normalization?.casefold) {
        push(
          'equivalent',
          {
            slot_id: slotId,
            kind: 'blank',
            state: 'answered',
            text: reference.toUpperCase(),
          },
          ruleExpectation(blankFacts(1), rule),
          'declared casefold equivalence',
        );
      }
    }
    for (const form of probeCandidates?.equivalent_forms ?? []) {
      if (form.text == null) continue;
      push(
        'equivalent',
        { slot_id: slotId, kind: 'blank', state: 'answered', text: form.text },
        ruleExpectation(blankFacts(1), rule),
        'solver-claimed equivalent form',
      );
    }
    const wrongs = (probeCandidates?.typical_wrong ?? [])
      .filter((w): w is { text: string; reason_md?: string } => w.text != null)
      .map((w) => ({ text: w.text, reason: w.reason_md }));
    if (wrongs.length === 0 && key.kind === 'blank_numeric') {
      const wrongValue =
        key.tolerance.kind === 'absolute'
          ? key.expected + key.tolerance.value + 1
          : key.expected === 0
            ? key.expected + 1
            : key.expected * (1 + key.tolerance.ratio) + 1;
      wrongs.push({ text: String(wrongValue), reason: 'synthesized out-of-tolerance value' });
    }
    if (wrongs.length === 0 && key.kind === 'blank_text') {
      wrongs.push({ text: `${reference}x`, reason: 'synthesized perturbation of the reference' });
    }
    for (const wrong of wrongs) {
      push(
        'typical_wrong',
        { slot_id: slotId, kind: 'blank', state: 'answered', text: wrong.text },
        ruleExpectation(blankFacts(0), rule),
        wrong.reason,
      );
    }
  } else {
    return {
      probes: [],
      skipped: [{ kind: 'all', reason: 'unsupported unit/slot pair for probing' }],
    };
  }

  // 状态类探针：blank / unknown 显式未决语义（不伪零分）。
  const blankEntry: SlotResponseT =
    slot.kind === 'select'
      ? { slot_id: slotId, kind: 'select', state: 'blank', item_ids: [] }
      : { slot_id: slotId, kind: 'blank', state: 'blank', text: '' };
  push(
    'blank_state',
    blankEntry,
    basis.blank_scores_zero
      ? { kind: 'scored', points: 0 }
      : { kind: 'pending', reason: 'needs_review' },
    'explicit blank follows basis.blank_scores_zero policy',
  );
  const unknownEntry: SlotResponseT =
    slot.kind === 'select'
      ? { slot_id: slotId, kind: 'select', state: 'unknown', item_ids: [] }
      : { slot_id: slotId, kind: 'blank', state: 'unknown', text: '' };
  push(
    'unknown_state',
    unknownEntry,
    { kind: 'pending', reason: 'unparseable_response' },
    'unreadable must stay pending — never a fake zero',
  );
  return { probes, skipped };
}

/** at_most_per_coordinate 是输入语义（结构违背 ⇒ 信封非法）；越限的
 * over-select 探针不是有效作答，跳过并记录。 */
function overSelectAllowed(slot: SelectSlotT, keyIds: readonly string[], extraId: string): boolean {
  const limits = slot.at_most_per_coordinate;
  if (limits == null) return true;
  const itemById = new Map(slot.items.map((i) => [i.item_id, i] as const));
  const picked = [...keyIds, extraId];
  for (const [axis, limit] of Object.entries(limits)) {
    const uses = new Map<string, number>();
    for (const id of picked) {
      const value = itemById.get(id)?.coordinates?.[axis];
      if (value != null) uses.set(value, (uses.get(value) ?? 0) + 1);
    }
    for (const count of uses.values()) if (count > limit) return false;
  }
  return true;
}

function matchesExpected(actual: ProbeOutcome['actual'], expected: ProbeExpected): boolean {
  if (expected.kind === 'scored') {
    return (
      actual.kind === 'scored' &&
      actual.points_awarded != null &&
      Math.abs(actual.points_awarded - expected.points) <=
        1e-9 * Math.max(1, Math.abs(expected.points))
    );
  }
  if (expected.kind === 'scored_unknown_points') {
    return actual.kind === 'scored' && actual.points_awarded === null;
  }
  return actual.kind === 'pending' && actual.reason === expected.reason;
}

/**
 * 通过 evaluateSubmissionCore 逐探针执行（与真实提交同一条判分路径）。
 * revision 是含已解析 basis/plan 的冻结 revision 形；synthetic submission 只
 * 带被测单元的主槽位 entry。
 */
export async function runCalibrationProbes(
  revision: PublishedQuestionRevisionT,
  probes: readonly AdmissionProbe[],
): Promise<ProbeOutcome[]> {
  const outcomes: ProbeOutcome[] = [];
  for (const probe of probes) {
    const submission = {
      submission_id: `sub_probe_${probe.probe_id}`,
      issuance_id: `iss_probe`,
      revision_id: revision.revision_id,
      evaluation_group_id: `eg_probe`,
      response_set: { entries: [probe.entry] },
      group_evidence: [],
      idempotency_key: `admission-probe:${probe.probe_id}`,
      submitted_at: revision.published_at,
    };
    let actual: ProbeOutcome['actual'];
    try {
      const result = await evaluateSubmissionCore({
        evaluation_id: `ev_probe_${probe.probe_id}`,
        submission,
        revision,
        attempt: 1,
        provenance: { source: 'automatic', assisted: false },
      });
      const unitResult = result.record.unit_results.find(
        (r) => r.scoring_unit_id === probe.scoring_unit_id,
      );
      if (unitResult == null) {
        actual = { kind: 'evaluation_error', detail: 'no unit result emitted for probe' };
      } else if (unitResult.status === 'scored') {
        actual = { kind: 'scored', points_awarded: unitResult.points_awarded };
      } else {
        actual = { kind: 'pending', reason: unitResult.pending.reason };
      }
    } catch (error) {
      actual = {
        kind: 'evaluation_error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    outcomes.push({
      probe_id: probe.probe_id,
      scoring_unit_id: probe.scoring_unit_id,
      kind: probe.kind,
      expected: probe.expected,
      actual,
      ok: matchesExpected(actual, probe.expected),
    });
  }
  return outcomes;
}
