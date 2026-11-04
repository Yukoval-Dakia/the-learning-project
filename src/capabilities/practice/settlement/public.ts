// 结算与撤回重放 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）；根 `public.ts` 按名字转出。

// Grading imports this file. Entries that themselves call grading load on first use, so
// loading settlement never loads grading.
export { authorizeConfirmationCorrection } from './server/appeal-execution';
export { writeAttemptSnapshotBrackets } from './server/attempt-snapshot';

export const createPracticeAppeal: typeof import('./server/appeal-operation').createPracticeAppeal =
  async (...args) => (await import('./server/appeal-operation')).createPracticeAppeal(...args);
export const captureReviewAnswerBinding: typeof import('./server/review-answer-binding').captureReviewAnswerBinding =
  async (...args) =>
    (await import('./server/review-answer-binding')).captureReviewAnswerBinding(...args);
export const consumeReviewAnswerBinding: typeof import('./server/review-answer-binding').consumeReviewAnswerBinding =
  async (...args) =>
    (await import('./server/review-answer-binding')).consumeReviewAnswerBinding(...args);
