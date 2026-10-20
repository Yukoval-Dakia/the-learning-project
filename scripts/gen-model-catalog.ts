/**
 * YUK-924 Layer 1 — regenerate the committed models.dev catalog snapshot.
 *
 * Fetches the public models.dev catalog (https://models.dev/api.json) and writes
 * a TRIMMED, reviewable snapshot to src/server/ai/model-catalog.snapshot.json.
 * The committed snapshot is the offline floor and the fixture input.
 * Runtime reads go through src/server/ai/model-catalog.ts, which fetches this
 * same URL, caches the document, and falls back to the snapshot.
 *
 * TRIM (documented per the ticket): the snapshot keeps only
 *   - the catalog providers our internal provider map consumes
 *     (see CATALOG_PROVIDER_BY_INTERNAL in src/server/ai/model-profiles.ts):
 *     anthropic, xiaomi, zhipuai-coding-plan, opencode-go, openai, openrouter
 *     (OpenRouter keeps only the typed lane's model, not its unused chat catalog)
 *   - per model, only the fields the narrow parse layer consumes:
 *     id, name, last_updated, limit.{context,input,output}, tool_call,
 *     structured_output, attachment, reasoning, reasoning_options,
 *     provider, modalities.{input,output}, cost.{input,output,cache_read,cache_write}
 *   - provider api, for execution and /models reads
 *
 * Everything else (description, family, interleaved, temperature, knowledge,
 * release_date, open_weights, provider-level env/npm/doc metadata, and all
 * unrelated providers) is dropped. Output is deterministic apart from
 * `retrieved_at` (ISO timestamp of the fetch) so a regen diff is reviewable.
 *
 * Fail-closed: any non-200 response or JSON parse failure exits 1 WITHOUT
 * touching the existing snapshot.
 *
 * `pnpm gen:model-catalog -- --only <provider>` replaces that one bucket and
 * leaves every other provider's bytes untouched, including retrieved_at.
 * A full run still rewrites every kept provider.
 *
 * Usage: pnpm gen:model-catalog
 *        pnpm gen:model-catalog -- --only opencode-go
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_URL = 'https://models.dev/api.json';
const SNAPSHOT_RELATIVE_PATH = '../src/server/ai/model-catalog.snapshot.json';

/** Must stay in sync with CATALOG_PROVIDER_BY_INTERNAL in model-profiles.ts. */
const KEPT_CATALOG_PROVIDERS = [
  'anthropic',
  'xiaomi',
  'zhipuai-coding-plan',
  'opencode-go',
  'openai',
  'openrouter',
] as const;

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
  'provider',
  'modalities',
  'cost',
] as const;

interface RawCatalogModel {
  [field: string]: unknown;
}

interface TrimmedProvider {
  api?: unknown;
  models: Record<string, Record<string, unknown>>;
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

function onlyProvider(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--only');
  if (index === -1) return undefined;
  const id = argv[index + 1];
  if (id === undefined || id.startsWith('-')) {
    console.error('[gen-model-catalog] --only needs a provider id');
    process.exit(1);
  }
  if (!(KEPT_CATALOG_PROVIDERS as readonly string[]).includes(id)) {
    console.error(`[gen-model-catalog] --only provider is not kept: ${id}`);
    process.exit(1);
  }
  return id;
}

function trimProviders(
  root: Record<string, unknown>,
  ids: readonly string[],
): { providers: Record<string, TrimmedProvider>; missing: string[] } {
  const providers: Record<string, TrimmedProvider> = {};
  const missing: string[] = [];
  for (const providerId of ids) {
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
      if (providerId === 'openrouter' && modelId !== 'typesafe/jev-1.13') continue;
      if (model === null || typeof model !== 'object' || Array.isArray(model)) continue;
      trimmedModels[modelId] = trimModel(modelId, model as RawCatalogModel);
    }
    providers[providerId] = {
      api: (entry as Record<string, unknown>).api,
      models: trimmedModels,
    };
  }
  return { providers, missing };
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Key line through the provider object's closing brace, comma excluded. */
function providerSlice(text: string, id: string): string | undefined {
  const needle = `\n    ${JSON.stringify(id)}:`;
  const at = text.indexOf(needle);
  if (at < 0) return undefined;
  const open = text.indexOf('{', at);
  const close = matchingBrace(text, open);
  if (close < 0) return undefined;
  return text.slice(at + 1, close + 1);
}

function renderBucket(bucket: TrimmedProvider): string {
  const lines = JSON.stringify(bucket, null, 2).split('\n');
  return [lines[0], ...lines.slice(1).map((line) => `    ${line}`)].join('\n');
}

function keptProvidersLine(ids: readonly string[]): string {
  return `"kept_providers": [${ids.map((id) => JSON.stringify(id)).join(', ')}]`;
}

/**
 * Insert or replace one provider in the existing snapshot text. Other provider
 * slices stay byte-identical. retrieved_at stays. Biome runs afterwards.
 */
function spliceProvider(text: string, id: string, bucket: TrimmedProvider): string {
  const keptProvidersPattern = /"kept_providers": \[[^\]]*\]/;
  if (!keptProvidersPattern.test(text)) {
    console.error('[gen-model-catalog] snapshot has no kept_providers line');
    process.exit(1);
  }
  const kept = text.replace(keptProvidersPattern, keptProvidersLine(KEPT_CATALOG_PROVIDERS));
  const rendered = renderBucket(bucket);
  const existing = providerSlice(kept, id);
  if (existing) {
    const at = kept.indexOf(existing);
    const brace = existing.indexOf('{');
    return (
      kept.slice(0, at) + existing.slice(0, brace) + rendered + kept.slice(at + existing.length)
    );
  }
  const providersKey = '\n  "providers":';
  const keyAt = kept.indexOf(providersKey);
  const open = kept.indexOf('{', keyAt);
  const close = matchingBrace(kept, open);
  if (keyAt < 0 || close < 0) {
    console.error('[gen-model-catalog] snapshot has no providers object');
    process.exit(1);
  }
  let previous = close - 1;
  while (previous > open && /\s/.test(kept[previous] ?? '')) previous -= 1;
  if (kept[previous] !== '}') {
    console.error('[gen-model-catalog] providers object has no bucket to append after');
    process.exit(1);
  }
  const insertion = `,\n    ${JSON.stringify(id)}: ${rendered}\n  `;
  return kept.slice(0, previous + 1) + insertion + kept.slice(close);
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
  const only = onlyProvider(process.argv);
  const ids = only === undefined ? KEPT_CATALOG_PROVIDERS : [only];
  const { providers, missing } = trimProviders(root, ids);
  if (missing.length > 0) {
    console.error(
      `[gen-model-catalog] expected provider(s) missing or malformed in catalog: ${missing.join(', ')}`,
    );
    process.exit(1);
  }

  const snapshotPath = resolve(dirname(fileURLToPath(import.meta.url)), SNAPSHOT_RELATIVE_PATH);
  const previous = (() => {
    try {
      return readFileSync(snapshotPath, 'utf8');
    } catch {
      return undefined;
    }
  })();
  if (previous) {
    const old = JSON.parse(previous) as { providers: Record<string, TrimmedProvider> };
    for (const [id, provider] of Object.entries(providers)) {
      // Offline regeneration must not remove previously available models either.
      provider.models = { ...old.providers[id]?.models, ...provider.models };
    }
  }
  mkdirSync(dirname(snapshotPath), { recursive: true });
  if (only !== undefined) {
    if (previous === undefined) {
      console.error('[gen-model-catalog] --only needs an existing snapshot to splice into');
      process.exit(1);
    }
    const bucket = providers[only];
    if (bucket === undefined) {
      console.error(`[gen-model-catalog] trimmed bucket missing: ${only}`);
      process.exit(1);
    }
    writeFileSync(snapshotPath, spliceProvider(previous, only, bucket));
  } else {
    const snapshot = {
      _meta: {
        source: CATALOG_URL,
        retrieved_at: new Date().toISOString(),
        trim: 'providers consumed by the internal provider map; per-model fields consumed by the narrow parse in src/server/ai/model-profiles.ts',
        kept_providers: KEPT_CATALOG_PROVIDERS,
      },
      providers,
    };
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
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
  const written = readFileSync(snapshotPath, 'utf8');
  if (only !== undefined && previous !== undefined) {
    const beforeIds = Object.keys(
      (JSON.parse(previous) as { providers?: Record<string, unknown> }).providers ?? {},
    );
    const drifted = beforeIds.filter(
      (id) => id !== only && providerSlice(previous, id) !== providerSlice(written, id),
    );
    if (drifted.length > 0) {
      writeFileSync(snapshotPath, previous);
      console.error(
        `[gen-model-catalog] --only ${only} changed other provider bytes: ${drifted.join(', ')}`,
      );
      process.exit(1);
    }
  }
  const modelCount = Object.values(
    (JSON.parse(written) as { providers: Record<string, TrimmedProvider> }).providers,
  ).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
  const changed = previous !== written;
  console.log(
    `[gen-model-catalog] ${changed ? 'wrote' : 'snapshot unchanged'} ${snapshotPath} (${only ?? 'all kept'}, ${modelCount} models)`,
  );
}

void main();
