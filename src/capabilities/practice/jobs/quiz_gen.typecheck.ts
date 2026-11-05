import type { QuizGenJobData } from '@/kernel/quiz-gen-contract';

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
