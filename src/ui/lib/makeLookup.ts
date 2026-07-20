export function makeLookup<T>(map: Readonly<Record<string, T>>, fallback: T): (key: string) => T {
  return (key) => map[key] ?? fallback;
}
