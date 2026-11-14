// One durable probe per paused route; successful authentication wakes existing waits.
import { sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import {
  lockPaidEffectControlFamily,
  readPaidEffectControl,
} from '@/core/paid-work/server/paid-effect-control';
import { QUESTION_ADMISSION_CONTRACT_VERSION } from '@/core/question-admission-policy';
import type { Db, Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { getStartedBoss } from '@/server/boss/client';
import { ADMISSION_FAMILY, admissionJobId } from './enqueue';
import { FrozenAdmissionInput } from './receipt';
import { readRouteLoginWait, stagePolicySql } from './stages';

export async function maintainAdmissionLoginRecovery(
  db: Db,
  route: { provider: string; model: string },
  deliveryId: string,
  skipGroupId?: string,
) {
  const boss = await getStartedBoss();
  await db.transaction((tx) =>
    enqueueAdmissionLoginRecovery(tx, boss, route, deliveryId, skipGroupId),
  );
}

export async function enqueueAdmissionLoginRecovery(
  tx: Tx,
  boss: Awaited<ReturnType<typeof getStartedBoss>>,
  route: { provider: string; model: string },
  deliveryId: string,
  skipGroupId?: string,
) {
  await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
  const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
  if (control.backend !== 'pg-boss') return;
  const paused = await readRouteLoginWait(tx, { task: route });
  if (paused) {
    const [queued] = await tx.execute(sql`
        SELECT id FROM pgboss.job WHERE name = ${ADMISSION_FAMILY}
          AND state IN ('created', 'retry', 'active') AND id::text <> ${deliveryId}
          AND data->'login_probe_route'->>'provider' = ${route.provider}
          AND data->'login_probe_route'->>'model' = ${route.model} LIMIT 1
      `);
    if (queued) return;
  }
  const waiting = await tx.execute<{
    group_id: string;
    input: unknown;
    stage_digest: string;
  }>(sql`
      WITH latest AS (
        SELECT DISTINCT ON (entity_id, entity_revision, ${stagePolicySql}, input_json->>'call_index')
          entity_id, entity_revision, state, input_json, input_digest, result_json
        FROM paid_effect WHERE family = 'question_admission_stage'
        ORDER BY entity_id, entity_revision, ${stagePolicySql}, input_json->>'call_index', (input_json->>'attempt')::int DESC
      ) SELECT c.entity_id AS group_id, c.input_json AS input, s.input_digest AS stage_digest
      FROM latest s JOIN paid_effect c
        ON c.family = ${ADMISSION_FAMILY} AND c.entity_id = s.entity_id
        AND c.entity_revision = s.entity_revision AND c.state = 'receipt_ready'
        AND c.result_json->'result'->>'status' = 'waiting'
      JOIN question_group_lifecycle l ON l.group_id = c.entity_id
      JOIN question_revision r ON r.revision_id = l.current_revision_id
      WHERE s.state IN ('receipt_ready', 'applied') AND s.result_json->>'kind' = 'waiting'
        AND s.result_json->'recovery'->>'reason' = 'login'
        AND s.input_json->'configuration'->'task'->>'provider' = ${route.provider}
        AND s.input_json->'configuration'->'task'->>'model' = ${route.model}
        AND r.integrity_digest = c.entity_revision
        AND l.current_revision_id = c.input_json->>'revision_id'
        AND (${skipGroupId ?? null}::text IS NULL OR c.entity_id <> ${skipGroupId ?? null})
      ORDER BY c.created_at, c.entity_id
    `);
  for (const row of paused ? waiting.slice(0, 1) : waiting) {
    const input = FrozenAdmissionInput.parse(row.input);
    const retryAt = paused
      ? new Date(paused.recovery.retry_at ?? paused.recordedAt.getTime() + 60 * 60_000)
      : null;
    await boss.send(
      ADMISSION_FAMILY,
      {
        admission_version: QUESTION_ADMISSION_CONTRACT_VERSION,
        question_id: row.group_id,
        ...(input.revision_id ? { revision_id: input.revision_id } : {}),
        ...(input.revision_digest ? { expected_revision_digest: input.revision_digest } : {}),
        expected_admission_generation: input.admission_generation,
        dispatch_generation: control.generation,
        recovery_confirmed: false,
        ...(paused ? { login_probe_route: route } : {}),
      },
      {
        id: admissionJobId(
          row.group_id,
          input.revision_id ?? row.group_id,
          canonicalHash({
            route,
            stage: row.stage_digest,
            phase: paused ? 'probe' : 'resume',
            clock: paused?.recordedAt.toISOString() ?? null,
          }),
          input.admission_generation,
        ),
        ...(retryAt ? { startAfter: retryAt } : {}),
        db: fromPgBossDrizzleTx(tx),
      },
    );
  }
}
