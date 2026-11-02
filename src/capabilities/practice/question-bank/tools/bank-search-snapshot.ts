import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import { bank_search_snapshot, item_calibration, question, source_asset } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import { readBankServableParts, resolveBankRefs } from './bank-ref';
import {
  BANK_SEMANTIC_POLICY,
  BankSearchV2Error,
  type BankSearchV2New,
  type BankSearchV2Output,
  BankSearchV2OutputSchema,
} from './bank-requirements';
import { bankGapEvidenceSigningSecret } from './bank-search';
import { resolveBankSearchScope } from './bank-search-scope';
import { bankReadRoleForActor } from './read-bank';

const TTL = 15 * 60_000;
const BindingSchema = z
  .object({ question_id: z.string(), ref: z.string().nullable(), state_digest: z.string() })
  .strict();
export type BankSnapshotBinding = z.infer<typeof BindingSchema>;
const PayloadSchema = z
  .object({
    output: BankSearchV2OutputSchema,
    bindings: z.array(BindingSchema),
    scope_digest: z.string(),
  })
  .strict();
const CursorSchema = z
  .object({
    v: z.literal('bank-search-semantic-2'),
    search_id: z.uuid(),
    actor: z.string(),
    role: z.string(),
    request_digest: z.string().regex(/^[a-f0-9]{64}$/),
    result_digest: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative(),
    expires: z.number().int().positive(),
  })
  .strict();
function actorKey(ctx: ToolContext): string {
  return `${ctx.callerActor.kind}:${ctx.callerActor.ref}`;
}
export function requireBankSnapshotSigningKey(): string {
  const secret = bankGapEvidenceSigningSecret();
  if (!secret)
    throw new BankSearchV2Error(
      'snapshot_signing_unavailable',
      'Server-only bank evidence signing key is unavailable; no semantic task was started.',
    );
  return secret;
}
function sign(body: string, key: string): string {
  return createHmac('sha256', key).update(`bank-search-semantic-cursor:v2:${body}`).digest('hex');
}
function cursorFor(
  ctx: ToolContext,
  output: BankSearchV2Output,
  offset: number,
  key: string,
): string {
  const body = Buffer.from(
    JSON.stringify({
      v: 'bank-search-semantic-2',
      search_id: output.search_id,
      actor: actorKey(ctx),
      role: bankReadRoleForActor(ctx.callerActor),
      request_digest: output.request_digest,
      result_digest: output.result_digest,
      offset,
      expires: Date.parse(output.expires_at),
    }),
    'utf8',
  ).toString('base64url');
  return `${body}.${sign(body, key)}`;
}
function page(
  ctx: ToolContext,
  output: BankSearchV2Output,
  offset: number,
  key: string,
): BankSearchV2Output {
  const size = output.page.page_size;
  const hits = output.hits.slice(offset, offset + size);
  const hasMore = offset + hits.length < output.hits.length;
  return {
    ...output,
    hits,
    page: {
      page_size: size,
      offset,
      has_more: hasMore,
      next_cursor: hasMore ? cursorFor(ctx, output, offset + size, key) : null,
    },
  };
}

/** Current visibility/lifecycle/real-serving state is independent of model
 * claims. Include asset identity so removing a necessary image expires a page. */
export async function captureBankSnapshotBindings(
  db: Db | Tx,
  identities: Array<{ question_id: string; ref: string | null }>,
  actor: ToolContext['callerActor'],
  calibrated = false,
): Promise<BankSnapshotBinding[]> {
  if (!identities.length) return [];
  const ids = [...new Set(identities.map((h) => h.question_id))];
  const roots = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      choices_md: question.choices_md,
      kind: question.kind,
      knowledge_ids: question.knowledge_ids,
      source: question.source,
      difficulty: question.difficulty,
      draft_status: question.draft_status,
      archived: sql<boolean>`(${question.metadata} -> 'archived_at') IS NOT NULL`,
      dismissed: sql<boolean>`(${question.metadata} -> 'dismissed_at') IS NOT NULL`,
    })
    .from(question)
    .where(inArray(question.id, ids));
  const rootsById = new Map(roots.map((r) => [r.id, r]));
  const resolutions = await resolveBankRefs(
    db,
    identities.flatMap((h) => (h.ref ? [h.ref] : [])),
  );
  const refs = new Map(resolutions.map((r) => [r.raw, r]));
  const servable = await readBankServableParts(db, ids);
  const calibrations = calibrated
    ? await db
        .select({
          question_id: item_calibration.question_id,
          b: item_calibration.b,
          b_post: item_calibration.b_post,
          b_anchor: item_calibration.b_anchor,
        })
        .from(item_calibration)
        .where(and(inArray(item_calibration.question_id, ids), eq(item_calibration.track, 'hard')))
    : [];
  const role = bankReadRoleForActor(actor);
  const materials = resolutions.flatMap((r) =>
    r.status === 'ok'
      ? r.revision.structure.materials.filter(
          (m) => role !== 'restricted' || m.visibility !== 'private',
        )
      : [],
  );
  const assetIds = [
    ...new Set(materials.filter((m) => m.content_md == null).map((m) => m.asset.asset_id)),
  ];
  const assets = assetIds.length
    ? await db
        .select({ id: source_asset.id, sha256: source_asset.sha256 })
        .from(source_asset)
        .where(inArray(source_asset.id, assetIds))
    : [];
  const assetById = new Map(assets.map((a) => [a.id, a.sha256]));
  return identities.map((identity) => {
    const ref = identity.ref ? refs.get(identity.ref) : undefined;
    const revision = ref?.status === 'ok' ? ref.revision : undefined;
    const dependencies =
      revision?.structure.materials
        .filter((m) => role !== 'restricted' || m.visibility !== 'private')
        .map((m) => ({
          material_id: m.material_id,
          expected: m.asset.digest,
          observed:
            m.content_md == null ? (assetById.get(m.asset.asset_id) ?? null) : m.asset.digest,
        })) ?? [];
    return {
      ...identity,
      state_digest: canonicalHash({
        root: rootsById.get(identity.question_id) ?? null,
        calibration: calibrations
          .filter((row) => row.question_id === identity.question_id)
          .sort((a, b) => a.question_id.localeCompare(b.question_id)),
        resolution: ref?.status ?? (identity.ref ? 'unresolvable' : 'draft'),
        revision_id: revision?.revision_id ?? null,
        digest: revision?.integrity_digest ?? null,
        lifecycle: ref?.status === 'ok' ? ref.lifecycle : null,
        servable_parts: [...(servable.get(identity.question_id) ?? [])].sort(),
        dependencies,
      }),
    };
  });
}
export async function bankSnapshotScopeDigest(
  db: Db | Tx,
  input: BankSearchV2New,
): Promise<string> {
  try {
    return canonicalHash(
      await resolveBankSearchScope(db, {
        ...input.scope,
        draft_state: input.scope?.draft_state ?? (input.use === 'practice' ? 'active' : 'all'),
        admission_state:
          input.use === 'practice' ? 'admitted' : (input.scope?.admission_state ?? 'any'),
      }),
    );
  } catch {
    throw new BankSearchV2Error(
      'snapshot_stale',
      'The original hard scope or its authorized references changed; start a new search.',
    );
  }
}

async function validateBindings(
  db: Db | Tx,
  bindings: BankSnapshotBinding[],
  ctx: ToolContext,
  input: BankSearchV2New,
): Promise<void> {
  const current = await captureBankSnapshotBindings(
    db,
    bindings.map(({ question_id, ref }) => ({ question_id, ref })),
    ctx.callerActor,
    input.scope?.difficulty?.basis === 'calibrated',
  );
  if (canonicalHash(current) !== canonicalHash(bindings))
    throw new BankSearchV2Error(
      'snapshot_stale',
      'A candidate/anchor revision, visibility, lifecycle, content or serving state changed; start a new search.',
    );
}
export async function storeBankSearchSnapshot(
  ctx: ToolContext,
  output: BankSearchV2Output,
  bindings: BankSnapshotBinding[],
  scopeDigest: string,
): Promise<BankSearchV2Output> {
  const key = requireBankSnapshotSigningKey();
  output.result_digest = canonicalHash({ ...output, result_digest: '' });
  const payload = PayloadSchema.parse({ output, bindings, scope_digest: scopeDigest });
  await ctx.db.transaction(
    async (tx) => {
      await validateBindings(tx, bindings, ctx, output.original_request);
      if ((await bankSnapshotScopeDigest(tx, output.original_request)) !== scopeDigest)
        throw new BankSearchV2Error(
          'snapshot_stale',
          'Hard scope changed during verification; start a new search.',
        );
      await tx.insert(bank_search_snapshot).values({
        search_id: output.search_id,
        actor_key: actorKey(ctx),
        read_role: bankReadRoleForActor(ctx.callerActor),
        request_digest: output.request_digest,
        result_digest: output.result_digest,
        payload,
        as_of: new Date(output.as_of),
        expires_at: new Date(output.expires_at),
      });
    },
    { isolationLevel: 'repeatable read' },
  );
  return page(ctx, output, 0, key);
}
export async function resumeBankSearchSnapshot(
  ctx: ToolContext,
  raw: string,
): Promise<BankSearchV2Output> {
  const key = requireBankSnapshotSigningKey();
  let cursor: z.infer<typeof CursorSchema>;
  try {
    if (raw.length > 6000) throw new Error('oversized');
    const [body, mac, extra] = raw.split('.');
    if (!body || !mac || extra || !/^[a-f0-9]{64}$/.test(mac)) throw new Error('shape');
    const expected = Buffer.from(sign(body, key), 'hex');
    const actual = Buffer.from(mac, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error('signature');
    cursor = CursorSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    throw new BankSearchV2Error(
      'denied',
      'Invalid or tampered semantic cursor; start a new search.',
    );
  }
  if (cursor.actor !== actorKey(ctx) || cursor.role !== bankReadRoleForActor(ctx.callerActor))
    throw new BankSearchV2Error('denied', 'Cursor belongs to a different actor or read role.');
  if (cursor.expires <= Date.now())
    throw new BankSearchV2Error('snapshot_stale', 'Semantic cursor expired; start a new search.');
  return ctx.db.transaction(
    async (tx) => {
      const [row] = await tx
        .select()
        .from(bank_search_snapshot)
        .where(eq(bank_search_snapshot.search_id, cursor.search_id))
        .limit(1);
      if (!row || row.expires_at.getTime() <= Date.now())
        throw new BankSearchV2Error(
          'snapshot_stale',
          'Semantic snapshot is expired, cleared or unavailable.',
        );
      if (
        row.actor_key !== cursor.actor ||
        row.read_role !== cursor.role ||
        row.request_digest !== cursor.request_digest ||
        row.result_digest !== cursor.result_digest ||
        row.expires_at.getTime() !== cursor.expires
      )
        throw new BankSearchV2Error('denied', 'Cursor does not bind this snapshot/request/result.');
      const parsed = PayloadSchema.safeParse(row.payload);
      if (!parsed.success)
        throw new BankSearchV2Error('snapshot_unavailable', 'Stored semantic snapshot is invalid.');
      const { output, bindings, scope_digest } = parsed.data;
      if (output.policy_version !== BANK_SEMANTIC_POLICY)
        throw new BankSearchV2Error(
          'snapshot_stale',
          'Verification policy changed; start a new search.',
        );
      if (
        canonicalHash({ ...output, result_digest: '' }) !== row.result_digest ||
        output.request_digest !== row.request_digest ||
        output.search_id !== row.search_id ||
        cursor.offset >= output.hits.length ||
        cursor.offset % output.page.page_size !== 0
      )
        throw new BankSearchV2Error(
          'snapshot_unavailable',
          'Stored snapshot integrity or page offset is invalid.',
        );
      await validateBindings(tx, bindings, ctx, output.original_request);
      if ((await bankSnapshotScopeDigest(tx, output.original_request)) !== scope_digest)
        throw new BankSearchV2Error(
          'snapshot_stale',
          'Hard scope changed after search; start a new search.',
        );
      return page(ctx, output, cursor.offset, key);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Opportunistic bounded expiry; not a new scheduler or background service. */
export async function pruneBankSearchSnapshots(db: Db): Promise<void> {
  await db.execute(
    sql`DELETE FROM ${bank_search_snapshot} WHERE search_id IN (SELECT search_id FROM ${bank_search_snapshot} WHERE expires_at <= now() ORDER BY expires_at LIMIT 100)`,
  );
}
export function bankSnapshotExpiry(now: number): string {
  return new Date(now + TTL).toISOString();
}
