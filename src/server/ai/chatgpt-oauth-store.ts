/**
 * File-backed credential store for the `openai` ChatGPT-login lane (YUK-1806
 * scope addition). pi-ai only ships an in-memory store; OAuth refresh rotates
 * the credential and persists through `credentials.modify`, so this store
 * writes the credential back to its JSON file (same `{provider: cred}` shape
 * pi's own `auth.json` uses). Only the worker may hold the file read-write;
 * every other consumer must not mount it at all.
 *
 * Concurrency: pi-ai does NOT lock the file. All access here funnels through a
 * single in-process promise chain, so concurrent task runs in one worker
 * serialise reads+refreshes+write-backs. Cross-process safety is by deploy
 * rule (one r/w holder), not by this module.
 */
import { promises as fs } from 'node:fs';

import type { Credential, OAuthCredential } from '@earendil-works/pi-ai';

type CredentialLike = Credential;
type OAuthCredentialLike = OAuthCredential & { [key: string]: unknown };

export class ChatGPTOAuthFileError extends Error {
  constructor(
    public readonly reason:
      | 'missing_file'
      | 'invalid_json'
      | 'missing_openai_credential'
      | 'write_failed'
      | 'refresh_timeout',
    detail: string,
  ) {
    super(`openai ChatGPT-login credential file error (${reason}): ${detail}`);
    this.name = 'ChatGPTOAuthFileError';
  }
}

// One chain per path; concurrent runs share the file through it.
const fileMutexByPath = new Map<string, Promise<unknown>>();

function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = fileMutexByPath.get(path) ?? Promise.resolve();
  const next = tail.then(fn, fn);
  fileMutexByPath.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}

async function readAuthFile(path: string): Promise<Record<string, CredentialLike>> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    throw new ChatGPTOAuthFileError('missing_file', `cannot read ${path}`);
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    throw new ChatGPTOAuthFileError('invalid_json', `${path} is not valid JSON`);
  }
}

async function writeAuthFile(path: string, auth: Record<string, CredentialLike>): Promise<void> {
  // Crash-safe write: a refresh may have already rotated the refresh token, so
  // truncating the file in place could leave a corrupt credential on kill —
  // write-temp-fsync-rename is atomic on POSIX. 0600 because the content is a
  // live credential (chmod is applied before the rename lands).
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(auth, null, 2), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw new ChatGPTOAuthFileError('write_failed', `${path}: ${(e as Error).message}`);
  }
}

/** Loads the `openai` OAuth credential from the file — never logged. */
export async function loadChatGPTCredential(
  path: string,
): Promise<OAuthCredentialLike | undefined> {
  const auth = await readAuthFile(path);
  const cred = auth.openai as OAuthCredentialLike | undefined;
  if (cred?.type !== 'oauth' || typeof cred.access !== 'string') {
    throw new ChatGPTOAuthFileError(
      'missing_openai_credential',
      `${path} has no openai OAuth entry`,
    );
  }
  return cred;
}

/**
 * Minimal CredentialStore: file-backed for `openai`, in-memory otherwise.
 * `modify` persists the whole auth map back so a refreshed/rotated credential
 * survives the next run and process.
 */
const MODIFY_TIMEOUT_MS = 60_000;

export function createChatGPTCredentialStore(path: string) {
  const memory = new Map<string, CredentialLike>();
  let fileLoaded = false;
  // Reads the file entry inside the caller's mutex scope — the public `read`
  // re-queues on the same chain, so calling it from within `serialized` (e.g.
  // inside `modify`) would deadlock the lane.
  const readInsideLock = async (): Promise<CredentialLike | undefined> => {
    if (!fileLoaded) {
      const auth = await readAuthFile(path);
      if (auth.openai) memory.set('openai', auth.openai);
      fileLoaded = true;
    }
    return memory.get('openai');
  };
  return {
    async read(providerId: string): Promise<CredentialLike | undefined> {
      if (providerId !== 'openai') return memory.get(providerId);
      return serialized(path, readInsideLock);
    },
    async list() {
      const entries: Array<{ providerId: string; type: Credential['type'] }> = [];
      for (const [id, cred] of memory) entries.push({ providerId: id, type: cred.type });
      const openai = await this.read('openai');
      if (openai && !entries.some((e) => e.providerId === 'openai')) {
        entries.push({ providerId: 'openai', type: openai.type });
      }
      return entries;
    },
    async modify(
      providerId: string,
      fn: (current: CredentialLike | undefined) => Promise<CredentialLike | undefined>,
    ): Promise<CredentialLike | undefined> {
      if (providerId !== 'openai') {
        const next = await fn(memory.get(providerId));
        if (next !== undefined) memory.set(providerId, next);
        return next;
      }
      return serialized(path, async () => {
        const current = await readInsideLock();
        // Bound the mutation fn (pi's refresh makes a network call) so a hung
        // request can't hold the file mutex — and this whole lane — forever.
        const next = await Promise.race<CredentialLike | undefined>([
          fn(current),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  new ChatGPTOAuthFileError(
                    'refresh_timeout',
                    `credential mutation for '${providerId}' exceeded ${MODIFY_TIMEOUT_MS}ms`,
                  ),
                ),
              MODIFY_TIMEOUT_MS,
            ).unref(),
          ),
        ]);
        if (next !== undefined) {
          memory.set(providerId, next);
          const auth = await readAuthFile(path);
          auth[providerId] = next;
          await writeAuthFile(path, auth);
        }
        return next ?? current;
      });
    },
    async delete(providerId: string): Promise<void> {
      memory.delete(providerId);
    },
  };
}
