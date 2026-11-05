// 学习安排 owner 的稳定业务操作。practice 内其它 owner 只经本文件引用本 owner
// （`pnpm audit:practice-subowners`）；条目随本 owner 的文件迁入。
// 根 `public.ts` 按名字转出这里的操作，所以这里的静态导出会进入根 barrel 的静态加载链；
// due 队列、日计划事实与 review-due 工具保持按需加载。选题原语（候选信号、day-one 先验、
// 变式轮换分类）也从这里公开给定位与供题。

export { previewReviewAdvice } from './server/advice-operation';
export { type CandidateInput, collectCandidateSignals } from './server/candidate-signals';
export { loadDayOnePriors } from './server/day-one-priors';
export { scheduleReview } from './server/fsrs';
export { type WeeklyReportQuery, loadWeeklyReview } from './server/review-weekly';
export {
  getPracticeStream,
  recomposePracticeStream,
  updatePracticeStreamItem,
} from './server/stream-operations';
export { rotationClassForKind } from './server/variant-rotation';

export const queryReviewDue: typeof import('./server/due-list').queryReviewDue = async (...args) =>
  (await import('./server/due-list')).queryReviewDue(...args);

// YUK-1770 — steering deferral count for the kernel steering port; the capability
// barrel and agency read it only through this seam or the port.
export const countSteeringDeferredDueReviews: typeof import('./server/due-list').countSteeringDeferredDueReviews =
  async (...args) => (await import('./server/due-list')).countSteeringDeferredDueReviews(...args);

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
