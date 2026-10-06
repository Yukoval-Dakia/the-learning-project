import { expect, it } from 'vitest';
import { productWireEvidence } from './yuk1341-product-evidence';

it('keeps final output and cached usage while stripping raw thinking and provider secrets', () => {
  const safe = productWireEvidence({
    id: 'synthetic-response',
    model: 'mimo-v2.6-pro',
    authorization: 'never-store-this',
    headers: { secret: 'never-store-this' },
    usage: {
      prompt_tokens: 8000,
      completion_tokens: 140,
      total_tokens: 8140,
      prompt_tokens_details: { cached_tokens: 7000, debug: 'never-store-this' },
      completion_tokens_details: { reasoning_tokens: 68, raw: 'never-store-this' },
    },
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '{"memory":[]}',
          reasoning_content: 'never-store-this',
          reasoning_details: [{ text: 'never-store-this' }],
          thinking: 'never-store-this',
        },
      },
    ],
  });
  expect(JSON.stringify(safe)).not.toContain('never-store-this');
  expect(safe).toMatchObject({
    usage: {
      prompt_tokens_details: { cached_tokens: 7000 },
      completion_tokens_details: { reasoning_tokens: 68 },
    },
    choices: [{ message: { role: 'assistant', content: '{"memory":[]}' } }],
  });
});
