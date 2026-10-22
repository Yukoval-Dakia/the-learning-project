import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

export const readStartPapers: FrontdoorContext['readPapers'] = async () => {
  try {
    const { db } = await import('@/db/client');
    const { readPaperList } = await import('@/capabilities/practice/public');
    return await readPaperList(db);
  } catch (error) {
    throw errorResponse(error);
  }
};
