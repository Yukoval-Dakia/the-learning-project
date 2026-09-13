import { buildExaMcpServer } from '@/server/ai/mcp/exa';

/** Web 检索后端（Exa）可用性单一真相：key 配置即可用（Tavily → Exa 换装 2026-09-13）。 */
export function supplyDispatchWebSearchAvailable(): boolean {
  return buildExaMcpServer() !== null;
}
