// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Source fixtures intentionally contain unevaluated template expressions.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countWriteHits } from './audit-schema-writes';
import { extractDatabaseGeneratedWrites, extractExecutedSqlWrites } from './schema-write-producers';

function hits(source: string, table: string, field: string) {
  return countWriteHits(table, field, new Map([['runtime.ts', extractExecutedSqlWrites(source)]]));
}

describe('executed raw SQL schema producers', () => {
  it('binds INSERT SELECT columns to the target, not the source or conflict target', () => {
    const source =
      "await tx.execute(sql`insert into deliveries (subscriber_id, status) select id, 'pending' from events on conflict (delivery_seq) do nothing returning id`);";
    expect(hits(source, 'deliveries', 'subscriber_id').insert_files).toBe(1);
    expect(hits(source, 'deliveries', 'status').insert_files).toBe(1);
    expect(hits(source, 'events', 'subscriber_id').insert_files).toBe(0);
    expect(hits(source, 'deliveries', 'delivery_seq').insert_files).toBe(0);
  });

  it('recognizes aliases, nested subqueries and multiple top-level SET assignments', () => {
    const source =
      "await tx.execute(sql`update deliveries d set status = case when attempt_count > 4 then 'dead' else 'retry' end, next_seq = (select max(seq) from other where hidden = 1), claim_owner = ${owner}, completed_at = clock_timestamp() where id = ${id} returning id`);";
    for (const field of ['status', 'next_seq', 'claim_owner', 'completed_at']) {
      expect(hits(source, 'deliveries', field).update_files).toBe(1);
    }
    for (const field of ['attempt_count', 'hidden', 'id']) {
      expect(hits(source, 'deliveries', field).update_files).toBe(0);
    }
  });

  it('counts a CTE insert without claiming its source columns as writes', () => {
    const source =
      "await db.execute(sql`with candidates as (select secret from events where status = 'ready') insert into deliveries (source_id, delivery_seq) select id, seq from candidates`);";
    expect(hits(source, 'deliveries', 'source_id').insert_files).toBe(1);
    expect(hits(source, 'events', 'status').update_files).toBe(0);
    expect(hits(source, 'deliveries', 'secret').insert_files).toBe(0);
  });

  it.each([
    '// await tx.execute(sql`update hidden set value = 1`);',
    'const documentation = "tx.execute(sql`update hidden set value = 1`)";',
    'const unused = sql`update hidden set value = 1`;',
    "await tx.execute(sql`select 'update hidden set value = 1'`);",
    'await tx.execute(sql`select $$update hidden set value = 1$$`);',
    'await tx.execute(sql`select $body$update hidden set value = 1$body$`);',
    'await tx.execute(sql`select "update hidden set value = 1" from other`);',
    'await tx.execute(sql`select 1 /* update hidden set value = 1 */`);',
    'await tx.execute(sql`select 1 -- update hidden set value = 1\n`);',
    'await tx.execute(sql`update ${table} set value = 1`);',
    'await tx.execute(sql`insert into hidden (${column}) values (1)`);',
  ])('does not turn non-writers or dynamic identifiers into evidence: %s', (source) => {
    expect(hits(source, 'hidden', 'value')).toEqual({ insert_files: 0, update_files: 0 });
  });

  it('detects real dispatcher producers and loses evidence when a column is removed', () => {
    const source = readFileSync('src/server/event-subscriptions/runtime.ts', 'utf8');
    expect(hits(source, 'event_subscription_delivery', 'attempt_count').update_files).toBe(1);
    expect(hits(source, 'event_subscription_checkpoint', 'claim_owner').update_files).toBe(1);
    expect(hits(source, 'event_subscription_checkpoint', 'paused_at')).toEqual({
      insert_files: 0,
      update_files: 0,
    });
    expect(
      hits(
        source.replaceAll('attempt_count', 'other_counter'),
        'event_subscription_delivery',
        'attempt_count',
      ),
    ).toEqual({ insert_files: 0, update_files: 0 });
  });
});

describe('database generated schema producers', () => {
  it('counts sequence and timestamp defaults, but not static placeholders or constraint references', () => {
    const source =
      "export const event = pgTable('event', { dispatch_seq: bigint('dispatch_seq').notNull().default(sql`nextval('event_dispatch_seq')`), discovered_at: timestamp('discovered_at').defaultNow(), enabled: boolean('enabled').default(false), pending: text('pending') }, t => [check('c', sql`${t.pending} is not null`)]);";
    const index = new Map([['schema.ts', extractDatabaseGeneratedWrites(source)]]);
    expect(countWriteHits('event', 'dispatch_seq', index).insert_files).toBe(1);
    expect(countWriteHits('event', 'discovered_at', index).insert_files).toBe(1);
    expect(countWriteHits('event', 'enabled', index).insert_files).toBe(0);
    expect(countWriteHits('event', 'pending', index).insert_files).toBe(0);
    expect(countWriteHits('other', 'dispatch_seq', index).insert_files).toBe(0);
  });

  it('checks the actual schema expression and fails when the sequence default disappears', () => {
    const source = readFileSync('src/db/schema.ts', 'utf8');
    const index = (text: string) => new Map([['schema.ts', extractDatabaseGeneratedWrites(text)]]);
    expect(countWriteHits('event', 'dispatch_seq', index(source)).insert_files).toBe(1);
    expect(
      countWriteHits(
        'event',
        'dispatch_seq',
        index(source.replace(".default(sql`nextval('event_dispatch_seq')`)", '')),
      ).insert_files,
    ).toBe(0);
  });
});
