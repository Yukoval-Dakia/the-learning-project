import { buildExaMcpServer } from '@/ai/exa-mcp';

/** Web search backend availability: a configured key means available. */
export function supplyDispatchWebSearchAvailable(): boolean {
  return buildExaMcpServer() !== null;
}
