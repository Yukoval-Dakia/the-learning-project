// YUK-603 — 0063 scope_mode data-fix contract (v2 contract §5.3 migration).
//
// The migration's UPDATE statements are executed VERBATIM (read from the shipped .sql) against
// seeded legacy-shaped rows, so the predicate that ships is the predicate under test. The
// testcontainer already has 0063 applied (column + default), which is exactly the
// post-ADD-COLUMN / pre-UPDATE state legacy rows would be in mid-migration.
//
// Predicate (判据收紧防误伤): manual + subject + frozen empty-or-exactly-[seed:%:root] →
// subject_live + frozen cleared. Everything else (proposal-sourced, hand-picked non-root sets,
// subject-less manual) stays explicit with its scope intact.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { goal } from '@/db/schema';
import { resetDb, testDb } from '../helpers/db';

const db = testDb();

beforeEach(() => resetDb());

function loadDataFixStatements(): string[] {
  const dir = join(__dirname, '../../drizzle');
  const file = readdirSync(dir).find((f) => f.startsWith('0063_') && f.endsWith('.sql'));
  if (!file) throw new Error('0063 migration file not found in drizzle/');
  const text = readFileSync(join(dir, file), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) =>
      // strip SQL line comments so a comment-prefixed statement is still recognized
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.toUpperCase().startsWith('UPDATE'));
}

async function seedGoal(opts: {
  id: string;
  subject_id: string | null;
  scope: string[];
  source: string;
}): Promise<void> {
  const now = new Date();
  await db.insert(goal).values({
    id: opts.id,
    title: opts.id,
    subject_id: opts.subject_id,
    scope_knowledge_ids: opts.scope,
    sequence_hint: 0,
    status: 'active',
    source: opts.source,
    source_ref: null,
    created_at: now,
    updated_at: now,
    version: 0,
    // legacy rows predate the column → they sit at the ADD COLUMN default
    scope_mode: 'explicit',
  });
}

async function readGoal(id: string): Promise<{ scope_mode: string; scope: string[] }> {
  const [row] = await db.select().from(goal).where(eq(goal.id, id));
  return { scope_mode: row.scope_mode, scope: row.scope_knowledge_ids ?? [] };
}

describe('0063 scope_mode data-fix (存量 migration 判据)', () => {
  // @invariant data: the armed shape — manual + subject + frozen exactly the seed root — converts to subject_live with an empty scope
  // @fails-if the armed shape keeps its frozen root scope or stays manual
  it('converts the armed shape: manual + subject + frozen exactly [seed:*:root] → subject_live + []', async () => {
    await seedGoal({
      id: 'g-armed',
      subject_id: 'yuwen',
      scope: ['seed:yuwen:root'],
      source: 'manual',
    });
    for (const stmt of loadDataFixStatements()) await db.execute(sql.raw(stmt));
    expect(await readGoal('g-armed')).toEqual({ scope_mode: 'subject_live', scope: [] });
  });

  // @invariant data: the empty-frozen-scope shape converts to subject_live
  // @fails-if an empty frozen scope blocks conversion or converts a different shape
  it('converts the empty shape: manual + subject + frozen [] → subject_live (scope already [])', async () => {
    await seedGoal({ id: 'g-empty', subject_id: 'yuwen', scope: [], source: 'manual' });
    for (const stmt of loadDataFixStatements()) await db.execute(sql.raw(stmt));
    expect(await readGoal('g-empty')).toEqual({ scope_mode: 'subject_live', scope: [] });
  });

  // @invariant data: a hand-picked non-root scope stays explicit with its members intact
  // @fails-if the fix rewrites a non-root set to subject_live
  it('conservative: a manual hand-picked NON-root set stays explicit with its scope intact', async () => {
    await seedGoal({
      id: 'g-picked',
      subject_id: 'yuwen',
      scope: ['kc1', 'kc2'],
      source: 'manual',
    });
    for (const stmt of loadDataFixStatements()) await db.execute(sql.raw(stmt));
    expect(await readGoal('g-picked')).toEqual({ scope_mode: 'explicit', scope: ['kc1', 'kc2'] });
  });

  // @invariant data: a single-element non-root scope stays explicit — the length-1 branch converts root only
  // @fails-if any single-element scope converts regardless of membership
  it('conservative: a SINGLE-element non-root set stays explicit (length-1 branch is root-only)', async () => {
    await seedGoal({ id: 'g-single', subject_id: 'yuwen', scope: ['kc1'], source: 'manual' });
    for (const stmt of loadDataFixStatements()) await db.execute(sql.raw(stmt));
    expect(await readGoal('g-single')).toEqual({ scope_mode: 'explicit', scope: ['kc1'] });
  });

  // @invariant data: a multi-element scope containing the root stays explicit — only the single-element root shape converts
  // @fails-if a multi-element scope containing the root converts
  it('conservative: a multi-element set CONTAINING the root stays explicit (只收单元素 root)', async () => {
    await seedGoal({
      id: 'g-mixed',
      subject_id: 'yuwen',
      scope: ['seed:yuwen:root', 'kc1'],
      source: 'manual',
    });
    for (const stmt of loadDataFixStatements()) await db.execute(sql.raw(stmt));
    expect(await readGoal('g-mixed')).toEqual({
      scope_mode: 'explicit',
      scope: ['seed:yuwen:root', 'kc1'],
    });
  });

  // @invariant data: proposal-sourced goals keep their evidence-first frozen scope explicit
  // @fails-if a proposal-sourced goal is converted to subject_live
  it('proposal-sourced goals keep their evidence-first frozen scope (恒 explicit)', async () => {
    await seedGoal({
      id: 'g-prop',
      subject_id: 'yuwen',
      scope: ['kc1'],
      source: 'goal_scope_proposal',
    });
    for (const stmt of loadDataFixStatements()) await db.execute(sql.raw(stmt));
    expect(await readGoal('g-prop')).toEqual({ scope_mode: 'explicit', scope: ['kc1'] });
  });

  // @invariant data: subject-less manual goals stay explicit — there is nothing to live-derive from
  // @fails-if a subject-less goal converts to subject_live
  it('subject-less manual goals stay explicit (nothing to live-derive from)', async () => {
    await seedGoal({ id: 'g-nosubj', subject_id: null, scope: [], source: 'manual' });
    for (const stmt of loadDataFixStatements()) await db.execute(sql.raw(stmt));
    expect(await readGoal('g-nosubj')).toEqual({ scope_mode: 'explicit', scope: [] });
  });
});
