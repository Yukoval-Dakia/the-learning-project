import { type RecordClient, assertLaneStarted } from '@/capabilities/ingestion/ui-public';
import { startIngestionOperationClient } from './ingestion-operation-create-client';

export const startRecordLaneClient: RecordClient['startLane'] = async (id, kind, key) => {
  const { resource } = await startIngestionOperationClient(id, { kind }, key);
  assertLaneStarted(resource);
};
