import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiError } from '@/server/http/errors';

// YUK-258 — DOCX converter seam. ALL external-process conversion is收口在此文件;
// the rest of the docx pipeline is engine-agnostic. Three-state resolution:
//
//   1. 生产 (NAS 容器): the Dockerfile apt-installs pandoc + libreoffice into the
//      runner image. `which pandoc` / `which soffice` hit → spawn the binary直接.
//   2. 本地 dev: binary probe misses → `docker run` fallback (pandoc/core +
//      linuxserver/libreoffice images, both pulled locally).
//   3. 测试: inject a mock DocxConverter (returns pre-converted fixtures). NO real
//      spawn / docker — enforced by convert.test.ts + route.test.ts seam mocks.
//
// This module is imported ONLY by the docx route + the docx session owner — NEVER
// by the pg-boss worker bundle (same discipline as pdf-render.ts), so build:worker
// stays untouched.

export interface DocxMedia {
  /** Relative media path as referenced from the markdown (e.g. "media/image1.png"). */
  path: string;
  bytes: Uint8Array;
}

export interface DocxConverter {
  /** 文本线: docx → gfm markdown + embedded media (pandoc --extract-media). */
  docxToMarkdown(input: Uint8Array): Promise<{ markdown: string; media: DocxMedia[] }>;
  /** 两线都用: docx → PDF bytes (visual-line main path + text-line evidence pages). */
  docxToPdf(input: Uint8Array): Promise<Uint8Array>;
}

// LibreOffice冷启 (profile init + font scan) is slow — wider than the PDF 30s
// guard. pandoc is fast but shares the bound for uniformity.
const CONVERT_TIMEOUT_MS = 60_000;

// Docker fallback image tags (本地 dev). The `--entrypoint soffice` override is
// MANDATORY for libreoffice — the image's default entrypoint is a GUI init that
// hangs in headless docker run.
const DOCKER_PANDOC_IMAGE = 'pandoc/core:latest';
const DOCKER_LIBREOFFICE_IMAGE = 'linuxserver/libreoffice:latest';

// Process-level probe cache — `which` runs once per process.
let cachedBinaries: { pandoc: boolean; soffice: boolean } | null = null;

async function probeBinaries(): Promise<{ pandoc: boolean; soffice: boolean }> {
  if (cachedBinaries) return cachedBinaries;
  const [pandoc, soffice] = await Promise.all([onPath('pandoc'), onPath('soffice')]);
  cachedBinaries = { pandoc, soffice };
  return cachedBinaries;
}

function onPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [bin], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// Test-only override: `DOCX_CONVERT_ENGINE=docker` forces the docker fallback in
// dev even when binaries are on PATH (NOT an on/off feature gate — purely a seam
// probe override). Unset → automatic binary→docker resolution.
function forceDocker(): boolean {
  return process.env.DOCX_CONVERT_ENGINE === 'docker';
}

interface SpawnResult {
  stderr: string;
  code: number | null;
}

/**
 * Spawn an external converter in an optional cwd (pandoc reads/writes files
 * relative to it). Bounds the whole run by CONVERT_TIMEOUT_MS; on timeout kills
 * the WHOLE process group (detached + process.kill(-pid)) so a派生 soffice child
 * can't linger as a zombie. Rejects with ApiError(400) on timeout.
 *
 * Conversion I/O is file-based (in.docx / out.md / in.pdf on disk), so we don't
 * pipe bytes through stdin/stdout — we only need exit code + stderr.
 */
function runProcess(cmd: string, args: string[], opts?: { cwd?: string }): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    // detached so the child gets its own process group → we can kill the whole
    // tree (soffice forks children) with process.kill(-pid).
    const child = spawn(cmd, args, { detached: true, cwd: opts?.cwd });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // group may already be gone; fall through.
        }
      }
      reject(
        new ApiError(
          'validation_error',
          `DOCX 转换超时（${Math.round(CONVERT_TIMEOUT_MS / 1000)}s），请尝试更小的文件`,
          400,
        ),
      );
    }, CONVERT_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stderr, code });
    });
    child.stdin?.end();
  });
}

// File mode honouring umask (project rule: never hardcode 0o644).
const FILE_MODE = 0o666 & ~process.umask(process.umask());

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'yuk258-docx-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- pandoc: docx → gfm markdown + media ----------

async function pandocToMarkdown(
  docxBytes: Uint8Array,
  useDocker: boolean,
): Promise<{ markdown: string; media: DocxMedia[] }> {
  return withTmpDir(async (dir) => {
    const inPath = join(dir, 'in.docx');
    const mdPath = join(dir, 'out.md');
    await fs.writeFile(inPath, docxBytes, { mode: FILE_MODE });

    // --extract-media writes images under <dir>/media; markdown references them
    // relative to the output dir.
    const args = useDocker
      ? [
          'run',
          '--rm',
          '-v',
          `${dir}:/data`,
          '-w',
          '/data',
          DOCKER_PANDOC_IMAGE,
          'in.docx',
          '-t',
          'gfm',
          '--extract-media=.',
          '-o',
          'out.md',
        ]
      : ['in.docx', '-t', 'gfm', '--extract-media=.', '-o', 'out.md'];
    const cmd = useDocker ? 'docker' : 'pandoc';
    // For the binary path, run inside the tmpdir so relative in.docx / out.md
    // resolve; docker mounts the dir at /data with -w, so no cwd needed there.
    const opts = useDocker ? undefined : { cwd: dir };

    const result = await runProcess(cmd, args, opts);
    if (result.code !== 0) {
      throw new ApiError(
        'validation_error',
        `DOCX→markdown 转换失败（pandoc exit ${result.code})`,
        400,
      );
    }

    const markdown = await fs.readFile(mdPath, 'utf-8');
    const media = await collectMedia(join(dir, 'media'));
    return { markdown, media };
  });
}

async function collectMedia(mediaDir: string): Promise<DocxMedia[]> {
  let names: string[];
  try {
    names = await fs.readdir(mediaDir);
  } catch {
    return []; // no embedded media
  }
  const out: DocxMedia[] = [];
  for (const name of names.sort()) {
    const full = join(mediaDir, name);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    const bytes = new Uint8Array(await fs.readFile(full));
    // Path as the markdown references it: pandoc emits `media/<name>` (or an
    // <img src="media/<name>"> when the OOXML drawing carries explicit dims).
    out.push({ path: `media/${name}`, bytes });
  }
  return out;
}

// ---------- LibreOffice: docx → PDF ----------

async function libreOfficeToPdf(docxBytes: Uint8Array, useDocker: boolean): Promise<Uint8Array> {
  return withTmpDir(async (dir) => {
    const inPath = join(dir, 'in.docx');
    await fs.writeFile(inPath, docxBytes, { mode: FILE_MODE });

    const args = useDocker
      ? [
          'run',
          '--rm',
          // MANDATORY: default entrypoint is a GUI init that hangs headless.
          '--entrypoint',
          'soffice',
          '-v',
          `${dir}:/data`,
          DOCKER_LIBREOFFICE_IMAGE,
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          '/data',
          '/data/in.docx',
        ]
      : ['--headless', '--convert-to', 'pdf', '--outdir', dir, inPath];
    const cmd = useDocker ? 'docker' : 'soffice';

    const result = await runProcess(cmd, args);
    const pdfPath = join(dir, 'in.pdf');
    // soffice can exit 0 yet not produce a file on some failures; assert the file.
    let pdfBytes: Uint8Array;
    try {
      pdfBytes = new Uint8Array(await fs.readFile(pdfPath));
    } catch {
      throw new ApiError(
        'validation_error',
        `DOCX→PDF 转换失败（LibreOffice 未产出 PDF, exit ${result.code})`,
        400,
      );
    }
    return pdfBytes;
  });
}

// ---------- default converter (binary → docker resolution) ----------

class DefaultDocxConverter implements DocxConverter {
  async docxToMarkdown(input: Uint8Array): Promise<{ markdown: string; media: DocxMedia[] }> {
    const { pandoc } = await probeBinaries();
    const useDocker = forceDocker() || !pandoc;
    return pandocToMarkdown(input, useDocker);
  }

  async docxToPdf(input: Uint8Array): Promise<Uint8Array> {
    const { soffice } = await probeBinaries();
    const useDocker = forceDocker() || !soffice;
    return libreOfficeToPdf(input, useDocker);
  }
}

let override: DocxConverter | null = null;

/**
 * Test seam: inject a mock converter (returns pre-converted fixtures). Pass null
 * to restore the default binary→docker resolver. NEVER called in production.
 */
export function setDocxConverterForTests(converter: DocxConverter | null): void {
  override = converter;
}

export function getDocxConverter(): DocxConverter {
  return override ?? new DefaultDocxConverter();
}

// Exported for unit tests (timeout bound assertion). The converter itself is
// exercised via injected mocks — no real spawn in the test partition.
export { CONVERT_TIMEOUT_MS };
