// 已入库 revision 的摘要裁决。
//
// 新发布写规范封印。旧行里还有三类读方认的封印（规范、schema 键序、存库 jsonb
// 键序），以及编辑路径在 jsonb 重排之前按下的调用方键序。后者读回来对不上，
// 但不能靠「解析成功就改写成规范摘要」修：那样会把改过的层封成新的真摘要。
// 只有某条已知写方键序能把【当前存库的值】重新哈希成库存摘要时，才允许重封。

import {
  type PublishedContractSeal,
  contractIntegrityDigest,
  publishedContractSeal,
} from './assessment-normalization';

export interface ContractLayers {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
  presentation?: unknown;
}

/** 库存摘要相对存库层的身份。读方只认前三种；caller_order 要先重封。 */
export type StoredDigestVerdict =
  | { kind: 'canonical'; canonical: string }
  | { kind: 'legacy_schema'; canonical: string }
  | { kind: 'legacy_stored_order'; canonical: string }
  | { kind: 'caller_order'; canonical: string }
  | { kind: 'unbound' };

export type ResealDecision =
  | { action: 'keep' }
  | { action: 'rewrite'; canonical: string }
  | { action: 'leave_stale' };

const MAX_AUTHOR_UNITS = 6;

export function classifyStoredRevisionDigest(
  layers: ContractLayers,
  digest: string,
): StoredDigestVerdict {
  let seal: PublishedContractSeal;
  try {
    seal = publishedContractSeal(layers);
  } catch {
    return { kind: 'unbound' };
  }
  if (digest === seal.canonical) return { kind: 'canonical', canonical: seal.canonical };
  if (digest === seal.legacyParsed) return { kind: 'legacy_schema', canonical: seal.canonical };
  if (digest === seal.legacyRaw) {
    return { kind: 'legacy_stored_order', canonical: seal.canonical };
  }
  for (const candidate of callerOrderLayers(seal.parsed, layers)) {
    if (contractIntegrityDigest(candidate) === digest) {
      return { kind: 'caller_order', canonical: seal.canonical };
    }
  }
  return { kind: 'unbound' };
}

export function resealDecision(verdict: StoredDigestVerdict): ResealDecision {
  switch (verdict.kind) {
    case 'canonical':
    case 'legacy_schema':
    case 'legacy_stored_order':
      return { action: 'keep' };
    case 'caller_order':
      return { action: 'rewrite', canonical: verdict.canonical };
    case 'unbound':
      return { action: 'leave_stale' };
  }
}

export function layersOfStoredRevision(revision: {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
  presentation: unknown;
}): ContractLayers {
  return {
    structure: revision.structure,
    response_spec: revision.response_spec,
    scoring_basis: revision.scoring_basis,
    execution_plan: revision.execution_plan,
    ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
  };
}

function callerOrderLayers(
  parsed: PublishedContractSeal['parsed'],
  raw: ContractLayers,
): ContractLayers[] {
  return [
    ...preserveLayers(parsed, raw),
    ...authorLayers(parsed, raw),
    withPlacementLast(parsed),
    withUnknownKeysAppended(parsed, raw),
  ];
}

function preserveLayers(
  parsed: PublishedContractSeal['parsed'],
  raw: ContractLayers,
): ContractLayers[] {
  const base: ContractLayers = {
    structure: parsed.structure,
    response_spec: raw.response_spec,
    scoring_basis: raw.scoring_basis,
    execution_plan: raw.execution_plan,
  };
  const out = [base];
  if (parsed.presentation != null) out.push({ ...base, presentation: parsed.presentation });
  if (raw.presentation != null) out.push({ ...base, presentation: raw.presentation });
  return out;
}

function authorLayers(
  parsed: PublishedContractSeal['parsed'],
  raw: ContractLayers,
): ContractLayers[] {
  const units = parsed.scoring_basis.units;
  if (units.length === 0 || units.length > MAX_AUTHOR_UNITS) return [];
  const rawBasis = asRecord(raw.scoring_basis);
  const rawSpec = asRecord(raw.response_spec);
  const rawPlan = asRecord(raw.execution_plan);
  if (rawBasis == null || rawSpec == null || rawPlan == null) return [];
  const rawUnits = byKey(rawBasis.units, 'scoring_unit_id');
  const rawSlots = byKey(rawSpec.slots, 'slot_id');
  const rawAssignments = asArray(rawPlan.assignments);
  if (rawUnits == null || rawSlots == null || rawAssignments == null) return [];
  if (rawUnits.size !== units.length) return [];
  for (const unit of units) {
    if (!rawUnits.has(unit.scoring_unit_id)) return [];
  }

  const out: ContractLayers[] = [];
  const maskCount = 1 << units.length;
  for (let mask = 1; mask < maskCount; mask += 1) {
    const copied = new Set<string>();
    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      if (unit != null && (mask & (1 << index)) !== 0) copied.add(unit.scoring_unit_id);
    }
    const mixed = mixCopiedUnits(parsed, copied, rawUnits, rawSlots, rawAssignments);
    if (mixed != null) out.push(mixed);
  }
  return out;
}

function mixCopiedUnits(
  parsed: PublishedContractSeal['parsed'],
  copied: ReadonlySet<string>,
  rawUnits: ReadonlyMap<string, unknown>,
  rawSlots: ReadonlyMap<string, unknown>,
  rawAssignments: readonly unknown[],
): ContractLayers | null {
  const slotIds = new Set<string>();
  const units = parsed.scoring_basis.units.map((unit) => {
    if (!copied.has(unit.scoring_unit_id)) return unit;
    for (const slotId of unit.slot_refs) slotIds.add(slotId);
    for (const slotId of unit.evidence_slot_refs) slotIds.add(slotId);
    return rawUnits.get(unit.scoring_unit_id) ?? null;
  });
  if (units.some((unit) => unit == null)) return null;

  const slots = parsed.response_spec.slots.map((slot) => {
    if (!slotIds.has(slot.slot_id)) return slot;
    return rawSlots.get(slot.slot_id) ?? null;
  });
  if (slots.some((slot) => slot == null)) return null;

  const assignments = parsed.execution_plan.assignments.map((assignment) => {
    const unitId = assignment.scoring_unit_ids.length === 1 ? assignment.scoring_unit_ids[0] : null;
    if (unitId == null || !copied.has(unitId)) return assignment;
    const rawAssignment = rawAssignments.find((item) => dedicatedUnitId(item) === unitId);
    return rawAssignment ?? null;
  });
  if (assignments.some((assignment) => assignment == null)) return null;

  return {
    structure: parsed.structure,
    response_spec: { ...parsed.response_spec, slots },
    scoring_basis: { ...parsed.scoring_basis, units },
    execution_plan: { ...parsed.execution_plan, assignments },
    ...(parsed.presentation != null ? { presentation: parsed.presentation } : {}),
  };
}

function withPlacementLast(parsed: PublishedContractSeal['parsed']): ContractLayers {
  return {
    structure: moveKeyLast(parsed.structure, 'placement'),
    response_spec: moveKeyLast(parsed.response_spec, 'placement'),
    scoring_basis: moveKeyLast(parsed.scoring_basis, 'placement'),
    execution_plan: moveKeyLast(parsed.execution_plan, 'placement'),
    ...(parsed.presentation != null
      ? { presentation: moveKeyLast(parsed.presentation, 'placement') }
      : {}),
  };
}

function withUnknownKeysAppended(
  parsed: PublishedContractSeal['parsed'],
  raw: ContractLayers,
): ContractLayers {
  return {
    structure: graftUnknown(parsed.structure, raw.structure),
    response_spec: graftUnknown(parsed.response_spec, raw.response_spec),
    scoring_basis: graftUnknown(parsed.scoring_basis, raw.scoring_basis),
    execution_plan: graftUnknown(parsed.execution_plan, raw.execution_plan),
    ...(parsed.presentation != null
      ? { presentation: graftUnknown(parsed.presentation, raw.presentation) }
      : {}),
  };
}

function moveKeyLast(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((item) => moveKeyLast(item, key));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(value)) {
    if (name === key) continue;
    out[name] = moveKeyLast(value[name], key);
  }
  if (Object.hasOwn(value, key)) out[key] = moveKeyLast(value[key], key);
  return out;
}

function graftUnknown(parsed: unknown, raw: unknown): unknown {
  if (Array.isArray(parsed)) {
    const rawItems = Array.isArray(raw) ? raw : [];
    return parsed.map((item, index) => graftUnknown(item, rawItems[index]));
  }
  if (!isRecord(parsed) || !isRecord(raw)) return parsed;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) out[key] = graftUnknown(parsed[key], raw[key]);
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(out, key)) out[key] = raw[key];
  }
  return out;
}

function dedicatedUnitId(assignment: unknown): string | null {
  if (!isRecord(assignment) || !Array.isArray(assignment.scoring_unit_ids)) return null;
  const ids = assignment.scoring_unit_ids;
  return ids.length === 1 && typeof ids[0] === 'string' ? ids[0] : null;
}

function byKey(value: unknown, key: string): Map<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const map = new Map<string, unknown>();
  for (const item of value) {
    if (!isRecord(item) || typeof item[key] !== 'string') return null;
    if (map.has(item[key])) return null;
    map.set(item[key], item);
  }
  return map;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
