import type { SubjectProfile } from './profile-schema';

// Serializes a profile to TS source; pure, no IO. The caller writes the file and
// gates on validateProfile. Output is a plain object literal so it round-trips:
// strings use JSON.stringify, absent optional keys are omitted (never
// `key: undefined`), null stays null, and version is passed through untouched.

function indent(depth: number): string {
  return '  '.repeat(depth);
}

// undefined means "omit the key" and is handled by serializeObject, so it never
// reaches a value here.
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
    // Absent keys are omitted, never emitted as undefined.
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
