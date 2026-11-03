// Admin subject/trait control requests: the one owner of input parsing, 400/404 wording
// and the result → status decision, shared by the Hono routes and the Start front door.
// Transports only supply raw params/query and a body reader, then render the outcome.

import { z } from 'zod';
import type { Db } from '@/db/client';
import { collectionPayload } from '@/kernel/http';
import {
  type AdminWriteHttpOutcome,
  type SubjectControlReceiptBody,
  type TraitReceiptBody,
  type TraitWriteCanonical,
  controlWriteHttpOutcome,
  parseTraitJournalLimit,
  traitWriteHttpOutcome,
} from '../api/subjects-write-http';
import { getAdminSubjectTraits, getTraitJournalPage, listAdminTraits } from './subject-admin-read';
import {
  AdminSubjectCasBodySchema,
  type AdminSubjectCasInput,
  AdminSubjectControlParamsSchema,
  type AdminSubjectControlResult,
  RenameAdminSubjectBodySchema,
  ValidateAdminSubjectInputSchema,
  renameAdminSubject,
  resetAdminSubject,
  restoreAdminSubject,
  retireAdminSubject,
  validateAdminSubject,
} from './subject-control-operations';
import {
  AdminSubjectTraitParamsSchema,
  AdminTraitWriteParamsSchema,
  EditSharedTraitInputSchema,
  EditSubjectTraitInputSchema,
  ForkSubjectTraitBodySchema,
  RebindSubjectTraitBodySchema,
  ResetAdminTraitBodySchema,
  RollbackAdminTraitBodySchema,
  editSharedTrait,
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
  resetTraitToSeed,
  rollbackTrait,
} from './trait-control-operations';

export type AdminControlReadRequest = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
};
/** `readBody` throws on malformed JSON; it may resolve undefined for an empty body. */
export type AdminControlWriteRequest = {
  params: Record<string, unknown>;
  readBody: () => Promise<unknown>;
};
type RequestRejected = { ok: false; status: 400 | 404; body: { error: string } };
export type AdminRequestOutcome<T, Success extends object = Record<never, never>> =
  | AdminWriteHttpOutcome<T, Success>
  | RequestRejected;
/** Only the subject-scoped edit/fork writes answer as a canonical resource (201 + Location). */
export type TraitRequestOutcome = AdminRequestOutcome<
  TraitReceiptBody,
  { canonical?: TraitWriteCanonical }
>;

class Rejection {
  constructor(
    readonly status: 400 | 404,
    readonly error: string,
  ) {}
}
function reject(status: 400 | 404, error: string): never {
  throw new Rejection(status, error);
}
function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) reject(400, message);
  return parsed.data;
}
async function settle<O>(work: () => Promise<O>): Promise<O | RequestRejected> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Rejection) {
      return { ok: false, status: error.status, body: { error: error.error } };
    }
    throw error;
  }
}
async function readBody(request: AdminControlWriteRequest): Promise<unknown> {
  try {
    return await request.readBody();
  } catch {
    reject(400, 'request body must be valid JSON');
  }
}

const TRAIT_KINDS = AdminSubjectTraitParamsSchema.shape.kind;
const subjectId = (params: AdminControlReadRequest['params']) =>
  parse(AdminSubjectControlParamsSchema, { id: params?.id }, 'subject id is required').id;
const traitId = (params: AdminControlReadRequest['params']) =>
  parse(AdminTraitWriteParamsSchema, { id: params?.id }, 'trait id is required').id;
function subjectTrait(params: AdminControlWriteRequest['params']) {
  const parsed = parse(
    AdminSubjectTraitParamsSchema,
    { id: params.id, kind: params.kind },
    `subject id + trait kind (one of: ${TRAIT_KINDS.options.join(', ')}) required`,
  );
  return { subjectId: parsed.id, kind: parsed.kind };
}

export function requestAdminSubjectTraits(db: Db, request: AdminControlReadRequest) {
  return settle(async () => {
    const id = subjectId(request.params);
    const result = await getAdminSubjectTraits(db, id);
    if (result === null) reject(404, `unknown subject "${id}"`);
    return { ok: true as const, body: result };
  });
}

export function requestAdminTraits(db: Db, request: AdminControlReadRequest) {
  return settle(async () => {
    const kind = parse(
      TRAIT_KINDS,
      request.query?.kind,
      `kind query is required (one of: ${TRAIT_KINDS.options.join(', ')})`,
    );
    return { ok: true as const, body: { traits: await listAdminTraits(db, kind) } };
  });
}

const TraitJournalQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export function requestAdminTraitJournal(db: Db, request: AdminControlReadRequest) {
  return settle(async () => {
    const id = traitId(request.params);
    const query = parse(TraitJournalQuerySchema, request.query ?? {}, 'invalid journal query');
    const parsedLimit = parseTraitJournalLimit(query.limit);
    if (!parsedLimit.ok) return parsedLimit;
    const { limit } = parsedLimit;
    const page = await getTraitJournalPage(db, id, { limit, cursor: query.cursor });
    if (page === null) reject(404, `unknown trait "${id}"`);
    return {
      ok: true as const,
      body: collectionPayload(
        page.rows,
        { limit, next_cursor: page.next_cursor },
        { journal: page.rows, next_cursor: page.next_cursor },
      ),
    };
  });
}

type SubjectControlOutcome = AdminRequestOutcome<SubjectControlReceiptBody>;

export function requestRenameAdminSubject(
  db: Db,
  request: AdminControlWriteRequest,
): Promise<SubjectControlOutcome> {
  return settle(async () => {
    const id = subjectId(request.params);
    const body = parse(
      RenameAdminSubjectBodySchema,
      await readBody(request),
      'expectedRevision + displayName required',
    );
    return controlWriteHttpOutcome(await renameAdminSubject(db, { subjectId: id, ...body }));
  });
}

function subjectCasRequest(
  write: (db: Db, args: AdminSubjectCasInput) => Promise<AdminSubjectControlResult>,
) {
  return (db: Db, request: AdminControlWriteRequest): Promise<SubjectControlOutcome> =>
    settle(async () => {
      const id = subjectId(request.params);
      const body = parse(
        AdminSubjectCasBodySchema,
        await readBody(request),
        'expectedRevision required',
      );
      return controlWriteHttpOutcome(await write(db, { subjectId: id, ...body }));
    });
}
export const requestRetireAdminSubject = subjectCasRequest(retireAdminSubject);
export const requestRestoreAdminSubject = subjectCasRequest(restoreAdminSubject);
export const requestResetAdminSubject = subjectCasRequest(resetAdminSubject);

/** An absent body is a pure check; a present one must key overrides by trait kind. */
export function requestValidateAdminSubject(db: Db, request: AdminControlWriteRequest) {
  return settle(async () => {
    const id = subjectId(request.params);
    const raw = await readBody(request);
    const body =
      raw === undefined
        ? {}
        : parse(
            ValidateAdminSubjectInputSchema,
            raw,
            'traitPayloadOverrides must be keyed by trait kind',
          );
    const result = await validateAdminSubject(db, { subjectId: id, ...body });
    if (result === null) reject(404, `unknown subject "${id}"`);
    return { ok: true as const, body: result };
  });
}

function traitOutcome(
  result: Parameters<typeof traitWriteHttpOutcome>[0],
  canonical: boolean,
): TraitRequestOutcome {
  const outcome = traitWriteHttpOutcome(result);
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    body: outcome.body,
    ...(canonical ? { canonical: { created: outcome.created, location: outcome.location } } : {}),
  };
}

export function requestEditSubjectTrait(
  db: Db,
  request: AdminControlWriteRequest,
): Promise<TraitRequestOutcome> {
  return settle(async () => {
    const params = subjectTrait(request.params);
    const body = parse(
      EditSubjectTraitInputSchema,
      await readBody(request),
      'expectedSubjectRevision + expectedTraitRevision + payload required',
    );
    return traitOutcome(await editSubjectTrait(db, { ...params, ...body }), true);
  });
}

export function requestForkSubjectTrait(
  db: Db,
  request: AdminControlWriteRequest,
): Promise<TraitRequestOutcome> {
  return settle(async () => {
    const params = subjectTrait(request.params);
    const body = parse(
      ForkSubjectTraitBodySchema,
      await readBody(request),
      'expectedSubjectRevision required',
    );
    return traitOutcome(await forkSubjectTrait(db, { ...params, ...body }), true);
  });
}

export function requestRebindSubjectTrait(
  db: Db,
  request: AdminControlWriteRequest,
): Promise<TraitRequestOutcome> {
  return settle(async () => {
    const params = subjectTrait(request.params);
    const body = parse(
      RebindSubjectTraitBodySchema,
      await readBody(request),
      'targetTraitId + expectedSubjectRevision required',
    );
    return traitOutcome(await rebindSubjectTrait(db, { ...params, ...body }), false);
  });
}

export function requestEditSharedTrait(
  db: Db,
  request: AdminControlWriteRequest,
): Promise<TraitRequestOutcome> {
  return settle(async () => {
    const id = traitId(request.params);
    const body = parse(
      EditSharedTraitInputSchema,
      await readBody(request),
      'expectedRevision + payload required',
    );
    return traitOutcome(await editSharedTrait(db, { traitId: id, ...body }), false);
  });
}

export function requestRollbackTrait(
  db: Db,
  request: AdminControlWriteRequest,
): Promise<TraitRequestOutcome> {
  return settle(async () => {
    const id = traitId(request.params);
    const body = parse(
      RollbackAdminTraitBodySchema,
      await readBody(request),
      'expectedRevision + targetRevision required',
    );
    return traitOutcome(await rollbackTrait(db, { traitId: id, ...body }), false);
  });
}

export function requestResetTraitToSeed(
  db: Db,
  request: AdminControlWriteRequest,
): Promise<TraitRequestOutcome> {
  return settle(async () => {
    const id = traitId(request.params);
    const body = parse(
      ResetAdminTraitBodySchema,
      await readBody(request),
      'expectedRevision required',
    );
    return traitOutcome(await resetTraitToSeed(db, { traitId: id, ...body }), false);
  });
}
