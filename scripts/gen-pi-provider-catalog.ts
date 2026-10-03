// Offline metadata for synchronous config readers. The execution registry remains pi's builtins.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const registry = builtinModels();
const providers = Object.fromEntries(
  ['anthropic', 'xiaomi', 'zai-coding-cn', 'opencode-go', 'openai'].map((provider) => [
    provider,
    Object.fromEntries(
      registry.getModels(provider).map((model) => [
        model.id,
        {
          api: model.api,
          baseUrl: model.baseUrl,
          input: model.input,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
      ]),
    ),
  ]),
);
writeFileSync(
  new URL('../src/server/ai/pi-provider-catalog.snapshot.json', import.meta.url),
  `${JSON.stringify(providers, null, 2)}\n`,
);

execFileSync(
  'pnpm',
  [
    '--config.verify-deps-before-run=false',
    'exec',
    'biome',
    'format',
    '--write',
    fileURLToPath(new URL('../src/server/ai/pi-provider-catalog.snapshot.json', import.meta.url)),
  ],
  { stdio: 'inherit' },
);
