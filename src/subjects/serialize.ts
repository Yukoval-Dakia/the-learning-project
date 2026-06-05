import type { SubjectProfile } from './profile-schema';

// U7 (YUK-203) — profile → TS-literal serializer (serialize-to-ts only; Q4/Q5).
// Pure function, no IO: it returns the full `profile.ts` source text as a string.
// The actual file write lives in the caller (the compile CLI `--write` path), which
// is gated on `validateProfile` passing first (RL7) — the serializer itself never
// touches the filesystem.
//
// Output form mirrors the verified live `profile.ts` shape (§0.1): a PLAIN object
// literal (`export const ${id}Profile: SubjectProfile = {…}`), NOT `satisfies`, NOT
// `as const`, with the `import type { SubjectProfile } from '../profile';` header.
//
// Round-trip fidelity rules (Cross-统合 M2):
//   - String values are wrapped via JSON.stringify so the Chinese long strings in
//     languageStyle / promptFragments / causeCategory labels round-trip without
//     escape-precision loss.
//   - Optional keys that are `undefined` / absent are OMITTED entirely — never
//     emitted as `key: undefined`, never defaulted. (CauseCategoryDeclaration has
//     four heterogeneously-used optional fields; the live profiles mix their
//     presence, so emitting `undefined` would break strict round-trip equality.)
//   - `null` is a distinct value and is emitted as-is (renderConfig.notation /
//     code_highlight are nullable; null stays null, a string stays the string).
//   - `version` is passed through from the input profile; the serializer never
//     computes or bumps it (Q7 — the CLI suggests, the author hand-fills).

function indent(depth: number): string {
  return '  '.repeat(depth);
}

// Serialize an arbitrary JSON-shaped value (string / number / boolean / null /
// array / plain object) to a TS literal. `undefined` is the caller's signal to
// OMIT the key (handled in serializeObject), so it must never reach here as a value.
function serializeValue(value: unknown, depth: number): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return serializeArray(value, depth);
  }
  if (typeof value === 'object') {
    return serializeObject(value as Record<string, unknown>, depth);
  }
  // `undefined` / function / symbol must never appear in a parsed SubjectProfile.
  throw new Error(`serializeProfileToTs: unserializable value of type ${typeof value}`);
}

function serializeArray(value: unknown[], depth: number): string {
  if (value.length === 0) {
    return '[]';
  }
  const inner = indent(depth + 1);
  const items = value.map((item) => `${inner}${serializeValue(item, depth + 1)}`);
  return `[\n${items.join(',\n')},\n${indent(depth)}]`;
}

function serializeObject(value: Record<string, unknown>, depth: number): string {
  const inner = indent(depth + 1);
  const lines: string[] = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    // Omit absent/undefined optional keys (M2) — never emit `key: undefined`.
    if (fieldValue === undefined) {
      continue;
    }
    lines.push(`${inner}${key}: ${serializeValue(fieldValue, depth + 1)}`);
  }
  if (lines.length === 0) {
    return '{}';
  }
  return `{\n${lines.join(',\n')},\n${indent(depth)}}`;
}

export function serializeProfileToTs(profile: SubjectProfile): string {
  const literal = serializeObject(profile as Record<string, unknown>, 0);
  return `import type { SubjectProfile } from '../profile';\n\nexport const ${profile.id}Profile: SubjectProfile = ${literal};\n`;
}
