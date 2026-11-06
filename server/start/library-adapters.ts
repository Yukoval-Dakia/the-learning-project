// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import type { readQuestionDetail } from '@/capabilities/practice/question-bank/public';
import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';

export const readStartLibraryQuestionDetail = (
  id: string,
): Promise<Awaited<ReturnType<typeof readQuestionDetail>>> =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readQuestionDetail } = await import('@/capabilities/practice/question-bank/public');
      const { db } = await import('@/db/client');
      return await readQuestionDetail(db, { id }, { timelineLimit: null, surface: null });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartLibraryQuestionMistakes = (id: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readMistakes } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readMistakes(db, { question_id: id, limit: '50' });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartLibraryQuestions = (query: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readPracticeQuestionList } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await readPracticeQuestionList(db, new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartLibraryMistakes = (query: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readMistakes } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      const raw: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(query).entries()) raw[key] = value;
      return await readMistakes(db, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const restoreStartLibraryQuestion = ({ id, body }: { id: string; body: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { restorePracticeQuestion } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await restorePracticeQuestion(db, { id }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const updateStartLibraryQuestion = ({ id, body }: { id: string; body: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { updatePracticeQuestion } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await updatePracticeQuestion(db, { id }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });

function servingActionParams(path: string): Record<string, string> {
  const match =
    typeof path === 'string'
      ? /^\/api\/questions\/([^/?#]+)\/serving-actions\/([^/?#]+)$/.exec(path)
      : null;
  if (!match || match[0] !== path) {
    throw new ApiError(
      'validation_error',
      'expected a canonical question serving-action path',
      400,
    );
  }
  try {
    return { id: decodeURIComponent(match[1]), command: decodeURIComponent(match[2]) };
  } catch {
    throw new ApiError(
      'validation_error',
      'serving-action path contains invalid URL encoding',
      400,
    );
  }
}

export const runStartLibraryServingAction = ({
  path,
  idempotencyKey,
}: {
  path: string;
  idempotencyKey: string | null;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const params = servingActionParams(path);
      const { runPracticeServingAction } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await runPracticeServingAction(db, params, idempotencyKey);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const archiveStartLibraryQuestion = ({ id, query }: { id: string; query: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { archivePracticeQuestion } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await archivePracticeQuestion(db, { id }, () => new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartLibraryDraftDetail = (id: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readDraftReviewDetail } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await readDraftReviewDetail(db, id);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartLibraryDrafts = (query: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readPracticeDraftList } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await readPracticeDraftList(db, new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const enableStartLibraryDraft = (id: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { enablePracticeDraft } = await import('@/capabilities/practice/question-bank/public');
      const { db } = await import('@/db/client');
      return await enablePracticeDraft(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const forceEnableStartLibraryDraft = ({ id, body }: { id: string; body: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { forceEnablePracticeDraft } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await forceEnablePracticeDraft(db, { id }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const readStartQuestionCard = async (id: string, sessionId: string) => {
  try {
    const { readQuestionCard } = await import('@/kernel/read-models/question-card');
    const { db } = await import('@/db/client');
    return await readQuestionCard(db, id, sessionId);
  } catch (error) {
    throw errorResponse(error);
  }
};

export const readStartPracticeQuestionDetail = (
  id: string,
): Promise<Awaited<ReturnType<typeof readQuestionDetail>>> =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readQuestionDetail } = await import('@/capabilities/practice/question-bank/public');
      const { db } = await import('@/db/client');
      return await readQuestionDetail(db, { id }, { timelineLimit: null, surface: 'practice' });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const libraryAdapters = {
  readStartQuestionCard,
  readStartLibraryQuestionDetail,
  readStartLibraryQuestionMistakes,
  readStartLibraryQuestions,
  readStartLibraryMistakes,
  restoreStartLibraryQuestion,
  updateStartLibraryQuestion,
  runStartLibraryServingAction,
  archiveStartLibraryQuestion,
  readStartLibraryDraftDetail,
  readStartLibraryDrafts,
  enableStartLibraryDraft,
  forceEnableStartLibraryDraft,
  readStartPracticeQuestionDetail,
};
