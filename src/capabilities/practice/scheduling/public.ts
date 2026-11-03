// 学习安排 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）；条目随本 owner 的文件迁入。
// 根 `public.ts` 按名字转出这里的操作，所以这里的静态导出会进入根 barrel 的静态加载链；
// due 队列、日计划事实与 review-due 工具保持按需加载。

export { previewReviewAdvice } from './server/advice-operation';
export { scheduleReview } from './server/fsrs';
export { type WeeklyReportQuery, loadWeeklyReview } from './server/review-weekly';
export {
  getPracticeStream,
  recomposePracticeStream,
  updatePracticeStreamItem,
} from './server/stream-operations';

export const queryReviewDue: typeof import('./server/due-list').queryReviewDue = async (...args) =>
  (await import('./server/due-list')).queryReviewDue(...args);

type HandleReviewDue = typeof import('./server/due-list').handleReviewDue;
export const handleReviewDue: HandleReviewDue = async (...args) => {
  const dueList = await import('./server/due-list');
  return dueList.handleReviewDue(...args);
};

// Binds practice's due queue, minute budget and measured pace into the kernel
// plan projection. Coach calls the kernel reader; it does not import this module.
export async function installDailyReviewPlanFacts(): Promise<void> {
  const [{ installDailyReviewPlanFactReader }, { readDailyReviewPlanFacts }] = await Promise.all([
    import('@/kernel/read-models/daily-review-plan'),
    import('./server/daily-review-plan'),
  ]);
  installDailyReviewPlanFactReader(readDailyReviewPlanFacts);
}

/** The get_review_due tool body that the root host binds behind the kernel review-due port. */
export async function loadReviewDueReader() {
  return (await import('./tools/question-context')).executeGetReviewDue;
}
