import { errorResponse } from '@/kernel/http';

// Called after token/epoch authorization. Notes owns validation and the presence write.
export async function heartbeatStartNoteEditing(body: string) {
  try {
    const { requestEditingHeartbeat } = await import('@/capabilities/notes/public');
    const { db } = await import('@/db/client');
    return await requestEditingHeartbeat(db, async () => JSON.parse(body));
  } catch (error) {
    throw errorResponse(error);
  }
}

export async function blurStartNoteEditing(body: string) {
  try {
    const { requestEditingBlur } = await import('@/capabilities/notes/public');
    const { db } = await import('@/db/client');
    return await requestEditingBlur(db, async () => JSON.parse(body));
  } catch (error) {
    throw errorResponse(error);
  }
}
