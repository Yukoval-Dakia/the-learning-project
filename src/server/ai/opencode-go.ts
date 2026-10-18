// YUK-1547 — OpenCode Go 官方 OpenAI-compatible 端点。
//
// pi-ai 1.1.0 的内置 opencode-go 目录仍把全部 OpenAI 族模型指到旧
// https://opencode.ai/zen/go/v1；官方新端点是
// https://opencode.ai/inference/go/openai/v1
// （付费实测：chat + tool_call 均 HTTP 200，receipt 封存于
// docs/planning/evidence/2026-10-18-opencode-go-deepseek-v4.1-flash-receipts.json）。
// 该字面量是 lane 的唯一来源：providers.ts 的 lane baseUrl、pi-models.ts 的
// 运行时 model rebind、pi-provider-catalog.ts 的同步读面都从这里取。
// anthropic-messages 族模型暂无实测新路径，保持 pi 内置 baseUrl 不动。
export const OPENCODE_GO_OPENAI_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';

/** 新端点承接的 OpenAI API 族（同一 /v1 base 下的 chat completions 与 responses）。 */
export function isOpenCodeGoOpenAiApi(api: string): boolean {
  return api === 'openai-completions' || api === 'openai-responses';
}
