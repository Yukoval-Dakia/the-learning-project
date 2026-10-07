import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildProductionWriteIndex,
  countWriteHits,
  isProductionSource,
} from './audit-schema-writes';

function evidence(source: string, field = 'stale') {
  return countWriteHits(
    'target',
    field,
    buildProductionWriteIndex(new Map([['src/runtime.ts', source]])),
  );
}

describe('bounded evidence rejects unproven identities and values', () => {
  it.each([
    [
      'reassigned builder',
      'let build = () => ({stale: 1}); build = () => ({real: 1}); db.insert(target).values(build());',
    ],
    ['deleted field', 'const row = {stale: 1}; delete row.stale; db.insert(target).values(row);'],
    [
      'replaced nested object',
      'const config = {set: {stale: 1}}; config.set = {real: 1}; db.insert(target).values({id: 1}).onConflictDoUpdate(config);',
    ],
    [
      'overriding spread',
      'const config = {set: {stale: 1}, ...{set: {real: 1}}}; db.insert(target).values({id: 1}).onConflictDoUpdate(config);',
    ],
    [
      'inline overriding spread',
      'db.insert(target).values({id: 1}).onConflictDoUpdate({set: {stale: 1}, ...{set: {real: 1}}});',
    ],
    [
      'duplicate property',
      'db.insert(target).values({id: 1}).onConflictDoUpdate({set: {stale: 1}, set: {real: 1}});',
    ],
    [
      'unknown overriding spread',
      'db.insert(target).values({id: 1}).onConflictDoUpdate({set: {stale: 1}, ...unknown()});',
    ],
    ['array selection', 'const rows = [{stale: 1}, {real: 1}]; db.insert(target).values(rows[1]);'],
    [
      'shadowed table',
      "import {target} from './schema'; function persist(target) { db.insert(target).values({stale: 1}); } persist(other);",
    ],
    [
      'reassigned table',
      "import {target, other} from './schema'; let table = target; table = other; db.insert(table).values({stale: 1});",
    ],
    [
      'overridden map',
      'const input = {map: () => []}; db.insert(target).values(input.map(() => ({stale: 1})));',
    ],
    [
      'overridden filter',
      'const input = {stale: 1, filter: () => []}; db.insert(target).values(input.filter(() => true));',
    ],
    [
      'missing argument',
      'function build(row) { return row; } build({stale: 1}); db.insert(target).values(build());',
    ],
    [
      'missing argument with fallback',
      'function build(row) { return row ?? {real: 1}; } build({stale: 1}); db.insert(target).values(build());',
    ],
    [
      'default argument belongs to this call',
      'function build(row, value = row) { return value; } build({stale: 1}); db.insert(target).values(build({real: 1}));',
    ],
  ])('%s cannot manufacture a stale column', (_name, source) => {
    expect(evidence(source)).toEqual({ insert_files: 0, update_files: 0 });
  });

  it.each([
    ['literal override', '{set: {stale: 1}, set: {real: 1}}'],
    ['spread override', '{set: {stale: 1}, ...{set: {real: 1}}}'],
    ['explicit final value', '{...unknown(), set: {real: 1}}'],
  ])('retains the proven final set in %s', (_name, config) => {
    expect(
      evidence(`db.insert(target).values({id: 1}).onConflictDoUpdate(${config});`, 'real'),
    ).toEqual({ insert_files: 0, update_files: 1 });
  });

  it('binds a default parameter to the preceding actual argument', () => {
    const source =
      'function build(row, value = row) { return value; } db.insert(target).values(build({real: 1}));';
    expect(evidence(source, 'real').insert_files).toBe(1);
  });
});

it('loses each of seven real construction fields in the full production index', () => {
  function walk(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const file = join(path, entry.name);
      return entry.isDirectory()
        ? walk(file)
        : /\.tsx?$/.test(file) && isProductionSource(file)
          ? [file]
          : [];
    });
  }
  const sources = new Map(walk('src').map((file) => [file, readFileSync(file, 'utf8')]));
  const baseline = buildProductionWriteIndex(sources);
  for (const [file, table, field] of [
    ['src/kernel/events/events.ts', 'event', 'actor_ref'],
    ['src/server/memory/brief.ts', 'memory_brief_note', 'scope_key'],
    ['src/capabilities/notes/server/block-refs.ts', 'artifact_block_ref', 'ref_kind'],
    ['src/server/projections/item_calibration.ts', 'item_calibration', 'irt_a'],
    ['src/capabilities/ingestion/server/persist-image-asset.ts', 'source_asset', 'width'],
    ['src/capabilities/ingestion/server/persist-image-asset.ts', 'source_asset', 'height'],
    ['src/capabilities/ingestion/server/import-completion.ts', 'question', 'visual_complexity'],
  ]) {
    expect(
      countWriteHits(table, field, new Map([[file, baseline.get(file) ?? []]])).insert_files,
      `${table}.${field}`,
    ).toBe(1);
    const original = sources.get(file);
    if (!original) throw new Error(`missing production source ${file}`);
    const changed = original.replace(new RegExp(`\\b${field}\\s*:`, 'g'), 'removed_column:');
    expect(changed).not.toBe(original);
    const mutated = buildProductionWriteIndex(new Map(sources).set(file, changed));
    expect(
      countWriteHits(table, field, new Map([[file, mutated.get(file) ?? []]])),
      `${table}.${field}`,
    ).toEqual({ insert_files: 0, update_files: 0 });
  }
}, 90_000);
