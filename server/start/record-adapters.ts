// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';

export const createStartIngestionSession = ({ body, key }: { body: string; key: string | null }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = null;
      }
      const { CreateIngestionSessionBody, createIngestionSession } = await import(
        '@/capabilities/ingestion/public'
      );
      const parsed = CreateIngestionSessionBody.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError(
          'validation_error',
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
          400,
        );
      }
      const { db } = await import('@/db/client');
      const result = await createIngestionSession(db, parsed.data, key);
      if (result.status === 500) {
        throw Response.json(result.body, {
          status: result.status,
          headers: {
            Location: result.location,
            ...(result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
          },
        });
      }
      if (!('session' in result.body)) throw new Error('Unexpected ingestion creation result');
      return { ...result, body: result.body };
    } catch (error) {
      throw error instanceof Response ? error : errorResponse(error);
    }
  });

export const createStartIngestionOperation = ({
  sessionId,
  body,
  key,
}: {
  sessionId: string;
  body: string;
  key: string | null;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestIngestionOperation } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await requestIngestionOperation(
        db,
        { id: sessionId },
        async () => JSON.parse(body),
        key,
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const answerStartRecordAsk = ({
  sessionId,
  askId,
  body,
  key,
}: {
  sessionId: string;
  askId: string;
  body: string;
  key: string | null;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { answerIngestionAsk } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await answerIngestionAsk(db, { id: sessionId, ask_id: askId }, key, async () =>
        JSON.parse(body),
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const changeStartRecordPurpose = ({
  sessionId,
  body,
}: {
  sessionId: string;
  body: string;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestPurposeChange } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await requestPurposeChange(db, { id: sessionId }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartRecordPurposeImpact = ({
  sessionId,
  query,
}: {
  sessionId: string;
  query: string;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestPurposeImpact } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await requestPurposeImpact(
        db,
        { id: sessionId },
        Object.fromEntries(new URLSearchParams(query)),
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartRecordBlocks = (id: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessionBlocks } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readIngestionSessionBlocks(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const createStartRecordManualMistake = ({
  body,
  key,
}: {
  body: string;
  key: string | null;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = null;
      }
      const { CreateMistakeBodySchema, createManualMistake } = await import(
        '@/capabilities/ingestion/public'
      );
      const parsed = CreateMistakeBodySchema.safeParse(raw);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new ApiError('validation_error', message, 400);
      }
      const { db } = await import('@/db/client');
      const result = await createManualMistake(db, parsed.data, key);
      if (result.status !== 201 || !('mistake_id' in result.body)) {
        throw new Error('Unexpected manual mistake creation result');
      }
      return { ...result, body: result.body };
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const revertStartRecordBlock = ({ sessionId, body }: { sessionId: string; body: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = null;
      }
      const { revertIngestionBlock } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await revertIngestionBlock(db, sessionId, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartRecordSessionDetail = (id: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessionDetail } = await import('@/capabilities/ingestion/public');
      return await readIngestionSessionDetail(id);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartRecordSessionHistory = (id: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessionHistory } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readIngestionSessionHistory(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartRecordSessions = (query: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessions } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readIngestionSessions(db, new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const recordAdapters = {
  createStartIngestionSession,
  createStartIngestionOperation,
  answerStartRecordAsk,
  changeStartRecordPurpose,
  readStartRecordPurposeImpact,
  readStartRecordBlocks,
  createStartRecordManualMistake,
  revertStartRecordBlock,
  readStartRecordSessionDetail,
  readStartRecordSessionHistory,
  readStartRecordSessions,
};
