// P5.5 Phase 1 — Tool-eval fixtures: the agent-readability assertion contract.
// Spec: docs/superpowers/specs/2026-05-31-p5.5-tool-eval-fixtures-design.md §3.
//
// This is the spec's PRIMARY deliverable (LD-4): a single reusable helper that
// makes "the tool output is intelligible to an agent" code-checkable. It is a
// test-support module (NON-`.test.ts`) so both the Phase-1 fixtures and any
// future Phase-2 fixtures import it verbatim.
//
// `assertAgentReadable` runs FOUR limbs, each a hard assertion (§3.2–§3.5):
//   (a) documented key-insight fields PRESENT + non-null for the scenario,
//   (b) every id the output cites RESOLVES to a seeded row,
//   (c) no nulls leak into a field the agent must reason on,
//   (d) the tool self-describes its cost (costClass enum + non-empty summarize
//       ≤120 chars).
//
// No production code is touched; this only reads existing `DomainTool` structs
// + `Output` shapes and the seeded DB. See §5.1 for partition rationale.

import type { Db } from '@/db/client';
import { completion_evidence, event, knowledge, learning_item, question } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import type { DomainTool, ToolCostClass } from './types';

/**
 * The seeded tables the 4 Phase-1 scenarios cite ids into (§9 open item 1 —
 * kept minimal; Phase 2 extends). Each maps to its drizzle table so limb (b)
 * can resolve an id back to a real row.
 */
export type SeededTable =
  | 'event'
  | 'question'
  | 'knowledge'
  | 'learning_item'
  | 'completion_evidence';

const SEEDED_TABLE_ID_COLUMN: Record<SeededTable, PgColumn> = {
  event: event.id,
  question: question.id,
  knowledge: knowledge.id,
  learning_item: learning_item.id,
  completion_evidence: completion_evidence.id,
};

const VALID_COST_CLASSES: readonly ToolCostClass[] = ['local', 'cheap_llm', 'expensive_llm'];

/** §3.5 — the contract pins the soft "~120 chars" guidance to a hard bound. */
const SUMMARY_MAX_CHARS = 120;

export interface AgentReadableSpec {
  /**
   * Dotted paths that MUST be present and non-null for THIS scenario, e.g.
   * `['mistakes.0.cause', 'mistakes.0.cause.primary_category']`. Array indices
   * are written as numeric segments; a trailing `[]` segment means "for every
   * element of this array, the remaining path must resolve" (elementwise).
   */
  keyInsightFields: string[];
  /**
   * Id-bearing dotted paths whose value(s) must resolve to a seeded row, paired
   * with the table to look them up in. Arrays are checked elementwise via the
   * `[]` segment.
   */
  idRefs: Array<{ path: string; table: SeededTable; column?: string }>;
  /**
   * Dotted paths that must NOT be null/undefined (the fields the agent reasons
   * on). Superset-friendly: `keyInsightFields` are auto-included.
   */
  nonNullFields?: string[];
  /**
   * When true (zero-result scenarios), key-insight CONTAINERS may be empty but
   * must be structurally present (e.g. `mistakes:[]` ok, never `null`). §3.4.
   */
  allowEmptyContainers?: boolean;
}

/**
 * One resolution of a dotted path. `unresolved:true` flags a path that FAILED
 * to resolve — a `[]` segment hit a non-array (`undefined` / nullish / wrong
 * shape) — as opposed to a legitimately-empty container (a real array with no
 * elements, which yields ZERO entries, not an `unresolved` entry). Limb (b)
 * (F2) relies on this distinction so a renamed / removed / non-array id path is
 * caught instead of silently filtered to empty.
 */
export interface ResolvedPath {
  value: unknown;
  path: string;
  /** True only when a `[]` segment expected an array and found a non-array. */
  unresolved?: boolean;
}

/**
 * Resolve a dotted path against `root`, expanding a `[]` segment into the array
 * of remaining-path resolutions for every element. Returns a flat list of
 * `{ value, path }` so callers can assert / look up elementwise.
 *
 * A `[]` segment over a REAL empty array yields ZERO entries (vacuously fine).
 * A `[]` segment over a NON-array (undefined / nullish / wrong shape) yields a
 * single `{ unresolved:true }` entry so callers can tell "container failed to
 * resolve" apart from "container is empty" (F2).
 *
 * Examples:
 *   resolvePath(out, 'total')              -> [{ value: out.total }]
 *   resolvePath(out, 'mistakes.0.cause')   -> [{ value: out.mistakes[0].cause }]
 *   resolvePath(out, 'mistakes[].cause')   -> one entry per mistakes[i].cause
 *   resolvePath(out, 'evidence[].id')      -> one entry per evidence[i].id
 *   resolvePath(out, 'missing[].id')       -> [{ unresolved:true }] (no array)
 */
export function resolvePath(root: unknown, path: string): ResolvedPath[] {
  const segments = splitPath(path);
  return walk(root, segments, 0, '');
}

function splitPath(path: string): Array<{ key: string; isArray: boolean }> {
  return path
    .split('.')
    .filter((s) => s.length > 0)
    .map((raw) => {
      if (raw.endsWith('[]')) return { key: raw.slice(0, -2), isArray: true };
      return { key: raw, isArray: false };
    });
}

function walk(
  current: unknown,
  segments: Array<{ key: string; isArray: boolean }>,
  index: number,
  trail: string,
): ResolvedPath[] {
  if (index >= segments.length) {
    return [{ value: current, path: trail || '<root>' }];
  }
  const seg = segments[index];
  const nextTrail = trail ? `${trail}.${seg.key}` : seg.key;
  const child =
    current && typeof current === 'object'
      ? (current as Record<string, unknown>)[seg.key]
      : undefined;

  if (seg.isArray) {
    if (!Array.isArray(child)) {
      // Surface as a single UNRESOLVED entry (F2) — a `[]` segment expected an
      // array and found undefined / nullish / a non-array. Distinct from a real
      // empty array (which yields zero entries, vacuously fine).
      return [{ value: undefined, path: `${nextTrail}[] (not-an-array)`, unresolved: true }];
    }
    return child.flatMap((el, i) => walk(el, segments, index + 1, `${nextTrail}.${i}`));
  }
  return walk(child, segments, index + 1, nextTrail);
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * The agent-readability contract (§3). Runs all four limbs as hard assertions.
 * Throws (via vitest `expect`) on the first limb that fails, naming the path so
 * a broken output is precisely located.
 */
export async function assertAgentReadable(
  db: Db,
  tool: DomainTool<unknown, unknown>,
  input: unknown,
  output: unknown,
  spec: AgentReadableSpec,
): Promise<void> {
  // ---- Limb (a) — key-insight fields present + non-null (§3.2) ----
  for (const fieldPath of spec.keyInsightFields) {
    const resolved = resolvePath(output, fieldPath);
    expect(
      resolved.length,
      `[${tool.name}] key-insight path "${fieldPath}" resolved to nothing`,
    ).toBeGreaterThan(0);
    for (const { value, path } of resolved) {
      if (spec.allowEmptyContainers && Array.isArray(value)) {
        // §3.4 — container may be empty but must be a non-null array, never null.
        expect(value, `[${tool.name}] container "${path}" must be a non-null array`).not.toBeNull();
        continue;
      }
      expect(
        isNullish(value),
        `[${tool.name}] key-insight field "${path}" is null/undefined (agent cannot reason on it)`,
      ).toBe(false);
    }
  }

  // ---- Limb (c) — no nulls in critical fields (§3.4) ----
  // keyInsightFields ∪ nonNullFields; key-insight already covered above, so we
  // only need the extra nonNullFields here.
  for (const fieldPath of spec.nonNullFields ?? []) {
    const resolved = resolvePath(output, fieldPath);
    expect(
      resolved.length,
      `[${tool.name}] non-null path "${fieldPath}" resolved to nothing`,
    ).toBeGreaterThan(0);
    for (const { value, path } of resolved) {
      expect(isNullish(value), `[${tool.name}] critical field "${path}" is null/undefined`).toBe(
        false,
      );
    }
  }

  // ---- Limb (b) — cited ids resolvable (§3.3) ----
  // `ref.column` is reserved for a future scenario that cites a non-id column;
  // the 4 Phase-1 scenarios all resolve against the table's id column.
  for (const ref of spec.idRefs) {
    const idColumn = SEEDED_TABLE_ID_COLUMN[ref.table];
    const resolved = resolvePath(output, ref.path);

    // F2 — distinguish a PATH THAT FAILED TO RESOLVE from a LEGITIMATE empty
    // container. A `[]` segment over a non-array yields an `unresolved` entry;
    // that is a hard failure (the cited path was renamed / removed / became a
    // non-array — exactly the regression this limb must catch, e.g.
    // `timeline[].event_id` or `proposal_ids[]` breaking). A real empty array
    // yields ZERO entries and is vacuously fine (F-3: `evidence_event_ids:[]`).
    const unresolved = resolved.filter((r) => r.unresolved);
    expect(
      unresolved.length,
      `[${tool.name}] id-ref path "${ref.path}" did not resolve to an array (${unresolved.map((u) => u.path).join(', ')}) — a renamed/removed/non-array id path must FAIL, not silently pass as empty`,
    ).toBe(0);

    // F2 — when the path resolves to elements, every present element MUST be a
    // non-nullish string id. A nullish / non-string element (e.g.
    // `timeline[].event_id === null`) is a broken citation, not a skip. (A real
    // empty array produced ZERO `resolved` entries above, so this loop is a
    // no-op for the vacuous-empty case — F-3 still holds.)
    for (const r of resolved) {
      expect(
        typeof r.value === 'string' && (r.value as string).length > 0,
        `[${tool.name}] id-ref element "${r.path}" (path "${ref.path}") is not a non-empty string id (got ${JSON.stringify(r.value)}) — a cited id the agent would follow must be a real id`,
      ).toBe(true);
    }

    const ids = resolved
      .map((r) => r.value)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (ids.length === 0) continue;
    const rows = await db
      .select({ id: idColumn })
      .from(tableForColumn(ref.table))
      .where(inArray(idColumn, [...new Set(ids)]));
    const found = new Set(rows.map((r) => String((r as { id: unknown }).id)));
    for (const id of ids) {
      expect(
        found.has(id),
        `[${tool.name}] cited id "${id}" (path "${ref.path}") does not resolve in seeded table "${ref.table}"`,
      ).toBe(true);
    }
  }

  // ---- Limb (d) — cost label present + well-shaped (§3.5 / LD-6) ----
  assertCostLabel(tool, input, output);
}

/**
 * Limb (d) extracted so the folded pure-logic self-test can exercise it on a
 * synthetic tool without seeding the DB.
 */
export function assertCostLabel(
  tool: DomainTool<unknown, unknown>,
  input: unknown,
  output: unknown,
): void {
  expect(
    VALID_COST_CLASSES.includes(tool.costClass),
    `[${tool.name}] costClass "${tool.costClass}" is not a valid ToolCostClass`,
  ).toBe(true);
  const summary = tool.summarize(input, output);
  expect(typeof summary, `[${tool.name}] summarize() must return a string`).toBe('string');
  expect(summary.length, `[${tool.name}] summarize() must be non-empty`).toBeGreaterThan(0);
  expect(
    summary.length,
    `[${tool.name}] summarize() length ${summary.length} exceeds hard ${SUMMARY_MAX_CHARS}-char bound`,
  ).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
}

function tableForColumn(table: SeededTable) {
  switch (table) {
    case 'event':
      return event;
    case 'question':
      return question;
    case 'knowledge':
      return knowledge;
    case 'learning_item':
      return learning_item;
    case 'completion_evidence':
      return completion_evidence;
  }
}
