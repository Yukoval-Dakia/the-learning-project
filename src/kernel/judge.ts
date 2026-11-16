// judge facade：capability 包只依赖 @/kernel/*，判题调用统一从这里取。不承载
// 业务逻辑；新增出口必须显式加入清单，禁止 export *。

export {
  commitFormalAttempt,
  defaultImageFetch,
  previewFormalAttempt,
  recordFormalAttemptCapture,
  saveSubmission,
  withdrawCapturedOccurrence,
} from '@/capabilities/practice/public';
