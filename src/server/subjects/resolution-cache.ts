// trait 装配溯源缓存的兼容入口；本体在 kernel read-models，方便 capability
// 消费者共用而不深 import server/subjects。hydrate 仍是唯一写者，每轮整体换
// Map 引用。
export {
  type TraitDegradation,
  type TraitResolution,
  getSubjectTraitResolutions,
  isGeneralFallbackFor,
  replaceSubjectTraitResolutions,
} from '@/kernel/read-models/subject-trait-resolutions';
