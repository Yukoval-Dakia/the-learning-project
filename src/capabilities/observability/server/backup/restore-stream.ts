/**
 * Streaming half of backup restore: pull the archive bytes once, fan each ZIP
 * entry out to a bounded-memory sink, and verify integrity against the central
 * directory before any database write begins.
 *
 * Two invariants shape the design:
 *  - CRC is verified here because nothing upstream does it: fflate verifies
 *    CRC nowhere — not in streaming Unzip and not in unzipSync (both trust
 *    the central directory and inflate structure only). Each entry's bytes are
 *    rolled through a local CRC32 and compared with the central directory
 *    parsed from the stream tail, so corruption and truncation that would
 *    silently produce wrong rows are rejected instead.
 *  - data.json is parsed with a bounded incremental extractor, not JSON.parse:
 *    the archive can exceed the heap, so only one row's text is resident at a
 *    time. Row text is captured by balanced scanning, then parsed — any JSON
 *    formatting a producer emits is handled identically.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Unzip, type UnzipFile, UnzipInflate, UnzipPassThrough } from 'fflate';

export type ArchiveSource = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** Normalize the accepted archive inputs into one async-chunk shape. */
async function* toChunks(source: ArchiveSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    yield* source;
  }
}

// ─── CRC32 (IEEE 802.3, table-driven) ────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = crc ^ -1;
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ─── Stream tail + central directory ─────────────────────────────────────────
//
// The last 256 KiB of the stream is retained so the end-of-central-directory
// record and the whole central directory can be parsed without a second pass
// over the file. Larger trailing comments are refused rather than buffered
// wholesale; at the 1 GB upload cap every archive this route accepts keeps its
// directory well inside the window.

const TAIL_BYTES = 256 * 1024;
const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
// Spill rows to disk per drain batch, not per row — one table costs a handful
// of syscalls over the whole restore.
const ROW_FLUSH_BYTES = 4 * 1024 * 1024;

interface CentralRecord {
  name: string;
  crc: number;
  uncompressedSize: number;
}

class TailBuffer {
  private buf = Buffer.allocUnsafe(TAIL_BYTES);
  private len = 0;
  private total = 0;

  append(chunk: Uint8Array): void {
    this.total += chunk.length;
    if (chunk.length >= TAIL_BYTES) {
      this.buf.set(chunk.subarray(chunk.length - TAIL_BYTES));
      this.len = TAIL_BYTES;
      return;
    }
    const spill = this.len + chunk.length - TAIL_BYTES;
    if (spill > 0) this.buf.copyWithin(0, spill, this.len);
    this.buf.set(chunk, this.len - Math.max(0, spill));
    this.len = Math.min(TAIL_BYTES, this.len + chunk.length);
  }

  /** Central directory records parsed from the retained tail. */
  centralDirectory(): CentralRecord[] | 'truncated' | 'zip64' {
    const tail = this.buf.subarray(0, this.len);
    let eocd = -1;
    // EOCD: 4-byte signature + 18-byte fixed body + up to 64 KiB comment.
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return 'truncated';
    const cdEntries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      return 'zip64';
    }
    // The directory sits immediately before the EOCD inside the file.
    const cdStartInTail = tail.length - (this.total - cdOffset);
    if (cdStartInTail < 0 || cdStartInTail + cdSize > tail.length) return 'truncated';
    const records: CentralRecord[] = [];
    let pos = cdStartInTail;
    for (let i = 0; i < cdEntries; i++) {
      if (pos + 46 > tail.length || tail.readUInt32LE(pos) !== CDFH_SIG) return 'truncated';
      const crc = tail.readUInt32LE(pos + 16);
      const compSize = tail.readUInt32LE(pos + 20);
      const uncompSize = tail.readUInt32LE(pos + 24);
      if (compSize === 0xffffffff || uncompSize === 0xffffffff) return 'zip64';
      const nameLen = tail.readUInt16LE(pos + 28);
      const extraLen = tail.readUInt16LE(pos + 30);
      const commentLen = tail.readUInt16LE(pos + 32);
      const name = tail.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      records.push({ name, crc, uncompressedSize: uncompSize });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return records;
  }
}

// ─── data.json incremental extractor ─────────────────────────────────────────
//
// Grammar: `{ "table": [ <value>, <value>, ... ], ... }` over a chunked text
// stream. Rows are captured as balanced JSON text and handed to the caller for
// JSON.parse; non-array table values are consumed structurally without
// retention so their size cannot matter.

export interface DataJsonEvents {
  onTable(key: string): void;
  onRow(key: string, index: number, row: unknown): void;
  onTableEnd(key: string): void;
  onNotArray(key: string): void;
}

export class InvalidDataJson extends Error {}
/** The document parsed as valid JSON but is not a table-keyed object. */
export class InvalidDataShape extends Error {}

type TokState =
  | 'expectDocStart'
  | 'scalarDoc'
  | 'expectFirstKeyOrEnd'
  | 'expectKey'
  | 'expectColon'
  | 'expectValue'
  | 'expectFirstElemOrEnd'
  | 'expectElem'
  | 'afterElem'
  | 'afterEntry'
  | 'finished';

class DataJsonExtractor {
  private buf = '';
  private pos = 0;
  private state: TokState = 'expectDocStart';
  private key = '';
  private elemIndex = 0;
  private eof = false;
  private readonly events: DataJsonEvents;

  constructor(events: DataJsonEvents) {
    this.events = events;
  }

  feed(text: string): void {
    this.buf += text;
    this.drain();
  }

  /** Mark end of input; anything left incomplete is malformed. */
  finish(): void {
    this.eof = true;
    this.drain();
    if (this.state !== 'finished' || this.buf.slice(this.pos).trim() !== '') {
      throw new InvalidDataJson('data.json is not valid JSON');
    }
  }

  private error(): never {
    throw new InvalidDataJson('data.json is not valid JSON');
  }

  private skipWs(): 'ok' | 'need' {
    for (;;) {
      if (this.pos >= this.buf.length) {
        // Nothing left unconsumed; drop the dead prefix so long whitespace
        // runs cannot grow the buffer while more input is pending.
        if (!this.cap && this.pos > 0) {
          this.buf = '';
          this.pos = 0;
        }
        return this.eof ? 'ok' : 'need';
      }
      const c = this.buf[this.pos];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') this.pos++;
      else {
        // Drop the consumed prefix once it is large; never while a value
        // capture is mid-flight, since cap.i indexes into the same buffer.
        if (!this.cap && this.pos > 1 << 20) {
          this.buf = this.buf.slice(this.pos);
          this.pos = 0;
        }
        return 'ok';
      }
    }
  }

  /** Consume a JSON string token starting at `"`; returns the decoded text. */
  private scanString(): { done: false } | { done: true; text: string } {
    let i = this.pos + 1;
    for (;;) {
      if (i >= this.buf.length) return this.eof ? this.error() : { done: false };
      const c = this.buf[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') {
        const raw = this.buf.slice(this.pos, i + 1);
        let text: string;
        try {
          text = JSON.parse(raw) as string;
        } catch {
          this.error();
        }
        this.pos = i + 1;
        return { done: true, text };
      }
      i++;
    }
  }

  /**
   * Capture one complete JSON value starting at `pos`. Output is the exact
   * source text; with `retain=false` only the boundaries are consumed.
   * The scan keeps its own cursor so an incomplete value resumes where it
   * stopped instead of rescanning from the value start on every feed.
   */
  private cap: {
    i: number;
    depth: number;
    inStr: boolean;
    esc: boolean;
    literal: boolean;
  } | null = null;

  private capture(
    retain: boolean,
    eofCompletesLiteral = false,
    maxCapture = Number.POSITIVE_INFINITY,
  ): { done: false } | { done: true; text: string; overflow?: boolean } {
    const start = this.pos;
    if (!this.cap) {
      if (start >= this.buf.length) return this.eof ? this.error() : { done: false };
      const first = this.buf[start];
      // `{`/`[` scan by bracket depth, `"` by string termination under the
      // same rule (a bare string ends when inStr clears at depth 0); anything
      // else is a literal running to the next structural delimiter, with
      // malformed tokens left for the downstream JSON.parse to reject.
      this.cap = {
        i: start,
        depth: 0,
        inStr: false,
        esc: false,
        literal: !(first === '"' || first === '{' || first === '['),
      };
    }
    const c = this.cap;
    for (;;) {
      if (c.i >= this.buf.length) {
        if (this.eof) {
          // Only a document-level literal may end at EOF; inside the object an
          // unterminated value means the stream was truncated.
          if (eofCompletesLiteral && c.literal && c.i > start) {
            const text = this.buf.slice(start, c.i);
            this.pos = c.i;
            this.cap = null;
            return { done: true, text: retain ? text : '' };
          }
          this.error();
        }
        // A retained value that outgrew its cap ends the capture early: the
        // caller rejects the document, so the rest of the text is dead weight.
        if (retain && c.i - start > maxCapture) {
          this.cap = null;
          this.pos = c.i;
          return { done: true, text: '', overflow: true };
        }
        // A discarded value does not need its text kept: drop the consumed
        // prefix so the buffer stays bounded by what remains unread.
        if (!retain && c.i - start > 1 << 20) {
          this.buf = this.buf.slice(start);
          this.pos = 0;
          c.i -= start;
          return { done: false };
        }
        return { done: false };
      }
      const ch = this.buf[c.i];
      if (c.literal) {
        if (
          ch === ',' ||
          ch === ']' ||
          ch === '}' ||
          ch === ' ' ||
          ch === '\n' ||
          ch === '\t' ||
          ch === '\r'
        ) {
          const text = this.buf.slice(start, c.i);
          this.pos = c.i;
          this.cap = null;
          if (text.length === 0) this.error();
          return { done: true, text: retain ? text : '' };
        }
      } else {
        if (c.inStr) {
          if (c.esc) c.esc = false;
          else if (ch === '\\') c.esc = true;
          else if (ch === '"') c.inStr = false;
        } else if (ch === '"') c.inStr = true;
        else if (ch === '{' || ch === '[') c.depth++;
        else if (ch === '}' || ch === ']') c.depth--;
        if (!c.inStr && c.depth === 0 && c.i > start) {
          this.pos = c.i + 1;
          this.cap = null;
          return { done: true, text: retain ? this.buf.slice(start, this.pos) : '' };
        }
      }
      c.i++;
    }
  }

  private drain(): void {
    for (;;) {
      if (this.skipWs() === 'need') return;
      if (this.pos >= this.buf.length) return;
      switch (this.state) {
        case 'expectDocStart': {
          if (this.buf[this.pos] === '{') {
            this.pos++;
            this.state = 'expectFirstKeyOrEnd';
            break;
          }
          this.state = 'scalarDoc';
          break;
        }
        case 'scalarDoc': {
          // JSON.parse distinguishes "not JSON" from "valid JSON of the wrong
          // shape". The cap keeps a hostile scalar (a giant string or array)
          // from being buffered just to report that it was the wrong shape.
          const r = this.capture(true, true, 64 * 1024);
          if (!r.done) return;
          if (!r.overflow) {
            try {
              JSON.parse(r.text);
            } catch {
              this.error();
            }
          }
          throw new InvalidDataShape(
            'data.json must contain a table-keyed object; DB was NOT wiped.',
          );
        }
        case 'expectFirstKeyOrEnd': {
          const c = this.buf[this.pos];
          if (c === '}') {
            this.pos++;
            this.state = 'finished';
            break;
          }
          if (c !== '"') this.error();
          this.state = 'expectKey';
          break;
        }
        case 'expectKey': {
          if (this.buf[this.pos] !== '"') this.error();
          const r = this.scanString();
          if (!r.done) return;
          this.key = r.text;
          this.state = 'expectColon';
          break;
        }
        case 'expectColon': {
          if (this.buf[this.pos] !== ':') this.error();
          this.pos++;
          this.state = 'expectValue';
          break;
        }
        case 'expectValue': {
          if (this.buf[this.pos] === '[') {
            this.pos++;
            this.elemIndex = 0;
            this.events.onTable(this.key);
            this.state = 'expectFirstElemOrEnd';
            break;
          }
          // Non-array table value: still must be valid JSON (JSON.parse vetted
          // the whole document before). Retained only up to the cap — a bigger
          // foreign value cannot be validated and is refused as malformed.
          const r = this.capture(true, false, 64 * 1024);
          if (!r.done) return;
          if (r.overflow) this.error();
          try {
            JSON.parse(r.text);
          } catch {
            this.error();
          }
          this.events.onNotArray(this.key);
          this.state = 'afterEntry';
          break;
        }
        case 'expectFirstElemOrEnd': {
          if (this.buf[this.pos] === ']') {
            this.pos++;
            this.events.onTableEnd(this.key);
            this.state = 'afterEntry';
            break;
          }
          this.state = 'expectElem';
          break;
        }
        case 'expectElem': {
          const r = this.capture(true);
          if (!r.done) return;
          let row: unknown;
          try {
            row = JSON.parse(r.text);
          } catch {
            this.error();
          }
          this.events.onRow(this.key, this.elemIndex++, row);
          this.state = 'afterElem';
          break;
        }
        case 'afterElem': {
          const c = this.buf[this.pos];
          if (c === ',') {
            this.pos++;
            this.state = 'expectElem';
            break;
          }
          if (c === ']') {
            this.pos++;
            this.events.onTableEnd(this.key);
            this.state = 'afterEntry';
            break;
          }
          this.error();
          break;
        }
        case 'afterEntry': {
          const c = this.buf[this.pos];
          if (c === ',') {
            this.pos++;
            this.state = 'expectKey';
            break;
          }
          if (c === '}') {
            this.pos++;
            this.state = 'finished';
            break;
          }
          this.error();
          break;
        }
        case 'finished':
          return;
      }
    }
  }
}

// ─── Staging ─────────────────────────────────────────────────────────────────

export interface StagedTable {
  /** Spill file holding one JSON.stringify(row) per line. */
  path: string;
  rowCount: number;
  /** Set when the value under this key was not an array. */
  notArray: boolean;
}

export interface StagedAsset {
  key: string;
  path: string;
}

export interface StagedArchive {
  /** Temp dir the caller must release with cleanupStage. */
  dir: string;
  manifestBytes?: Uint8Array;
  dataJsonSeen: boolean;
  tables: Map<string, StagedTable>;
  assets: StagedAsset[];
}

export class ArchiveFormatError extends Error {}
export class ArchiveTooLargeError extends Error {}
/** The request body declared more bytes than the configured upload ceiling. */
export class UploadTooLargeError extends Error {}
export class EmptyArchiveError extends Error {}

export interface StageEvents {
  /** A table array opened under `key`. */
  onTable?(key: string): void;
  /** One fully parsed element of the open table array. */
  onRow?(key: string, index: number, row: unknown): void;
  /** The open table array closed. */
  onTableEnd?(key: string): void;
  /** A key whose value is not an array. */
  onNotArray?(key: string): void;
  /** A second data.json entry started; earlier table state must be discarded. */
  onDataJsonReset?(): void;
}

interface PendingTable {
  file: StagedTable;
  pending: string[];
  pendingBytes: number;
}

/**
 * Extract an archive in one pass: every entry is counted, CRC-rolled and sunk
 * to memory (manifest), per-table spill files (data.json rows), per-asset
 * files, or nowhere (report files). Integrity is verified against the central
 * directory after the stream ends.
 *
 * Throws ArchiveFormatError on any structural, integrity or JSON failure and
 * ArchiveTooLargeError when the extracted payload exceeds `maxExtractedBytes`.
 * All failures leave the database untouched — staging never opens a
 * transaction.
 */
const STAGE_DIR_PREFIX = 'loom-restore-';
// Older than this a spill dir can only be crash residue: a live restore keeps
// its dir for its whole run, and restores take minutes, not hours.
const STAGE_STALE_MS = 6 * 60 * 60 * 1000;

/** Best-effort GC for dirs a killed restore never got to remove. */
async function sweepStaleStageDirs(): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith(STAGE_DIR_PREFIX)) continue;
      const path = join(tmpdir(), name);
      const st = await stat(path).catch(() => null);
      if (st && now - st.mtimeMs > STAGE_STALE_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // A sweep failure must never block the restore that triggered it.
  }
}

export async function stageArchive(
  source: ArchiveSource,
  events: StageEvents,
  maxExtractedBytes: number,
): Promise<StagedArchive> {
  await sweepStaleStageDirs();
  const stageDir = await mkdtemp(join(tmpdir(), STAGE_DIR_PREFIX));
  const fail = async (err: unknown): Promise<never> => {
    await rm(stageDir, { recursive: true, force: true });
    throw err;
  };

  const staged: StagedArchive = {
    dir: stageDir,
    dataJsonSeen: false,
    tables: new Map(),
    assets: [],
  };

  const tail = new TailBuffer();
  const manifestChunks: Buffer[] = [];
  let manifestBytes = 0;
  let extractedBytes = 0;
  let inputBytes = 0;
  const entryResults = new Map<string, { crc: number; size: number; finished: boolean }>();
  const entryOrder: string[] = [];
  let currentTable: PendingTable | null = null;
  let tableSeq = 0;
  let assetSeq = 0;
  // Held in an object so assignments inside fflate callbacks are visible to
  // the type checker at the post-loop call site.
  const dataJson: { extractor: DataJsonExtractor | null } = { extractor: null };
  let currentAsset: {
    stream: ReturnType<typeof createWriteStream>;
    close: () => Promise<void>;
  } | null = null;
  const decoder = new TextDecoder('utf-8');
  // fflate invokes callbacks synchronously inside push(); a throw there is not
  // guaranteed to propagate, so failures park here and are raised between
  // pushes.
  let stageError: unknown = null;
  const flushQueue: Array<() => Promise<void>> = [];
  const drain = async () => {
    while (flushQueue.length > 0) {
      const job = flushQueue.shift();
      if (job) await job();
    }
  };

  const queueTableFlush = (table: PendingTable) => {
    if (table.pending.length === 0) return;
    const text = table.pending.join('');
    const path = table.file.path;
    table.pending.length = 0;
    table.pendingBytes = 0;
    flushQueue.push(() => appendFile(path, text));
  };

  const dataEvents: DataJsonEvents = {
    onTable(key) {
      // JSON.parse keeps the last duplicate key; a repeated key restarts the
      // spill file so later rows are the ones restored.
      const file: StagedTable = {
        path: join(stageDir, `table-${tableSeq++}.jsonl`),
        rowCount: 0,
        notArray: false,
      };
      staged.tables.set(key, file);
      currentTable = { file, pending: [], pendingBytes: 0 };
      events.onTable?.(key);
    },
    onRow(key, index, row) {
      if (!currentTable) {
        stageError = new InvalidDataJson('data.json is not valid JSON');
        return;
      }
      currentTable.file.rowCount++;
      let line: string;
      try {
        line = `${JSON.stringify(row)}\n`;
      } catch {
        stageError = new InvalidDataJson('data.json is not valid JSON');
        return;
      }
      currentTable.pending.push(line);
      currentTable.pendingBytes += line.length;
      if (currentTable.pendingBytes > ROW_FLUSH_BYTES) queueTableFlush(currentTable);
      events.onRow?.(key, index, row);
    },
    onTableEnd(key) {
      if (currentTable) queueTableFlush(currentTable);
      currentTable = null;
      events.onTableEnd?.(key);
    },
    onNotArray(key) {
      const file = staged.tables.get(key);
      if (file) file.notArray = true;
      else {
        staged.tables.set(key, {
          path: join(stageDir, `table-${tableSeq++}.jsonl`),
          rowCount: 0,
          notArray: true,
        });
      }
      events.onNotArray?.(key);
    },
  };

  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.register(UnzipPassThrough);

  uz.onfile = (file: UnzipFile) => {
    const name = file.name;
    const result = { crc: 0, size: 0, finished: false };
    entryResults.set(name, result);
    entryOrder.push(name);

    const isManifest = name === 'manifest.json';
    const isData = name === 'data.json';
    const isAsset = name.startsWith('assets/');

    if (isManifest) {
      // unzipSync semantics: a repeated entry name last-wins.
      manifestChunks.length = 0;
      manifestBytes = 0;
    }
    if (isData) {
      if (staged.dataJsonSeen) {
        // A duplicate data.json replaces whatever the first entry staged.
        if (currentTable) queueTableFlush(currentTable);
        currentTable = null;
        staged.tables.clear();
        events.onDataJsonReset?.();
      }
      staged.dataJsonSeen = true;
      dataJson.extractor = new DataJsonExtractor(dataEvents);
    } else if (isAsset) {
      const path = join(stageDir, `asset-${assetSeq++}.bin`);
      const stream = createWriteStream(path);
      // Never let a WriteStream error stall the flush queue: write callbacks
      // and close both resolve regardless, parking the first error in
      // stageError which the post-push check turns into a fail(). Waiting on
      // 'drain' deadlocks here because an errored stream never drains.
      stream.on('error', (err) => {
        stageError = stageError ?? err;
      });
      currentAsset = {
        stream,
        close: () =>
          new Promise<void>((resolve) => {
            if (stream.errored) {
              stageError = stageError ?? stream.errored;
              resolve();
              return;
            }
            stream.once('error', (err) => {
              stageError = stageError ?? err;
              resolve();
            });
            stream.end(() => resolve());
          }),
      };
      staged.assets.push({ key: name.slice('assets/'.length), path });
    }

    file.ondata = (err, chunk, final) => {
      if (stageError) return;
      try {
        if (err) throw new ArchiveFormatError(err.message);
        result.crc = crc32Update(result.crc, chunk);
        result.size += chunk.length;
        extractedBytes += chunk.length;
        if (extractedBytes > maxExtractedBytes) {
          throw new ArchiveTooLargeError('extracted payload exceeds the upload limit');
        }
        if (final) result.finished = true;

        if (isManifest) {
          manifestBytes += chunk.length;
          if (manifestBytes > MAX_MANIFEST_BYTES) {
            throw new ArchiveFormatError('manifest.json too large');
          }
          manifestChunks.push(Buffer.from(chunk));
        } else if (isData) {
          dataJson.extractor?.feed(decoder.decode(chunk, { stream: !final }));
          if (final) dataJson.extractor?.finish();
        } else if (isAsset && currentAsset) {
          const asset = currentAsset;
          const buf = Buffer.from(chunk);
          flushQueue.push(
            () =>
              new Promise<void>((resolve) => {
                // The write callback fires once on flush or on error — on an
                // errored stream it fires with the error — so the queue drains
                // either way. Errors park in stageError, not in this promise.
                asset.stream.write(buf, (err) => {
                  if (err) stageError = stageError ?? err;
                  resolve();
                });
              }),
          );
          if (final) {
            const closer = currentAsset;
            flushQueue.push(() => closer.close());
            currentAsset = null;
          }
        }
        // Report files (csvs/README) are sunk after the CRC roll — restore
        // never reads them, but integrity still covers them.
      } catch (e) {
        stageError = e;
      }
    };

    try {
      file.start();
    } catch (e) {
      stageError = new ArchiveFormatError(e instanceof Error ? e.message : String(e));
    }
  };

  try {
    for await (const chunk of toChunks(source)) {
      inputBytes += chunk.length;
      tail.append(chunk);
      try {
        uz.push(chunk, false);
      } catch (e) {
        throw new ArchiveFormatError(e instanceof Error ? e.message : String(e));
      }
      if (stageError) throw stageError;
      await drain();
    }
    if (inputBytes === 0) throw new EmptyArchiveError('empty body');
    try {
      uz.push(new Uint8Array(0), true);
    } catch (e) {
      throw new ArchiveFormatError(e instanceof Error ? e.message : String(e));
    }
    if (stageError) throw stageError;
    await drain();
    // A spill file's tail write only lands here when the table fit inside one
    // flush batch; larger tables were already flushed per batch above.
    if (currentTable) {
      queueTableFlush(currentTable);
      currentTable = null;
    }
    if (dataJson.extractor) dataJson.extractor.finish();
    await drain();
  } catch (e) {
    await fail(e);
  }

  // Anything the stream cut short is corrupt: an unterminated entry or a
  // missing end-of-central-directory both mean the archive is incomplete.
  for (const [name, r] of entryResults) {
    if (!r.finished) {
      await fail(new ArchiveFormatError(`truncated archive: entry "${name}" never completed`));
    }
  }

  const cd = tail.centralDirectory();
  if (cd !== 'truncated' && cd !== 'zip64' && cd.length === entryOrder.length) {
    const cdByName = new Map(cd.map((r) => [r.name, r]));
    for (const name of entryOrder) {
      const r = entryResults.get(name);
      const rec = cdByName.get(name);
      if (!r || !rec || rec.crc !== r.crc || rec.uncompressedSize !== r.size) {
        await fail(new ArchiveFormatError(`invalid zip data: corrupted entry "${name}"`));
      }
    }
  } else {
    await fail(
      new ArchiveFormatError(
        cd === 'zip64'
          ? 'invalid zip data: ZIP64 archives are not supported'
          : 'invalid zip data: central directory missing or does not match entries',
      ),
    );
  }

  if (manifestChunks.length > 0) {
    staged.manifestBytes = new Uint8Array(Buffer.concat(manifestChunks));
  }
  return staged;
}

export async function cleanupStage(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Line reader over a staged table file: yields each row's parsed object and its
 * staged line size, so insert batching can bound bytes, not only row count. */
export async function* readTableRows(
  path: string,
): AsyncGenerator<{ row: Record<string, unknown>; bytes: number }> {
  const stream = createReadStream(path, { encoding: 'utf-8' });
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk as string;
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) {
        yield { row: JSON.parse(line) as Record<string, unknown>, bytes: Buffer.byteLength(line) };
      }
      idx = buf.indexOf('\n');
    }
  }
  if (buf.trim().length > 0) {
    yield { row: JSON.parse(buf) as Record<string, unknown>, bytes: Buffer.byteLength(buf) };
  }
}
