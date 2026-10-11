// Compatibility entrypoint: scheduling math is shared with the FSRS state owner.
export {
  type InitialFsrsState,
  type ScheduleResult,
  initialFsrsState,
  scheduleReview,
} from '@/core/fsrs';

export { retrievabilityForKc } from '@/kernel/scheduling';
