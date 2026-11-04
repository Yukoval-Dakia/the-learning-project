/**
 * File-backed credential store for the `openai` ChatGPT-login lane (YUK-1806
 * scope addition). pi-ai only ships an in-memory store; OAuth refresh rotates
 * the credential and persists through `credentials.modify`, so this store
 * writes the credential back to its JSON file (same `{provider: cred}` shape
 * pi's own `auth.json` uses). Only the worker may hold the file read-write;
 * every other consumer must not mount it at all. Mount a DIRECTORY containing
 * the file, not a single-file bind mount — `rename(2)` can fail with EBUSY
 * against one-file bind mounts.
 *
 * Concurrency: pi-ai does NOT lock the file. All access here funnels through a
 * single in-process promise chain, so concurrent task runs in one worker
 * serialise reads+refreshes+write-backs. Cross-process safety is by deploy
 * rule (one r/w holder), not by this module.
 *
 * Durability rule: a failed write-back never overwrites the rotated credential
 * in memory — the dirty value is preferred over the file on every later access
 * and the write is retried until it lands or the process dies. A rotation that
 * cannot be persisted surfaces as a typed, loud error rather than reporting
 * success while the dead token lingers on disk.
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
      | 'not_oauth'
      | 'write_failed',
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

function readOpenAIEntry(path: string, auth: Record<string, CredentialLike>): OAuthCredentialLike {
  const cred = auth.openai as OAuthCredentialLike | undefined;
  if (cred === undefined) {
    throw new ChatGPTOAuthFileError('missing_openai_credential', `${path} has no openai entry`);
  }
  if (cred.type !== 'oauth') {
    // An api_key entry silently billed at API price — not the subscription.
    throw new ChatGPTOAuthFileError(
      'not_oauth',
      `${path} openai entry is '${cred.type}', expected 'oauth'`,
    );
  }
  if (typeof cred.access !== 'string' || cred.access.length === 0) {
    throw new ChatGPTOAuthFileError(
      'missing_openai_credential',
      `${path} openai oauth entry has no access token`,
    );
  }
  return cred;
}

async function writeAuthFile(path: string, auth: Record<string, CredentialLike>): Promise<void> {
  // Crash-safe write: a refresh may have already rotated the refresh token, so
  // truncating the file in place could leave a corrupt credential on kill —
  // write-temp-fsync-rename is atomic on POSIX. The temp file is created
  // exclusively with the existing file's mode from the start, so it never
  // carries broader permissions and a stale/predicted temp can't be hijacked.
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    const st = await fs.stat(path).catch(() => undefined);
    if (!st) throw new ChatGPTOAuthFileError('missing_file', `cannot stat ${path}`);
    let fh: Awaited<ReturnType<typeof fs.open>>;
    try {
      fh = await fs.open(tmp, 'wx', st.mode);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // A leftover temp from a crashed write is safe to replace — retry once.
        await fs.unlink(tmp);
        fh = await fs.open(tmp, 'wx', st.mode);
      } else {
        throw e;
      }
    }
    try {
      await fh.writeFile(JSON.stringify(auth, null, 2), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    if (e instanceof ChatGPTOAuthFileError) throw e;
    throw new ChatGPTOAuthFileError('write_failed', `${path}: ${(e as Error).message}`);
  }
}

/**
 * Minimal CredentialStore: file-backed for `openai`, in-memory otherwise.
 * `modify` persists the whole auth map back so a refreshed/rotated credential
 * survives the next run and process.
 */
export function createChatGPTCredentialStore(path: string) {
  const memory = new Map<string, CredentialLike>();
  // A credential whose rotation succeeded but whose write-back failed. It is
  // preferred over the file on every later access and the write is retried —
  // the old refresh token may already be dead, so falling back to the file
  // would silently un-rotate (and could revoke the login).
  let dirty: CredentialLike | undefined;

  // Reads the entry inside the caller's mutex scope — the public `read`
  // re-queues on the same chain, so calling it from within `serialized` (e.g.
  // inside `modify`) would deadlock the lane. The file is the single truth;
  // `dirty` is the only in-memory state allowed to beat it.
  const readInsideLock = async (): Promise<CredentialLike | undefined> => {
    if (dirty !== undefined) {
      const pending = dirty;
      try {
        const auth = await readAuthFile(path);
        auth.openai = pending;
        await writeAuthFile(path, auth);
        dirty = undefined;
      } catch (e) {
        // Persist failure stays loud — the credential is retained as dirty
        // but nothing may pretend the write-back succeeded.
        throw e instanceof ChatGPTOAuthFileError
          ? e
          : new ChatGPTOAuthFileError('write_failed', `${path}: ${(e as Error).message}`);
      }
      return pending;
    }
    const auth = await readAuthFile(path);
    const cred = readOpenAIEntry(path, auth);
    memory.set('openai', cred);
    return cred;
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
        // The lock is held until the mutation settles — abandoning a
        // late-successful refresh would drop a rotated refresh token (the old
        // one may already be dead upstream), which is a logout. pi threads the
        // request's AbortSignal into oauth.refresh, so the bound on a hung
        // refresh is the HTTP request's own timeout/abort, not this lock.
        const next = await fn(current);
        if (next !== undefined) {
          memory.set(providerId, next);
          // Mark dirty BEFORE any file op — a successful refresh followed by a
          // failed read/write must never let a later read reload the dead
          // token from disk.
          dirty = next;
          const auth = await readAuthFile(path);
          auth[providerId] = next;
          // A failed write leaves `next` dirty — retried on every later
          // access; the typed write_failed propagates loudly to the caller.
          await writeAuthFile(path, auth);
          dirty = undefined;
        }
        return next ?? current;
      });
    },
    async delete(providerId: string): Promise<void> {
      memory.delete(providerId);
      if (providerId !== 'openai') return;
      await serialized(path, async () => {
        dirty = undefined;
        try {
          const auth = await readAuthFile(path);
          if (auth.openai !== undefined) {
            delete auth.openai;
            await writeAuthFile(path, auth);
          }
        } catch (e) {
          if (e instanceof ChatGPTOAuthFileError && e.reason === 'missing_file') return;
          throw e;
        }
      });
    },
  };
}
