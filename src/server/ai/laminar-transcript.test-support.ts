import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai';
import { piTraceUsage, piTraceUsageCases } from './laminar-tracing.test-support';

export const transcriptAssistant: AssistantMessage = {
  role: 'assistant',
  api: 'openai-completions',
  provider: 'offline',
  model: 'offline-model',
  responseId: 'response-2',
  timestamp: 2,
  stopReason: 'toolUse',
  usage: piTraceUsage(piTraceUsageCases[0]),
  content: [
    { type: 'thinking', thinking: 'FORBIDDEN_COT', thinkingSignature: 'FORBIDDEN_SIGNATURE' },
    { type: 'text', text: '先比较两个方程。<think>FORBIDDEN_INLINE_COT</think>可见结论：x = 2。' },
    {
      type: 'toolCall',
      id: 'turn-2-call',
      name: 'lookup',
      arguments: {
        query: '二次函数的定义与边界',
        apiKey: 'FORBIDDEN_KEY',
        nested: { authorization: 'FORBIDDEN_HEADER', answer: '保留正常教育内容' },
      },
    },
  ],
};
export const transcriptContext = normalizeContext({
  messages: [
    {
      role: 'system',
      content: '你是数学教师。',
      sections: { rubric: '按步骤判分。' },
      timestamp: 1,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '学生原答：令 f(x)=x²-4，解释两个根的意义。Authorization: Bearer FORBIDDEN_BEARER',
        },
        { type: 'image', data: 'FORBIDDEN_IMAGE', mimeType: 'image/png' },
      ],
      timestamp: 1,
    },
    transcriptAssistant,
    {
      role: 'toolResult',
      toolCallId: 'turn-2-call',
      toolName: 'lookup',
      timestamp: 3,
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            explanation: '根为 ±2。',
            credentials: 'FORBIDDEN_CREDENTIALS',
            reasoning: 'FORBIDDEN_REASONING',
          }),
        },
      ],
      details: { secret: 'FORBIDDEN_DETAILS' },
    },
    {
      role: 'user',
      content: '图片 https://assets.invalid/q.png?X-Amz-Signature=FORBIDDEN_URL；继续讲解。',
      timestamp: 4,
    },
  ] satisfies Context['messages'],
});
export const transcriptToolInput = {
  query: '一元二次方程',
  studentAnswer: '2和-2均使等式成立',
  headers: { Authorization: 'FORBIDDEN_HEADERS' },
  env: { KEY: 'FORBIDDEN_ENV' },
  providerBinding: { key: 'FORBIDDEN_BINDING' },
  password: 'FORBIDDEN_PASSWORD',
};
export const transcriptToolResult = {
  content: [
    { type: 'text', text: '两根代入均为零。' },
    { type: 'image', data: 'FORBIDDEN_BINARY', mimeType: 'image/png' },
  ],
  details: { score: 1, feedback: '解法正确', accessToken: 'FORBIDDEN_TOKEN' },
  isError: false,
};
