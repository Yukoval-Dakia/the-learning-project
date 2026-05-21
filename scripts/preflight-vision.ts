/**
 * 30-second pre-flight: verify the xiaomi/mimo Anthropic-compatible endpoint
 * supports vision input + structured JSON output.
 *
 * Usage:
 *   pnpm preflight:vision
 *   pnpm preflight:vision -- mimo-v2.5-pro    # override model
 *
 * Env required:
 *   XIAOMI_API_KEY  (from .env)
 *
 * Optional overrides:
 *   MIMO_VISION_MODEL  (default: mimo-v2.5)
 *   MIMO_VISION_BASE_URL (default: https://api.xiaomimimo.com/anthropic)
 *
 * Exit codes:
 *   0 — vision PASS; safe to proceed with M2 vision judge
 *   1 — vision FAIL; stop M2 plan and re-decide (text-only fallback / different provider)
 *   2 — env config missing
 *
 * Output: pass/fail summary + raw model response saved to
 *   docs/preflight/YYYY-MM-DD-vision-preflight.json (gitignored expected; commit
 *   on first run only as artifact of M0 exit gate).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

config({ path: '.env' });

const OUT_DIR = resolve(process.cwd(), 'docs/preflight');
const today = new Date().toISOString().slice(0, 10);
const OUT_FILE = resolve(OUT_DIR, `${today}-vision-preflight.json`);

const apiKey = process.env.XIAOMI_API_KEY;
const baseURL = process.env.MIMO_VISION_BASE_URL ?? 'https://api.xiaomimimo.com/anthropic';
const cliArgModel = process.argv[2];
const model = cliArgModel ?? process.env.MIMO_VISION_MODEL ?? 'mimo-v2.5';

if (!apiKey || apiKey.trim().length === 0) {
  console.error('FAIL: XIAOMI_API_KEY not set in environment');
  console.error('Hint: check .env file');
  process.exit(2);
}

// A tiny 1x1 red PNG (base64). Enough to test the image content path without
// external fetch. If model can't see the image, structured JSON won't include
// the expected fields.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
  console.log(`[preflight] base=${baseURL} model=${model}`);
  const client = new Anthropic({ apiKey, baseURL });
  const start = Date.now();
  let response: Awaited<ReturnType<typeof client.messages.create>> | null = null;
  let errorMessage: string | null = null;

  try {
    response = await client.messages.create({
      model,
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
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const elapsed_ms = Date.now() - start;

  mkdirSync(OUT_DIR, { recursive: true });

  const text =
    response?.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('') ?? '';

  let parsedJson: unknown = null;
  try {
    const start_idx = text.indexOf('{');
    const end_idx = text.lastIndexOf('}');
    if (start_idx !== -1 && end_idx !== -1 && end_idx > start_idx) {
      parsedJson = JSON.parse(text.slice(start_idx, end_idx + 1));
    }
  } catch {
    // leave parsedJson null
  }

  const visionSupported =
    errorMessage === null &&
    parsedJson !== null &&
    typeof (parsedJson as { saw_image?: unknown }).saw_image === 'boolean';

  const result = {
    timestamp: new Date().toISOString(),
    model,
    base_url: baseURL,
    elapsed_ms,
    error: errorMessage,
    raw_text: text,
    parsed_json: parsedJson,
    vision_supported: visionSupported,
  };
  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  console.log(`\nPre-flight result: ${visionSupported ? 'PASS' : 'FAIL'}`);
  console.log(`Elapsed: ${elapsed_ms}ms`);
  console.log(`Saved: ${OUT_FILE}`);

  if (!visionSupported) {
    console.error(`\nReason: ${errorMessage ?? 'no parseable JSON with saw_image field'}`);
    console.error('\nRaw response (first 500 chars):');
    console.error(text.slice(0, 500));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Pre-flight crashed:', err);
  process.exit(2);
});
