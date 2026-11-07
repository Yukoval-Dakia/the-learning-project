import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// One owner holds one workspace slot. `id` is the sandbox directory name on the
// executor volume; the lease triple (execution_token/runtime) fences a live
// claim so a delete never removes a directory underneath a running process.
// Tombstone states are durable before the filesystem delete; retired/deleted
// rows free the owner slot for a fresh generation.
export const agent_workspace = pgTable(
  'agent_workspace',
  {
    id: text('id').primaryKey(),
    owner_kind: text('owner_kind').$type<'conversation' | 'task'>().notNull(),
    owner_id: text('owner_id').notNull(),
    state: text('state')
      .$type<'active' | 'revoking' | 'tombstoned' | 'deleted' | 'retired'>()
      .notNull()
      .default('active'),
    volume_id: text('volume_id').notNull(),
    generation: integer('generation').notNull().default(1),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    execution_token: text('execution_token'),
    execution_runtime: text('execution_runtime'),
    // Fencing lease renewed by the holder's heartbeat probe; expiry is the
    // reclaim proof that survives hostname/container reincarnation.
    execution_lease_until: timestamp('execution_lease_until', { withTimezone: true }),
    delete_reason: text('delete_reason').$type<'expired' | 'deleted' | 'completed'>(),
    tombstoned_at: timestamp('tombstoned_at', { withTimezone: true }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
    last_error: text('last_error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_workspace_current_owner')
      .on(t.owner_kind, t.owner_id)
      .where(sql`${t.state} IN ('active','revoking','tombstoned')`),
    index('agent_workspace_cleanup').on(t.state, t.last_activity_at),
  ],
);
