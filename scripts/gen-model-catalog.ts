/**
 * YUK-924 Layer 1 — regenerate the committed models.dev catalog snapshot.
 *
 * Fetches the public models.dev catalog (https://models.dev/api.json) and writes
 * a TRIMMED, reviewable snapshot to src/server/ai/model-catalog.snapshot.json.
 * CI / audits / runtime code read ONLY the committed snapshot — there is NO
 * runtime network fetch (a runtime refresh can be a follow-up if ever needed).
 *
 * TRIM (documented per the ticket): the snapshot keeps only
 *   - the catalog providers our internal provider map consumes
 *     (see CATALOG_PROVIDER_BY_INTERNAL in src/server/ai/model-profiles.ts):
 *     anthropic, xiaomi, zhipuai-coding-plan
 *   - per model, only the fields the narrow parse layer consumes:
 *     id, name, last_updated, limit.{context,output}, tool_call,
 *     structured_output, attachment, reasoning, reasoning_options,
 *     modalities.{input,output}, cost.{input,output,cache_read,cache_write}
 *
 * Everything else (description, family, interleaved, temperature, knowledge,
 * release_date, open_weights, provider-level env/npm/api/doc metadata, and all
 * unrelated providers) is dropped. Output is deterministic apart from
 * `retrieved_at` (ISO timestamp of the fetch) so a regen diff is reviewable.
 *
 * Fail-closed: any non-200 response or JSON parse failure exits 1 WITHOUT
 * touching the existing snapshot.
 *
 * Usage: pnpm gen:model-catalog
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_URL = 'https://models.dev/api.json';
const SNAPSHOT_RELATIVE_PATH = '../src/server/ai/model-catalog.snapshot.json';

/** Must stay in sync with CATALOG_PROVIDER_BY_INTERNAL in model-profiles.ts. */
const KEPT_CATALOG_PROVIDERS = ['anthropic', 'xiaomi', 'zhipuai-coding-plan'] as const;

const KEPT_MODEL_FIELDS = [
  'id',
  'name',
  'last_updated',
  'limit',
  'tool_call',
  'structured_output',
  'attachment',
  'reasoning',
  'reasoning_options',
  'modalities',
  'cost',
] as const;

interface RawCatalogModel {
  [field: string]: unknown;
}

function trimModel(id: string, model: RawCatalogModel): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const field of KEPT_MODEL_FIELDS) {
    if (model[field] !== undefined) trimmed[field] = model[field];
  }
  // models.dev keys models by id but also carries the id inside the entry;
  // keep it explicit so the snapshot is self-describing.
  trimmed.id = id;
  return trimmed;
}

async function main(): Promise<void> {
  const response = await fetch(CATALOG_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    console.error(`[gen-model-catalog] ${CATALOG_URL} returned HTTP ${response.status}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch (error) {
    console.error(`[gen-model-catalog] JSON parse failed: ${String(error)}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[gen-model-catalog] catalog root is not an object');
    process.exit(1);
  }
  const root = parsed as Record<string, unknown>;

  const providers: Record<string, { models: Record<string, Record<string, unknown>> }> = {};
  const missing: string[] = [];
  for (const providerId of KEPT_CATALOG_PROVIDERS) {
    const entry = root[providerId];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      missing.push(providerId);
      continue;
    }
    const models = (entry as { models?: unknown }).models;
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      missing.push(providerId);
      continue;
    }
    const trimmedModels: Record<string, Record<string, unknown>> = {};
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      if (model === null || typeof model !== 'object' || Array.isArray(model)) continue;
      trimmedModels[modelId] = trimModel(modelId, model as RawCatalogModel);
    }
    providers[providerId] = { models: trimmedModels };
  }
  if (missing.length > 0) {
    console.error(
      `[gen-model-catalog] expected provider(s) missing or malformed in catalog: ${missing.join(', ')}`,
    );
    process.exit(1);
  }

  const snapshot = {
    _meta: {
      source: CATALOG_URL,
      retrieved_at: new Date().toISOString(),
      trim: 'providers consumed by the internal provider map; per-model fields consumed by the narrow parse in src/server/ai/model-profiles.ts',
      kept_providers: KEPT_CATALOG_PROVIDERS,
    },
    providers,
  };

  const snapshotPath = resolve(dirname(fileURLToPath(import.meta.url)), SNAPSHOT_RELATIVE_PATH);
  const previous = (() => {
    try {
      return readFileSync(snapshotPath, 'utf8');
    } catch {
      return undefined;
    }
  })();
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  // The committed snapshot is biome-formatted (the repo's formatter owns every
  // committed file); reformat in place so a regen cannot introduce format drift.
  try {
    execSync(`pnpm exec biome format --write ${JSON.stringify(snapshotPath)} --reporter=summary`, {
      stdio: 'inherit',
    });
  } catch {
    console.warn(
      '[gen-model-catalog] biome format step failed — run `pnpm exec biome format --write src/server/ai/model-catalog.snapshot.json` before committing',
    );
  }
  const modelCount = Object.values(providers).reduce(
    (sum, provider) => sum + Object.keys(provider.models).length,
    0,
  );
  const changed = previous !== readFileSync(snapshotPath, 'utf8');
  console.log(
    `[gen-model-catalog] ${changed ? 'wrote' : 'snapshot unchanged'} ${snapshotPath} (${KEPT_CATALOG_PROVIDERS.length} providers, ${modelCount} models)`,
  );
}

void main();
