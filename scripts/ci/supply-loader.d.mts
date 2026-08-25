export class LoaderIntegrityError extends Error {}
export function verifyLoaderTarball(fields: {
  tarballPath: string;
  expectedIntegrity: string;
}): Promise<string>;
export function extractLoaderTarball(fields: {
  tarballPath: string;
  extractRoot: string;
}): Promise<string>;
