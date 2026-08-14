import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightVisionOneShot } from './preflight-vision-one-shot';

const successResponse = new Response(
  JSON.stringify({
    id: 'msg_preflight',
    type: 'message',
    role: 'assistant',
    model: 'mimo-v2.5',
    content: [{ type: 'text', text: '{"saw_image":true,"color_guess":"red"}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

afterEach(() => {
  vi.useRealTimers();
});

describe('preflightVisionOneShot', () => {
  it('settles the 30-second timer after one successful SDK request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(successResponse.clone());

    const response = await preflightVisionOneShot({
      apiKey: 'test-key',
      baseURL: 'https://provider.invalid/anthropic',
      model: 'mimo-v2.5',
      fetch: fetchSpy,
    });

    expect(response.content).toEqual([
      { type: 'text', text: '{"saw_image":true,"color_guess":"red"}' },
    ]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles the 30-second timer after one failed SDK request without retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket closed'));

    await expect(
      preflightVisionOneShot({
        apiKey: 'test-key',
        baseURL: 'https://provider.invalid/anthropic',
        model: 'mimo-v2.5',
        fetch: fetchSpy,
      }),
    ).rejects.toThrow('Connection error');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
