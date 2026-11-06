import Anthropic from '@anthropic-ai/sdk';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const PROMPT =
  'You are a JSON-only responder. The image is a tiny 1x1 pixel. Respond with exactly this JSON: {"saw_image": true, "color_guess": "<one word>"}. Do not include any text outside the JSON object.';

type PreflightVisionOneShotOptions = {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly model: string;
  readonly fetch?: NonNullable<ConstructorParameters<typeof Anthropic>[0]>['fetch'];
};

export async function preflightVisionOneShot(options: PreflightVisionOneShotOptions) {
  // OAuth subscription tokens (sk-ant-oat*) authenticate as Bearer, never as
  // x-api-key — same distinction pi's anthropic driver makes.
  const oauth = options.apiKey.startsWith('sk-ant-oat');
  const client = new Anthropic({
    ...(oauth
      ? {
          authToken: options.apiKey,
          defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
        }
      : { apiKey: options.apiKey }),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: 0,
    timeout: 30_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const response = await client.messages.create({
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
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  return {
    text: response.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join(''),
  };
}

type PreflightVisionOpenAiOptions = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  /** Lane-specific extra headers (e.g. opencode-go's x-opencode-session). */
  readonly headers?: Record<string, string>;
};

export async function preflightVisionOpenAiOneShot(options: PreflightVisionOpenAiOptions) {
  const response = await fetch(`${options.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      ...options.headers,
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 400)}`);
  }
  const json = (await response.json()) as {
    choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
  };
  const content = json.choices?.[0]?.message?.content;
  return {
    text:
      typeof content === 'string'
        ? content
        : (content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join(''),
  };
}
