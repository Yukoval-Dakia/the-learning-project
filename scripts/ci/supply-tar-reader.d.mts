export interface ExtractedEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  linkTarget?: string;
}
export function extractDeterministicTar(
  tarPath: string,
  destRoot: string,
): Promise<ExtractedEntry[]>;
