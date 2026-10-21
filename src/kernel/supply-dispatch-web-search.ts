import { buildExaMcpServer } from '@/server/ai/mcp/exa';

/** Web search backend availability: a configured key means available. */
export function supplyDispatchWebSearchAvailable(): boolean {
  return buildExaMcpServer() !== null;
}
