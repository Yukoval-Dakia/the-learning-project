// YUK-384 — durable hub-sync reconciliation: claim + renewable lease.
//
// PostgreSQL is authoritative. Topology triggers (drizzle/0071) advance one
// durable `generation` per hub; workers claim EXACTLY one ready cursor at a time
// with `FOR UPDATE SKIP LOCKED` (never pre-leasing a batch tail) and hold a
// 2-minute lease renewed every 30 seconds by the cycle. Generations are
// PostgreSQL `bigint` and cross the TypeScript boundary as decimal strings,
// never JavaScript `number`.

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Db } from '@/db/client';

export interface HubSyncClaim {
  artifactId: string;
  generation: string;
  claimToken: string;
  claimOwner: string;
  leaseExpiresAt: Date;
}

/**
 * Claim the single most-eligible ready cursor for `owner`, or return null when
 * none is claimable. Eligible = a due `pending`/`retry_wait` row, or a
 * `claimed`/`applying` row whose lease has expired (reclaim). `FOR UPDATE SKIP
 * LOCKED` + `LIMIT 1` guarantees two workers never claim the same generation and
 * that no batch tail is pre-leased. Ordering `(next_attempt_at, last_dirty_at,
 * artifact_id)` drains fairly and deterministically.
 */
export async function claimNextHubSync(
  db: Db,
  input: { owner: string },
): Promise<HubSyncClaim | null> {
  const token = randomUUID();
  const rows = await db.execute<{
    artifact_id: string;
    generation: string;
    lease_expires_at: Date;
  }>(sql`
    with candidate as (
      select artifact_id
      from hub_sync_reconciliation
      where (
        status in ('pending', 'retry_wait') and next_attempt_at <= clock_timestamp()
      ) or (
        status in ('claimed', 'applying') and lease_expires_at < clock_timestamp()
      )
      order by next_attempt_at, last_dirty_at, artifact_id
      for update skip locked
      limit 1
    )
    update hub_sync_reconciliation r
    set status = 'claimed',
        claim_owner = ${input.owner},
        claim_token = ${token},
        lease_expires_at = clock_timestamp() + interval '2 minutes',
        last_claimed_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        claim_count = claim_count + 1
    from candidate
    where r.artifact_id = candidate.artifact_id
    returning r.artifact_id, r.generation::text as generation, r.lease_expires_at
  `);
  const row = rows[0];
  return row
    ? {
        artifactId: row.artifact_id,
        generation: row.generation,
        claimToken: token,
        claimOwner: input.owner,
        leaseExpiresAt: row.lease_expires_at,
      }
    : null;
}

/**
 * Extend the claim's lease by another 2 minutes, fencing on the exact
 * `artifact_id + generation + claim_token`, an active (`claimed`/`applying`)
 * status, and an unexpired lease measured by database time. Returns true iff
 * exactly one row matched; a false return means the claim was superseded, lost,
 * or expired, and the cycle must abort compute/finalize immediately.
 */
export async function renewHubSyncLease(db: Db, claim: HubSyncClaim): Promise<boolean> {
  const rows = await db.execute<{ artifact_id: string }>(sql`
    update hub_sync_reconciliation
    set lease_expires_at = clock_timestamp() + interval '2 minutes',
        updated_at = clock_timestamp()
    where artifact_id = ${claim.artifactId}
      and generation = ${claim.generation}::bigint
      and claim_token = ${claim.claimToken}
      and status in ('claimed', 'applying')
      and lease_expires_at >= clock_timestamp()
    returning artifact_id
  `);
  return rows.length === 1;
}
