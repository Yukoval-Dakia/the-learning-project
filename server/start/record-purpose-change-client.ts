import { type RecordClient, purposeReceiptLocation } from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { changeStartRecordPurposeFunction } from './record-purpose-change-function';

export const startRecordPurposeChangeClient: RecordClient['changePurpose'] = async (id, body) => {
  const { location, ...result } = JSON.parse(
    await changeStartRecordPurposeFunction({
      fetch: authenticatedStartFetch,
      data: { sessionId: id, body: JSON.stringify(body) },
    }),
  );
  return { ...result, location: purposeReceiptLocation(id, body, location) };
};
