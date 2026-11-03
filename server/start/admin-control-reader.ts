import { z } from 'zod';
import type {
  AdminSubjectControlResult,
  TraitWriteResult,
} from '@/capabilities/observability/public';
import type {
  SubjectControlReceipt,
  TraitControlReceipt,
} from '@/capabilities/observability/ui/admin-control-client';
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
    const controlReceipt = (result: AdminSubjectControlResult): SubjectControlReceipt => {
      const outcome = domain.controlWriteHttpOutcome(result);
      if (!outcome.ok) throw Response.json(outcome.body, { status: outcome.status });
      return outcome.body;
    };
    const traitReceipt = (result: TraitWriteResult, canonical = false): TraitControlReceipt => {
      const outcome = domain.traitWriteHttpOutcome(result);
      if (!outcome.ok) throw Response.json(outcome.body, { status: outcome.status });
      return {
        ...outcome.body,
        status: canonical && outcome.created ? 201 : 200,
        ...(canonical ? { canonicalLocation: outcome.location } : {}),
      };
    };
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
          const parsedLimit = domain.parseTraitJournalLimit(query.limit);
          if (!parsedLimit.ok)
            throw Response.json(parsedLimit.body, { status: parsedLimit.status });
          const { limit } = parsedLimit;
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
