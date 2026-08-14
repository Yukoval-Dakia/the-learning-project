import Anthropic from '@anthropic-ai/sdk';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

type PreflightVisionOneShotOptions = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly fetch?: NonNullable<ConstructorParameters<typeof Anthropic>[0]>['fetch'];
};

export async function preflightVisionOneShot(options: PreflightVisionOneShotOptions) {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 0,
    timeout: 30_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return client.messages.create({
    model: options.model,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: TINY_PNG_B64,
            },
          },
          {
            type: 'text',
            text: 'You are a JSON-only responder. The image is a tiny 1x1 pixel. Respond with exactly this JSON: {"saw_image": true, "color_guess": "<one word>"}. Do not include any text outside the JSON object.',
          },
        ],
      },
    ],
  });
}
