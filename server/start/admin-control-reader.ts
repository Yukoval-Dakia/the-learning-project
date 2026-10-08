import { z } from 'zod';
import type {
  AdminSubjectControlResult,
  TraitWriteResult,
} from '@/capabilities/observability/public';
import type { TraitControlReceipt } from '@/capabilities/observability/ui/admin-control-client';
import {
  type AdminControlClient,
  SubjectTraitsWireSchema,
} from '@/capabilities/observability/ui-public';
import type { Db } from '@/db/client';
import { collectionPayload, errorResponse } from '@/kernel/http';

const Fields = z.record(z.string(), z.unknown());
function field(input: unknown, key: string): unknown {
  const parsed = Fields.safeParse(input);
  return parsed.success ? parsed.data[key] : undefined;
}
function reject(error: string, status: number, details: object = {}): never {
  throw Response.json({ error, ...details }, { status });
}
function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) reject(message, 400);
  return parsed.data;
}
function controlReceipt(result: AdminSubjectControlResult) {
  switch (result.kind) {
    case 'ok':
      return { subjectRevision: result.subjectRevision };
    case 'noop':
      return { subjectRevision: result.subjectRevision, noop: true as const };
    case 'stale':
      return reject('stale_revision', 409, {
        message: 'stale subject revision',
        currentRevision: result.currentRevision,
      });
    case 'conflict':
      return reject(result.message, 409);
    case 'not_found':
      return reject(result.message, 404);
    case 'forbidden':
    case 'invalid':
      return reject(result.message, 422);
  }
}
function traitReceipt(result: TraitWriteResult, canonical = false): TraitControlReceipt {
  switch (result.kind) {
    case 'ok':
    case 'noop':
      return {
        traitId: result.traitId,
        revision: result.revision,
        ...(result.kind === 'ok' ? { forked: result.forked } : { noop: true }),
        status: canonical && result.kind === 'ok' && result.forked ? 201 : 200,
        ...(canonical
          ? { canonicalLocation: `/api/admin/traits/${encodeURIComponent(result.traitId)}/journal` }
          : {}),
      };
    case 'stale':
      return reject('stale_revision', 409, {
        message: `stale ${result.axis} revision`,
        currentRevision: result.currentRevision,
      });
    case 'not_found':
      return reject(result.message, 404);
    case 'forbidden':
      return reject(result.message, 422);
    case 'invalid':
      return reject(result.message, 422, result.issues ? { issues: result.issues } : {});
  }
}

// The frontdoor calls this factory from its initialized Hono module graph, after
// auth. Start's compiled bundle must never construct its own domain graph here.
// Db is an owned pool, not Tx: the public mutations commit and hydrate themselves.
export async function createStartAdminControlReader(options: { database?: Db } = {}) {
  try {
    const domain = await import('@/capabilities/observability/public');
    async function boundary<T>(operation: () => Promise<T> | T): Promise<T> {
      try {
        return await operation();
      } catch (error) {
        throw error instanceof Response ? error : errorResponse(error);
      }
    }
    async function withDb<T>(operation: (database: Db) => Promise<T>): Promise<T> {
      return operation(options.database ?? (await import('@/db/client')).db);
    }
    const subjectId = (input: unknown) =>
      parse(
        domain.AdminSubjectControlParamsSchema,
        { id: field(input, 'subjectId') },
        'subject id is required',
      ).id;
    const traitId = (input: unknown) =>
      parse(
        domain.AdminTraitWriteParamsSchema,
        { id: field(input, 'traitId') },
        'trait id is required',
      ).id;
    const subjectTrait = (input: unknown) => {
      const params = parse(
        domain.AdminSubjectTraitParamsSchema,
        { id: field(input, 'subjectId'), kind: field(input, 'kind') },
        `subject id + trait kind (one of: ${domain.AdminSubjectTraitParamsSchema.shape.kind.options.join(', ')}) required`,
      );
      return { subjectId: params.id, kind: params.kind };
    };
    const cas = (input: unknown) => ({
      subjectId: subjectId(input),
      ...parse(domain.AdminSubjectCasBodySchema, input, 'expectedRevision required'),
    });
    return {
      getConfig: () =>
        boundary(() =>
          domain.AdminConfigResponseSchema.parse(
            domain.buildAdminConfigReadModel(process.env, domain.getAdminConfigRuntimeFacts()),
          ),
        ),
      patchConfig: (input) => boundary(() => domain.patchAdminConfig(input)),
      resetConfig: (input) => boundary(() => domain.resetAdminConfig(input)),
      getSubjects: () =>
        boundary(async () => ({ subjects: await withDb((db) => domain.listAdminSubjects(db)) })),
      getSubjectTraits: (input) =>
        boundary(async () => {
          const id = subjectId(input);
          const result = await withDb((db) => domain.getAdminSubjectTraits(db, id));
          if (result === null) reject(`unknown subject "${id}"`, 404);
          return SubjectTraitsWireSchema.parse(result);
        }),
      getTraits: (input) =>
        boundary(async () => {
          const kind = parse(
            domain.AdminSubjectTraitParamsSchema.shape.kind,
            field(input, 'kind'),
            `kind query is required (one of: ${domain.AdminSubjectTraitParamsSchema.shape.kind.options.join(', ')})`,
          );
          return { traits: await withDb((db) => domain.listAdminTraits(db, kind)) };
        }),
      getTraitJournal: (input) =>
        boundary(async () => {
          const id = traitId(input);
          const query = parse(
            z.object({ limit: z.string().optional(), cursor: z.string().optional() }),
            input,
            'invalid journal query',
          );
          const requested = query.limit === undefined ? 100 : Number(query.limit);
          if (!Number.isInteger(requested) || requested <= 0)
            reject('limit must be a positive integer', 400);
          const limit = Math.min(requested, 200);
          const page = await withDb((db) =>
            domain.getTraitJournalPage(db, id, { limit, cursor: query.cursor }),
          );
          if (page === null) reject(`unknown trait "${id}"`, 404);
          return collectionPayload(
            page.rows,
            { limit, next_cursor: page.next_cursor },
            { journal: page.rows, next_cursor: page.next_cursor },
          );
        }),
      renameSubject: (input) =>
        boundary(async () => {
          const id = subjectId(input);
          const body = parse(
            domain.RenameAdminSubjectBodySchema,
            input,
            'expectedRevision + displayName required',
          );
          return controlReceipt(
            await withDb((db) => domain.renameAdminSubject(db, { subjectId: id, ...body })),
          );
        }),
      retireSubject: (input) =>
        boundary(async () => {
          const args = cas(input);
          return controlReceipt(await withDb((db) => domain.retireAdminSubject(db, args)));
        }),
      restoreSubject: (input) =>
        boundary(async () => {
          const args = cas(input);
          return controlReceipt(await withDb((db) => domain.restoreAdminSubject(db, args)));
        }),
      resetSubject: (input) =>
        boundary(async () => {
          const args = cas(input);
          return controlReceipt(await withDb((db) => domain.resetAdminSubject(db, args)));
        }),
      validateSubject: (input) =>
        boundary(async () => {
          const id = subjectId(input);
          const body = parse(
            domain.ValidateAdminSubjectInputSchema,
            input,
            'traitPayloadOverrides must be keyed by trait kind',
          );
          const result = await withDb((db) =>
            domain.validateAdminSubject(db, { subjectId: id, ...body }),
          );
          if (result === null) reject(`unknown subject "${id}"`, 404);
          return result;
        }),
      editSubjectTrait: (input) =>
        boundary(async () => {
          const params = subjectTrait(input);
          const body = parse(
            domain.EditSubjectTraitInputSchema,
            input,
            'expectedSubjectRevision + expectedTraitRevision + payload required',
          );
          return traitReceipt(
            await withDb((db) => domain.editSubjectTrait(db, { ...params, ...body })),
            true,
          );
        }),
      forkSubjectTrait: (input) =>
        boundary(async () => {
          const params = subjectTrait(input);
          const body = parse(
            domain.ForkSubjectTraitBodySchema,
            input,
            'expectedSubjectRevision required',
          );
          return traitReceipt(
            await withDb((db) => domain.forkSubjectTrait(db, { ...params, ...body })),
            true,
          );
        }),
      rebindSubjectTrait: (input) =>
        boundary(async () => {
          const params = subjectTrait(input);
          const body = parse(
            domain.RebindSubjectTraitBodySchema,
            input,
            'targetTraitId + expectedSubjectRevision required',
          );
          return traitReceipt(
            await withDb((db) => domain.rebindSubjectTrait(db, { ...params, ...body })),
          );
        }),
      editSharedTrait: (input) =>
        boundary(async () => {
          const id = traitId(input);
          const body = parse(
            domain.EditSharedTraitInputSchema,
            input,
            'expectedRevision + payload required',
          );
          return traitReceipt(
            await withDb((db) => domain.editSharedTrait(db, { traitId: id, ...body })),
          );
        }),
      rollbackTrait: (input) =>
        boundary(async () => {
          const id = traitId(input);
          const body = parse(
            domain.RollbackAdminTraitBodySchema,
            input,
            'expectedRevision + targetRevision required',
          );
          return traitReceipt(
            await withDb((db) => domain.rollbackTrait(db, { traitId: id, ...body })),
          );
        }),
      resetTraitToSeed: (input) =>
        boundary(async () => {
          const id = traitId(input);
          const body = parse(domain.ResetAdminTraitBodySchema, input, 'expectedRevision required');
          return traitReceipt(
            await withDb((db) => domain.resetTraitToSeed(db, { traitId: id, ...body })),
          );
        }),
    } satisfies AdminControlClient;
  } catch (error) {
    throw error instanceof Response ? error : errorResponse(error);
  }
}
