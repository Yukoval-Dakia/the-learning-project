import { z } from 'zod';
import type { AdminRequestOutcome, TraitRequestOutcome } from '@/capabilities/observability/public';
import type { TraitControlReceipt } from '@/capabilities/observability/ui/admin-control-client';
import {
  type AdminControlClient,
  SubjectTraitsWireSchema,
} from '@/capabilities/observability/ui-public';
import type { Db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

// Parsing and wording belong to observability's admin-control-request; this shell only maps
// the flat Start input onto params/body and rethrows rejections as Responses.
const Fields = z.record(z.string(), z.unknown());
function fields(input: unknown): Record<string, unknown> {
  const parsed = Fields.safeParse(input);
  return parsed.success ? parsed.data : {};
}
type Outcome = { ok: true } | { ok: false; status: number; body: unknown };
function settled<O extends Outcome>(outcome: O): Extract<O, { ok: true }> {
  if (!outcome.ok) throw Response.json(outcome.body, { status: outcome.status });
  return outcome as Extract<O, { ok: true }>;
}
const readInput = (input: unknown) => async () => input;
const subjectRequest = (input: unknown) => ({
  params: { id: fields(input).subjectId },
  readBody: readInput(input),
});
const traitRequest = (input: unknown) => ({
  params: { id: fields(input).traitId },
  readBody: readInput(input),
});
const subjectTraitRequest = (input: unknown) => ({
  params: { id: fields(input).subjectId, kind: fields(input).kind },
  readBody: readInput(input),
});
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
    const controlReceipt = async <T>(outcome: Promise<AdminRequestOutcome<T>>) =>
      settled(await outcome).body;
    const traitReceipt = async (
      outcome: Promise<TraitRequestOutcome>,
    ): Promise<TraitControlReceipt> => {
      const { body, canonical } = settled(await outcome);
      return {
        ...body,
        status: canonical?.created ? 201 : 200,
        ...(canonical ? { canonicalLocation: canonical.location } : {}),
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
          const request = { params: { id: fields(input).subjectId } };
          const outcome = await withDb((db) => domain.requestAdminSubjectTraits(db, request));
          return SubjectTraitsWireSchema.parse(settled(outcome).body);
        }),
      getTraits: (input) =>
        boundary(async () => {
          const request = { query: { kind: fields(input).kind } };
          return settled(await withDb((db) => domain.requestAdminTraits(db, request))).body;
        }),
      getTraitJournal: (input) =>
        boundary(async () => {
          const request = { params: { id: fields(input).traitId }, query: fields(input) };
          return settled(await withDb((db) => domain.requestAdminTraitJournal(db, request))).body;
        }),
      renameSubject: (input) =>
        boundary(() =>
          controlReceipt(
            withDb((db) => domain.requestRenameAdminSubject(db, subjectRequest(input))),
          ),
        ),
      retireSubject: (input) =>
        boundary(() =>
          controlReceipt(
            withDb((db) => domain.requestRetireAdminSubject(db, subjectRequest(input))),
          ),
        ),
      restoreSubject: (input) =>
        boundary(() =>
          controlReceipt(
            withDb((db) => domain.requestRestoreAdminSubject(db, subjectRequest(input))),
          ),
        ),
      resetSubject: (input) =>
        boundary(() =>
          controlReceipt(
            withDb((db) => domain.requestResetAdminSubject(db, subjectRequest(input))),
          ),
        ),
      validateSubject: (input) =>
        boundary(async () => {
          const request = subjectRequest(input);
          return settled(await withDb((db) => domain.requestValidateAdminSubject(db, request)))
            .body;
        }),
      editSubjectTrait: (input) =>
        boundary(() =>
          traitReceipt(
            withDb((db) => domain.requestEditSubjectTrait(db, subjectTraitRequest(input))),
          ),
        ),
      forkSubjectTrait: (input) =>
        boundary(() =>
          traitReceipt(
            withDb((db) => domain.requestForkSubjectTrait(db, subjectTraitRequest(input))),
          ),
        ),
      rebindSubjectTrait: (input) =>
        boundary(() =>
          traitReceipt(
            withDb((db) => domain.requestRebindSubjectTrait(db, subjectTraitRequest(input))),
          ),
        ),
      editSharedTrait: (input) =>
        boundary(() =>
          traitReceipt(withDb((db) => domain.requestEditSharedTrait(db, traitRequest(input)))),
        ),
      rollbackTrait: (input) =>
        boundary(() =>
          traitReceipt(withDb((db) => domain.requestRollbackTrait(db, traitRequest(input)))),
        ),
      resetTraitToSeed: (input) =>
        boundary(() =>
          traitReceipt(withDb((db) => domain.requestResetTraitToSeed(db, traitRequest(input)))),
        ),
    } satisfies AdminControlClient;
  } catch (error) {
    throw error instanceof Response ? error : errorResponse(error);
  }
}
