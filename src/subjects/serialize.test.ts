import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import type { SubjectProfile } from './profile-schema';
import { serializeProfileToTs } from './serialize';
import { wenyanProfile } from './wenyan/profile';

// Re-evaluate a serialized profile literal by writing it to a temp file UNDER
// src/subjects/ (so the `import type { SubjectProfile } from '../profile'` header's
// relative path is structurally valid; the `import type` is erased at runtime by
// the vitest/esbuild transform) and dynamically importing it back.
const tmpDir = mkdtempSync(join(__dirname, 'serialize-roundtrip-'));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function roundTrip(profile: SubjectProfile): Promise<SubjectProfile> {
  const source = serializeProfileToTs(profile);
  const filePath = join(tmpDir, `${profile.id}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(filePath, source);
  const mod = (await import(filePath)) as Record<string, SubjectProfile>;
  const exported = mod[`${profile.id}Profile`];
  if (!exported) {
    throw new Error(`serialized module did not export ${profile.id}Profile`);
  }
  return exported;
}

describe('serializeProfileToTs', () => {
  it('round-trips wenyan exactly (null notation + heterogeneous optional cause fields)', async () => {
    // wenyan exercises: notation:null (must stay null), causeCategories mixing
    // present/absent variant_targetable, and `other` omitting description entirely
    // (absent optionals must be OMITTED, not emitted as `undefined`). toStrictEqual
    // catches any accidental `key: undefined` (toEqual would mask it).
    const result = await roundTrip(wenyanProfile);
    expect(result).toStrictEqual(wenyanProfile);
  });

  it('round-trips physics exactly (non-null nullable notation:"katex")', async () => {
    const result = await roundTrip(physicsProfile);
    expect(result).toStrictEqual(physicsProfile);
  });

  it('round-trips math as a regression smoke', async () => {
    const result = await roundTrip(mathProfile);
    expect(result).toStrictEqual(mathProfile);
  });

  it('emits the verified plain-literal form (header + plain export const, no satisfies/as const)', () => {
    const source = serializeProfileToTs(wenyanProfile);
    expect(source).toContain("import type { SubjectProfile } from '../profile';");
    expect(source).toContain('export const wenyanProfile: SubjectProfile = {');
    expect(source).not.toContain('satisfies');
    expect(source).not.toContain('as const');
  });

  it('passes the input version through verbatim (Q7 — no auto-bump)', () => {
    const source = serializeProfileToTs({ ...physicsProfile, version: '3.7.1' });
    expect(source).toContain('version: "3.7.1"');
  });
});
