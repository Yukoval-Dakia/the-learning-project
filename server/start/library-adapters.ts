import { readStartLibraryDraftDetail } from './library-draft-detail-reader';
import { readStartLibraryDrafts } from './library-draft-list-reader';
import {
  enableStartLibraryDraft,
  forceEnableStartLibraryDraft,
} from './library-draft-promotion-operation';
import { readStartLibraryMistakes } from './library-mistake-list-reader';
import { archiveStartLibraryQuestion } from './library-question-delete-operation';
import { readStartLibraryQuestionDetail } from './library-question-detail-reader';
import { readStartLibraryQuestions } from './library-question-list-reader';
import { readStartLibraryQuestionMistakes } from './library-question-mistakes-reader';
import { restoreStartLibraryQuestion } from './library-question-restore-operation';
import { updateStartLibraryQuestion } from './library-question-update-operation';
import { runStartLibraryServingAction } from './library-serving-action-operation';
import { readStartPracticeQuestionDetail } from './practice-question-detail-operation';
import { readStartQuestionCard } from './question-card-operation';

// One family surface, constructed in the API graph when a Start operation first asks
// for it; each adapter keeps owning its own conversion, error and deadline handling.
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
