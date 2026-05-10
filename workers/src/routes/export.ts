import { downloadZip } from 'client-zip';
import { Hono } from 'hono';
import { FK_ORDER, MAX_INLINE_ASSETS, SCHEMA_VERSION } from '../export/constants';
import { buildMistakesCsv, buildReviewEventsCsv } from '../export/csv';
import { type Manifest, buildReadme } from '../export/readme';
import type { AppEnv } from '../types';

export const exportRoute = new Hono<AppEnv>();

exportRoute.get('/', async (c) => {
  const includeAssets = c.req.query('include_assets') === '1';
  const exportedAt = Math.floor(Date.now() / 1000);

  const tableRows: Record<string, unknown[]> = {};
  const rowCounts: Record<string, number> = {};
  for (const t of FK_ORDER) {
    const result = await c.env.DB.prepare(`select * from ${t}`).all();
    tableRows[t] = result.results;
    rowCounts[t] = result.results.length;
  }

  type Entry = { name: string; input: string | ReadableStream; lastModified?: Date };
  const entries: Entry[] = [];

  const missingAssets: string[] = [];
  if (includeAssets) {
    const assets = tableRows.source_asset as Array<{ storage_key: string }>;
    if (assets.length > MAX_INLINE_ASSETS) {
      return c.json(
        {
          error: 'too_many_assets',
          count: assets.length,
          limit: MAX_INLINE_ASSETS,
          suggestion:
            'export with ?include_assets=0 then `wrangler r2 cp` per storage_key (see README)',
        },
        400,
      );
    }
    for (const asset of assets) {
      const obj = await c.env.IMAGES.get(asset.storage_key);
      if (!obj) {
        missingAssets.push(asset.storage_key);
        continue;
      }
      entries.push({
        name: `assets/${asset.storage_key}`,
        input: obj.body,
      });
    }
  }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    include_assets: includeAssets,
    row_counts: rowCounts,
    asset_count: includeAssets ? rowCounts.source_asset - missingAssets.length : 0,
    missing_assets: missingAssets,
  };

  const mistakesCsv = buildMistakesCsv(
    tableRows as unknown as Record<string, Array<Record<string, unknown>>>,
  );
  const reviewEventsCsv = buildReviewEventsCsv(
    tableRows as unknown as Record<string, Array<Record<string, unknown>>>,
  );
  const readme = buildReadme(manifest);

  // Prepend metadata entries so the ZIP order is: manifest, data, csvs, readme, then assets.
  entries.unshift(
    { name: 'manifest.json', input: JSON.stringify(manifest, null, 2) },
    { name: 'data.json', input: JSON.stringify(tableRows, null, 2) },
    { name: 'mistakes.csv', input: mistakesCsv },
    { name: 'review_events.csv', input: reviewEventsCsv },
    { name: 'README.md', input: readme },
  );

  const dateStamp = new Date(exportedAt * 1000).toISOString().slice(0, 10);
  return new Response(downloadZip(entries).body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="loom-backup-${dateStamp}.zip"`,
    },
  });
});
