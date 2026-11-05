/**
 * 30-second pre-flight: verify the resolved vision-judge lane actually accepts
 * image input + structured JSON output on its own wire shape.
 *
 * Usage:
 *   pnpm preflight:vision
 *   pnpm preflight:vision -- <model-id>       # override model
 *
 * Env required: whatever credential the resolved task lane declares
 *   (e.g. OPENCODE_API_KEY for the flash default) — resolution names it.
 *
 * Optional overrides:
 *   MIMO_VISION_MODEL    (default: resolved vision-judge task config)
 *   MIMO_VISION_BASE_URL (default: resolved lane endpoint)
 *
 * Exit codes:
 *   0 — vision PASS
 *   1 — vision FAIL; stop and re-decide (text-only fallback / different provider)
 *   2 — configuration missing/invalid, or the lane uses a wire/credential shape
 *       this probe cannot exercise
 *
 * Output: pass/fail summary + raw model response saved to
 *   docs/preflight/YYYY-MM-DD-vision-preflight.json (gitignored expected; commit
 *   on first run only as artifact of M0 exit gate).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { assertModelEndpointHostAllowed } from '../src/core/config/model-endpoint-allowlist';
import { executablePiModel } from '../src/server/ai/pi-provider-catalog';
import { type ResolvedProvider, resolveTaskProvider } from '../src/server/ai/providers';
import { applicableVisionJudgeOverride } from '../src/server/ai/vision-judge-config';
import { xiaomiTokenPlanVisionBaseUrl } from '../src/server/ai/xiaomi-token-plan';
import { preflightVisionOneShot, preflightVisionOpenAiOneShot } from './preflight-vision-one-shot';

config({ path: '.env' });

const OUT_DIR = resolve(process.cwd(), 'docs/preflight');
const today = new Date().toISOString().slice(0, 10);
const OUT_FILE = resolve(OUT_DIR, `${today}-vision-preflight.json`);

function failConfig(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(2);
}

// The probe mirrors what the runner would execute: env pin > lane.vision_judge
// > DB task override > registry default, pair-checked and credentialed. A
// broken lane (provider-only pair, removed model, missing key) exits 2 with
// the same TaskConfigError the run path raises.
let resolved: ResolvedProvider;
try {
  resolved = resolveTaskProvider('StepsJudgeTask', applicableVisionJudgeOverride());
} catch (error) {
  failConfig(error instanceof Error ? error.message : String(error));
}

const cliArgModel = process.argv[2];
const model = cliArgModel ?? process.env.MIMO_VISION_MODEL?.trim() ?? resolved.model;
const api = executablePiModel(resolved.provider, model)?.api ?? 'openai-completions';

async function main(): Promise<void> {
  let apiKey: string;
  let baseURL: string | undefined;
  let openAiHeaders: Record<string, string> | undefined;
  switch (resolved.authMode) {
    case 'key':
      apiKey = resolved.apiKey;
      // Token Plan keeps its stricter key→host binding on the override knob;
      // other lanes take the catalog endpoint + generic allowlist.
      baseURL =
        resolved.provider === 'xiaomi-token-plan'
          ? xiaomiTokenPlanVisionBaseUrl()
          : (process.env.MIMO_VISION_BASE_URL ?? resolved.baseUrl);
      break;
    case 'oauth':
      apiKey = resolved.apiKey;
      baseURL = process.env.MIMO_VISION_BASE_URL;
      break;
    case 'oauth-file':
      failConfig(
        `task lane uses provider '${resolved.provider}' whose OAuth credential lives in pi's file-backed credential store; run the probe from an environment that mounts it, or pin a key-auth lane`,
      );
  }

  // The probe sends the lane credential — refuse a host the catalog does not
  // declare instead of leaking the key there (YUK-1654).
  if (baseURL) {
    assertModelEndpointHostAllowed(baseURL, 'MIMO_VISION_BASE_URL (vision preflight)');
  }

  let text = '';
  let errorMessage: string | null = null;
  const start = Date.now();
  try {
    if (api === 'anthropic-messages') {
      const response = await preflightVisionOneShot({ apiKey, baseURL, model });
      text = response.text;
    } else {
      // openai-completions (+ any unknown api defaulting to it): the endpoint
      // is the lane's own baseUrl; opencode-go additionally requires the
      // per-run session header the adapter injects.
      if (!baseURL) {
        failConfig(
          `lane '${resolved.provider}/${model}' has no endpoint URL for an OpenAI-completions probe; set MIMO_VISION_BASE_URL`,
        );
      }
      if (resolved.provider === 'opencode-go') {
        openAiHeaders = { 'x-opencode-session': `preflight-vision-${today}` };
      }
      const response = await preflightVisionOpenAiOneShot({
        apiKey,
        baseURL,
        model,
        headers: openAiHeaders,
      });
      text = response.text;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const elapsed_ms = Date.now() - start;

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
    // `saw_image: false` means the model explicitly said it could NOT see the
    // image — that's a FAIL, not just "didn't crash". Require strict true.
    (parsedJson as { saw_image?: unknown }).saw_image === true;

  const result = {
    timestamp: new Date().toISOString(),
    provider: resolved.provider,
    api,
    model,
    base_url: baseURL ?? null,
    elapsed_ms,
    error: errorMessage,
    raw_text: text,
    parsed_json: parsedJson,
    vision_supported: visionSupported,
  };
  mkdirSync(OUT_DIR, { recursive: true });
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

console.log(`[preflight] provider=${resolved.provider} api=${api} model=${model}`);
main().catch((err) => {
  console.error('Pre-flight crashed:', err);
  process.exit(2);
});
