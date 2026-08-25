export class TarFormatError extends Error {}
export interface TarEntry {
  path: string;
  source: string;
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  linkTarget?: string;
}
export function collectTarEntries(rootDir: string, entryPrefix: string): Promise<TarEntry[]>;
export function writeDeterministicTar(
  outPath: string,
  entries: TarEntry[],
): Promise<{ sha256: string; bytes: number }>;
