import { buildTavilyMcpServer } from '@/server/ai/mcp/tavily';

export function supplyDispatchTavilyAvailable(): boolean {
  return buildTavilyMcpServer() !== null;
}
