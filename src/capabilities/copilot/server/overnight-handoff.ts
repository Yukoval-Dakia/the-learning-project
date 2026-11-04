// Compat shim: the sentence formatter moved to the shared kernel read-model with
// YUK-1794 (the Context 稳态段「昨夜」槽 consumes the same projection).
export {
  type LoadTodayOvernightDigest,
  readOvernightHandoffSentence,
} from '@/kernel/read-models/overnight-digest';
