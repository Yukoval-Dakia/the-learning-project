import type { LibraryClient } from '@/capabilities/practice/ui-public';
import { startLibraryDraftDetailClient } from './library-draft-detail-client';
import { startLibraryDraftsClient } from './library-draft-list-client';
import {
  startLibraryDraftEnableClient,
  startLibraryDraftForceEnableClient,
} from './library-draft-promotion-client';
import { startLibraryMistakesClient } from './library-mistake-list-client';
import { startLibraryQuestionDeleteClient } from './library-question-delete-client';
import { startLibraryQuestionDetailClient } from './library-question-detail-client';
import { startLibraryQuestionsClient } from './library-question-list-client';
import { startLibraryQuestionMistakesClient } from './library-question-mistakes-client';
import { startLibraryQuestionRestoreClient } from './library-question-restore-client';
import { startLibraryQuestionUpdateClient } from './library-question-update-client';
import { startLibraryServingActionClient } from './library-serving-action-client';
import { startKnowledgeTreeClient } from './workbench-client';

export const startLibraryClient: LibraryClient = {
  listMistakes: startLibraryMistakesClient,
  getReviewDrafts: startLibraryDraftsClient,
  getQuestionsList: startLibraryQuestionsClient,
  enableDraft: startLibraryDraftEnableClient,
  forceEnableDraft: startLibraryDraftForceEnableClient,
  runServingAction: startLibraryServingActionClient,
  deleteQuestion: startLibraryQuestionDeleteClient,
  patchQuestion: startLibraryQuestionUpdateClient,
  restoreQuestion: startLibraryQuestionRestoreClient,
  listQuestionMistakes: startLibraryQuestionMistakesClient,
  getQuestionKnowledgeOptions: () => startKnowledgeTreeClient(),
  getDraftDetail: startLibraryDraftDetailClient,
  getQuestionFull: startLibraryQuestionDetailClient,
};
