/**
 * Pure comparison helpers for the dependency regression ratchets
 * (2026-10-20 proposal §1–§2). Callers supply measured edge sets at base and
 * head; this module owns the verdicts. No git, fs or parsing here.
 */
import type { EdgeRecord } from './source-size';

export type AuditedDebt = 'capabilityToServer' | 'crossCapabilityValue' | 'capabilityToKernel';

export interface RatchetEdge {
  /** Repo-relative consumer file. */
  file: string;
  /** Resolved repo-relative target module. */
  module: string;
  kind: 'value' | 'type';
  /** Imported/re-exported symbol names ('*' for namespace/bare/dynamic). */
  symbols: string[];
  debt: AuditedDebt;
}

export interface RatchetViolation {
  file: string;
  source: string;
  reason: string;
}

function edgeKey(file: string, module: string): string {
  return `${file} -> ${module}`;
}

/** Rename-normalize an endpoint: a base path that was moved maps to head. */
function normalize(path: string, renames: ReadonlyMap<string, string>): string {
  return renames.get(path) ?? path;
}

/**
 * Edges present at head but not at base (after rename normalization of both
 * endpoints). This is the "new dependency" set the records must cover.
 */
export function addedEdges(
  base: readonly RatchetEdge[],
  head: readonly RatchetEdge[],
  renames: ReadonlyMap<string, string>,
): RatchetEdge[] {
  const baseKeys = new Set(
    base.map((edge) => edgeKey(normalize(edge.file, renames), normalize(edge.module, renames))),
  );
  return head.filter((edge) => !baseKeys.has(edgeKey(edge.file, edge.module)));
}

function sameSymbols(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((symbol, i) => symbol === sorted[i]);
}

/**
 * Every new audited edge needs exactly one edgeRecord, and every new record
 * must correspond to a real new edge (1:1). Historical records are append-only
 * and are not re-punished.
 */
export function auditEdgeRecords(input: {
  records: readonly EdgeRecord[];
  previousRecords: number;
  head: readonly RatchetEdge[];
  added: readonly RatchetEdge[];
}): RatchetViolation[] {
  const violations: RatchetViolation[] = [];
  const fail = (file: string, source: string, reason: string) =>
    violations.push({ file, source, reason });

  const byEdge = new Map<string, RatchetEdge>();
  for (const edge of input.head) byEdge.set(edgeKey(edge.file, edge.module), edge);

  const covering = new Set<string>();
  for (const record of input.records) {
    covering.add(`${record.debt}|${record.file}|${record.module}`);
  }
  for (const edge of input.added) {
    if (!covering.has(`${edge.debt}|${edge.file}|${edge.module}`)) {
      fail(
        edge.file,
        edge.module,
        `new ${edge.debt} dependency must be registered in edgeRecords {file, module, symbols, issue, owns} — the record must match the real edge`,
      );
    }
  }

  for (const record of input.records.slice(input.previousRecords)) {
    const key = edgeKey(record.file, record.module);
    const edge = byEdge.get(key);
    if (!edge || edge.debt !== record.debt) {
      fail(
        record.file,
        record.module,
        `edgeRecord names ${record.debt} edge that does not exist at head`,
      );
      continue;
    }
    if (
      !input.added.some(
        (added) => added.debt === edge.debt && edgeKey(added.file, added.module) === key,
      )
    ) {
      fail(
        record.file,
        record.module,
        'edgeRecord covers an edge that already existed at base — records register only new dependencies',
      );
      continue;
    }
    if (edge.kind !== record.kind) {
      fail(record.file, record.module, `edgeRecord kind=${record.kind} != measured ${edge.kind}`);
    }
    if (!sameSymbols(record.symbols, edge.symbols)) {
      fail(
        record.file,
        record.module,
        `edgeRecord symbols [${record.symbols.join(', ')}] != consumed symbols [${edge.symbols.join(', ')}]`,
      );
    }
  }
  return violations;
}

/**
 * Kernel/core must not reverse-import capabilities or server — a reverse edge
 * is how a facade hides the real dependency. Existing stock is grandfathered
 * by the base set; NEW value edges fail, new type edges are only reported.
 */
export function auditKernelReverseEdges(input: {
  base: readonly { file: string; module: string; kind: 'value' | 'type' }[];
  head: readonly { file: string; module: string; kind: 'value' | 'type' }[];
  renames: ReadonlyMap<string, string>;
}): { violations: RatchetViolation[]; newValueEdges: number; newTypeEdges: number } {
  const baseKeys = new Set(
    input.base.map((edge) =>
      edgeKey(normalize(edge.file, input.renames), normalize(edge.module, input.renames)),
    ),
  );
  const added = input.head.filter((edge) => !baseKeys.has(edgeKey(edge.file, edge.module)));
  const violations: RatchetViolation[] = [];
  let newTypeEdges = 0;
  for (const edge of added) {
    if (edge.kind === 'type') {
      newTypeEdges += 1;
      continue;
    }
    violations.push({
      file: edge.file,
      source: edge.module,
      reason:
        'kernel/core may not import capabilities or server — a reverse edge hides the real dependency behind a facade',
    });
  }
  return { violations, newValueEdges: added.length - newTypeEdges, newTypeEdges };
}

/**
 * A new capability -> kernel edge whose target itself reverse-imports
 * capability/server code is a suspected facade for the real dependency.
 */
export function auditKernelFacadeConsumption(input: {
  added: readonly RatchetEdge[];
  kernelReverseValueTargets: ReadonlySet<string>;
}): RatchetViolation[] {
  const violations: RatchetViolation[] = [];
  for (const edge of input.added) {
    if (edge.debt !== 'capabilityToKernel') continue;
    if (!input.kernelReverseValueTargets.has(edge.module)) continue;
    violations.push({
      file: edge.file,
      source: edge.module,
      reason:
        'new kernel-consumption edge targets a module that itself reverse-imports capabilities/server — it may be a facade for the real dependency',
    });
  }
  return violations;
}

/**
 * SCC vs-base gates: every new nontrivial component must be a subset of a base
 * component, the total members in nontrivial SCCs must not grow, and the
 * largest component must not grow. The component COUNT is reported, never
 * blocked — splitting one cycle into smaller ones can be an improvement.
 */
export function compareSccsAgainstBase(
  actual: readonly (readonly string[])[],
  base: readonly (readonly string[])[],
): { violations: RatchetViolation[]; actualCount: number; baseCount: number } {
  const current = actual
    .filter((component) => component.length > 1)
    .map((component) => [...component].sort());
  const previous = base
    .filter((component) => component.length > 1)
    .map((component) => [...component].sort());
  const previousSets = previous.map((component) => new Set(component));
  const violations: RatchetViolation[] = [];

  const grown = current.filter(
    (component) =>
      !previousSets.some((baseSet) => component.every((member) => baseSet.has(member))),
  );
  if (grown.length > 0) {
    violations.push({
      file: 'scripts/capability-boundary-baseline.json',
      source: 'crossCapabilityValue.nontrivialSccs',
      reason: `nontrivial SCC(s) introduce members outside any base component${
        previous.length === 0 ? ' — a cycle may not reappear once the base has none' : ''
      }: ${JSON.stringify(grown)}`,
    });
  }
  const currentMembers = new Set(current.flat()).size;
  const previousMembers = new Set(previous.flat()).size;
  if (currentMembers > previousMembers) {
    violations.push({
      file: 'scripts/capability-boundary-baseline.json',
      source: 'crossCapabilityValue.nontrivialSccs',
      reason: `members participating in nontrivial SCCs grew ${previousMembers} -> ${currentMembers}`,
    });
  }
  const currentMax = Math.max(0, ...current.map((c) => c.length));
  const previousMax = Math.max(0, ...previous.map((c) => c.length));
  if (currentMax > previousMax) {
    violations.push({
      file: 'scripts/capability-boundary-baseline.json',
      source: 'crossCapabilityValue.nontrivialSccs',
      reason: `largest nontrivial SCC grew ${previousMax} -> ${currentMax} members`,
    });
  }
  return { violations, actualCount: current.length, baseCount: previous.length };
}
