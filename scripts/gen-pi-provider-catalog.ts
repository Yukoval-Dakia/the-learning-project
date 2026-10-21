// Synchronous protocol/compat metadata only. Model facts belong to models.dev.
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
          thinkingFormat: (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat,
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
