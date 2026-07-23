import type { QuizGenJobData } from './quiz_gen';

const validQuizGenJob = {
  trigger: 'knowledge',
  ref_id: 'kc-1',
  count: 8,
  exact_count: 8,
} satisfies QuizGenJobData;

const misspelledQuizGenJob: QuizGenJobData = {
  trigger: 'knowledge',
  ref_id: 'kc-1',
  // @ts-expect-error QuizGenJobData is closed: misspelled fields fail compilation.
  exactCount: 8,
};

void validQuizGenJob;
void misspelledQuizGenJob;
