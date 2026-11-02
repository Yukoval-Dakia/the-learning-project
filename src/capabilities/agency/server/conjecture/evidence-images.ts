// Conjecture evidence image loading: resolve every referenced source asset to
// runner-ready image bytes under per-cell budgets. Budgets fail closed — an
// over-budget or partially loaded packet throws instead of dropping pixels, so
// the model never compares text against a truncated or misaligned image set.

import { inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { ConjectureEvidenceAssetRef, LoadedConjectureEvidenceImage } from './evidence';

/** N self-consistency samples per conjecture (Opus agreement tally). */
export const RESEARCH_MEETING_SAMPLES = 3;
/** Fail closed instead of silently dropping pixels from unusually image-heavy evidence. */
const RESEARCH_MEETING_MAX_IMAGES_PER_CELL = 60;
/** Base64 transport bytes across all self-consistency requests for one cell. */
const RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL = 24 * 1024 * 1024;
/** Decoded pixels across all self-consistency requests for one cell. */
const RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL = 40_000_000;

/** Resolves asset ids to base64 bytes in input order, skipping missing rows/objects. */
export type ConjectureImageFetchFn = (
  assetIds: string[],
  db: Db,
) => Promise<Array<{ data: string; mediaType: string }>>;

const RUNNER_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TRANSCODABLE_IMAGE_MIME_TYPES = new Set(['image/bmp']);

function base64TransportBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

interface EvidenceImageMetadata {
  id: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
}

function decodeUncompressedBmp(bytes: Buffer): {
  data: Buffer;
  width: number;
  height: number;
} {
  if (bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('invalid BMP header');
  }
  const pixelOffset = bytes.readUInt32LE(10);
  const dibSize = bytes.readUInt32LE(14);
  const width = bytes.readInt32LE(18);
  const signedHeight = bytes.readInt32LE(22);
  const planes = bytes.readUInt16LE(26);
  const bitsPerPixel = bytes.readUInt16LE(28);
  const compression = bytes.readUInt32LE(30);
  if (
    dibSize < 40 ||
    width <= 0 ||
    signedHeight === 0 ||
    planes !== 1 ||
    ![24, 32].includes(bitsPerPixel) ||
    compression !== 0
  ) {
    throw new Error('unsupported BMP encoding');
  }
  const height = Math.abs(signedHeight);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL) {
    throw new Error('BMP decoded-pixel limit exceeded');
  }
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  if (pixelOffset + rowStride * height > bytes.length) throw new Error('truncated BMP pixels');
  const channelsIn = bitsPerPixel / 8;
  const rgba = Buffer.allocUnsafe(pixels * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = signedHeight > 0 ? height - 1 - y : y;
    const rowStart = pixelOffset + sourceY * rowStride;
    for (let x = 0; x < width; x++) {
      const source = rowStart + x * channelsIn;
      const target = (y * width + x) * 4;
      rgba[target] = bytes[source + 2];
      rgba[target + 1] = bytes[source + 1];
      rgba[target + 2] = bytes[source];
      // BI_RGB 32-bit's fourth byte is reserved rather than a reliable alpha channel.
      rgba[target + 3] = 255;
    }
  }
  return { data: rgba, width, height };
}

function planConjectureEvidenceImageLoad(
  refs: readonly ConjectureEvidenceAssetRef[],
  metadata: readonly EvidenceImageMetadata[],
): {
  loadableRefs: ConjectureEvidenceAssetRef[];
  transcodeAssetIds: string[];
} {
  const byId = new Map(metadata.map((row) => [row.id, row]));
  const missing = [...new Set(refs.map((ref) => ref.asset_id))].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`conjecture evidence image metadata missing: ${missing.join(', ')}`);
  }

  const loadableRefs: ConjectureEvidenceAssetRef[] = [];
  const transcodeAssetIds = new Set<string>();
  const countedAssetIds = new Set<string>();
  let totalTransportBytes = 0;
  let totalPixels = 0;
  for (const ref of refs) {
    const row = byId.get(ref.asset_id) as EvidenceImageMetadata;
    if (
      !RUNNER_IMAGE_MIME_TYPES.has(row.mime_type) &&
      !TRANSCODABLE_IMAGE_MIME_TYPES.has(row.mime_type)
    ) {
      throw new Error(
        `conjecture evidence asset ${ref.asset_id} has unsupported MIME: ${row.mime_type}`,
      );
    }
    if (!RUNNER_IMAGE_MIME_TYPES.has(row.mime_type)) transcodeAssetIds.add(ref.asset_id);
    loadableRefs.push(ref);
    // One R2 object recurring across attempts is still one byte/pixel allocation.
    // Occurrence refs stay expanded for semantic ordering, but safety accounting follows
    // unique assets.
    if (!countedAssetIds.has(ref.asset_id)) {
      countedAssetIds.add(ref.asset_id);
      // Each unique image block is sent once per self-consistency request.
      totalTransportBytes += base64TransportBytes(row.byte_size) * RESEARCH_MEETING_SAMPLES;
      if (row.width !== null && row.height !== null) {
        if (
          !Number.isInteger(row.width) ||
          !Number.isInteger(row.height) ||
          row.width <= 0 ||
          row.height <= 0
        ) {
          throw new Error(
            `conjecture evidence asset ${ref.asset_id} has invalid dimensions: ${row.width}x${row.height}`,
          );
        }
        if (row.width > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL / row.height) {
          throw new Error(
            `conjecture evidence asset ${ref.asset_id} has more pixels than the safety limit`,
          );
        }
        totalPixels += row.width * row.height * RESEARCH_MEETING_SAMPLES;
      }
    }
  }
  if (totalTransportBytes > RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL) {
    throw new Error(
      `conjecture evidence images total ${totalTransportBytes} base64 bytes; max is ${RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL}`,
    );
  }
  if (totalPixels > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL) {
    throw new Error(
      `conjecture evidence images total ${totalPixels} pixels; max is ${RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL}`,
    );
  }
  return { loadableRefs, transcodeAssetIds: [...transcodeAssetIds] };
}

export async function loadConjectureEvidenceImages(
  db: Db,
  refs: readonly ConjectureEvidenceAssetRef[],
  imageFetchFn: ConjectureImageFetchFn,
): Promise<LoadedConjectureEvidenceImage[]> {
  if (refs.length === 0) return [];
  if (refs.length > RESEARCH_MEETING_MAX_IMAGES_PER_CELL) {
    throw new Error(
      `conjecture evidence has ${refs.length} images; max is ${RESEARCH_MEETING_MAX_IMAGES_PER_CELL}`,
    );
  }
  const assetIds = [...new Set(refs.map((ref) => ref.asset_id))];
  const metadata = await db
    .select({
      id: source_asset.id,
      mime_type: source_asset.mime_type,
      byte_size: source_asset.byte_size,
      width: source_asset.width,
      height: source_asset.height,
    })
    .from(source_asset)
    .where(inArray(source_asset.id, assetIds));
  const { loadableRefs, transcodeAssetIds } = planConjectureEvidenceImageLoad(refs, metadata);
  if (loadableRefs.length === 0) return [];
  // Download/base64 each R2 object once; the same diagram can recur across attempts.
  const uniqueAssetIds = [...new Set(loadableRefs.map((ref) => ref.asset_id))];
  const fetched = await imageFetchFn(uniqueAssetIds, db);
  // The fetcher preserves input order but skips missing DB/R2 rows. A partial
  // packet would let the model compare text against the wrong image index, so fail the
  // cell rather than guessing which asset was absent.
  if (fetched.length !== uniqueAssetIds.length) {
    throw new Error(
      `conjecture evidence image load incomplete: expected ${uniqueAssetIds.length}, got ${fetched.length}`,
    );
  }
  const metadataById = new Map(metadata.map((row) => [row.id, row]));
  const transcodeIds = new Set(transcodeAssetIds);
  const fetchedByAssetId = new Map<string, { data: string; mediaType: string }>();
  let sharpModule: typeof import('sharp') | null = null;
  let actualTransportBytes = 0;
  let actualPixels = 0;
  for (const [index, assetId] of uniqueAssetIds.entries()) {
    const image = fetched[index];
    const expected = metadataById.get(assetId);
    if (!expected || image.mediaType !== expected.mime_type) {
      throw new Error(`conjecture evidence image MIME changed after preflight for ${assetId}`);
    }
    const sourceBytes = Buffer.from(image.data, 'base64');
    let prepared: { data: string; mediaType: string };
    let decodedPixels: number;
    if (transcodeIds.has(assetId)) {
      sharpModule ??= await import('sharp');
      const bmp = image.mediaType === 'image/bmp' ? decodeUncompressedBmp(sourceBytes) : undefined;
      if (
        bmp !== undefined &&
        ((expected.width !== null && expected.width !== bmp.width) ||
          (expected.height !== null && expected.height !== bmp.height))
      ) {
        throw new Error(
          `conjecture evidence BMP dimensions changed after preflight for ${assetId}`,
        );
      }
      if (bmp === undefined) {
        throw new Error(`conjecture evidence image decoder missing for ${assetId}`);
      }
      const png = await sharpModule
        .default(bmp.data, {
          raw: { width: bmp.width, height: bmp.height, channels: 4 },
        })
        .png()
        .toBuffer();
      decodedPixels = bmp.width * bmp.height;
      prepared = {
        data: png.toString('base64'),
        mediaType: 'image/png',
      };
    } else {
      if (!RUNNER_IMAGE_MIME_TYPES.has(image.mediaType)) {
        throw new Error(`conjecture evidence image MIME unsupported for ${assetId}`);
      }
      sharpModule ??= await import('sharp');
      const decoded = await sharpModule
        .default(sourceBytes, {
          animated: true,
          failOn: 'error',
          limitInputPixels: RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL,
        })
        .metadata();
      const width = decoded.width;
      const height = decoded.pageHeight ?? decoded.height;
      const pages = decoded.pages ?? 1;
      if (
        width === undefined ||
        height === undefined ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        !Number.isInteger(pages) ||
        width <= 0 ||
        height <= 0 ||
        pages <= 0
      ) {
        throw new Error(`conjecture evidence image dimensions unreadable for ${assetId}`);
      }
      decodedPixels = width * height * pages;
      prepared = image;
    }
    actualTransportBytes += Buffer.byteLength(prepared.data, 'utf8') * RESEARCH_MEETING_SAMPLES;
    actualPixels += decodedPixels * RESEARCH_MEETING_SAMPLES;
    if (actualTransportBytes > RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL) {
      throw new Error(
        `conjecture evidence images total ${actualTransportBytes} actual base64 bytes; max is ${RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL}`,
      );
    }
    if (actualPixels > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL) {
      throw new Error(
        `conjecture evidence images total ${actualPixels} actual pixels; max is ${RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL}`,
      );
    }
    fetchedByAssetId.set(assetId, prepared);
  }
  return uniqueAssetIds.map((assetId) => {
    const image = fetchedByAssetId.get(assetId);
    if (!image) throw new Error(`conjecture evidence prepared image missing ${assetId}`);
    return {
      asset_id: assetId,
      occurrences: loadableRefs
        .filter((ref) => ref.asset_id === assetId)
        .map(({ attempt_event_id, source }) => ({ attempt_event_id, source })),
      ...image,
    };
  });
}
