import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('src/capabilities');

async function listApiModules(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) return listApiModules(target);
      return entry.isFile() && entry.name.endsWith('-api.ts') ? [target] : [];
    }),
  );
  return nested.flat();
}

const violations: string[] = [];
for (const file of await listApiModules(ROOT)) {
  const source = await readFile(file, 'utf8');
  // Generated operation types must own browser wire contracts. Domain/view
  // projections may remain in *-api.ts, but the untyped generic escape hatch may not.
  if (/\bapiJson\s*(?:<|\()/.test(source) || /\bapiJson\s*,/.test(source)) {
    violations.push(path.relative(process.cwd(), file));
  }
}

if (violations.length > 0) {
  console.error('Capability UI API modules still use handwritten apiJson wire types:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    'API client usage audit passed: every capability *-api.ts uses generated operations.',
  );
}
