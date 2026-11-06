import type { Db } from '@/db/client';
import { createAssessmentAssetLoader as createAssetLoader } from '@/kernel/records/assessment-assets';

export function createAssessmentAssetLoader(db: Db) {
  return createAssetLoader(db, async (key) => {
    const { getR2 } = await import('@/kernel/object-storage');
    return getR2().get(key);
  });
}
