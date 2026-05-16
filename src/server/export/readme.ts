export interface Manifest {
  schema_version: string;
  exported_at: number;
  include_assets: boolean;
  row_counts: Record<string, number>;
  asset_count: number;
  missing_assets?: string[];
}

export function buildReadme(m: Manifest): string {
  const date = new Date(m.exported_at * 1000).toISOString();
  const totalRows = Object.values(m.row_counts).reduce((s, n) => s + n, 0);
  const missingCount = m.missing_assets?.length ?? 0;

  return `# Loom backup

Exported at: ${date}
schema_version: ${m.schema_version}
include_assets: ${m.include_assets}
total rows: ${totalRows}
asset_count: ${m.asset_count}

## ZIP contents

- \`manifest.json\` — backup metadata + per-table row counts
- \`data.json\` — every row from every table, in FK topological order
- \`mistakes.csv\` — denormalized per-failure-attempt summary (event-stream projection, knowledge names, FSRS state, review count)
- \`review_events.csv\` — flattened review log (event-stream projection)
- \`README.md\` — this file
${m.include_assets ? '- `assets/<storage_key>` — R2 image bytes (one file per source_asset)' : ''}
${
  m.include_assets && missingCount > 0
    ? `\n## Missing R2 assets\n\n${missingCount} asset(s) referenced by source_asset rows could not be fetched from R2 — they are listed in manifest.missing_assets. Restoring this ZIP will leave those source_asset rows with broken image refs.\n`
    : ''
}

## CSV note

Excel for Mac may misinterpret \\n inside quoted fields as a row break. Use
LibreOffice or Python's \`csv.reader\` (or pandas) instead — both handle the
RFC 4180 quoting correctly.

## Restore (destructive — wipes D1, overwrites R2 keys, leaves R2 orphans)

Restore is destructive: it DELETEs every row from every table in this app's
D1, then re-INSERTs from \`data.json\`. R2 assets included in the ZIP are
PUT under their original keys — but pre-existing R2 objects NOT included
in the ZIP are NOT deleted (they become orphans; clean them up via wrangler
r2 object delete if needed). Take a fresh export of the *current* state
before restoring an old one — there is no UNDO.

### Via UI

Open \`/_/inspect\` → "Data" tab → upload this ZIP → type "wipe" in the
confirm field → click 清空并还原.

### Via curl

\`\`\`bash
TOKEN=...   # value of INTERNAL_TOKEN secret
HOST=https://your-worker.example.com

curl -X POST \\
  -H "x-internal-token: $TOKEN" \\
  -H "Content-Type: application/zip" \\
  --data-binary @loom-backup-${date.slice(0, 10)}.zip \\
  "$HOST/api/_/import?confirm=wipe-and-reload"
\`\`\`

The endpoint returns a JSON \`{ok, stats, assets_uploaded, assets_failed}\`
report. \`stats\` is keyed by table name; \`{deleted, inserted}\` per table.

## Re-acquire R2 assets without packing them inline

If you have >45 R2 objects, the inline export refuses (CF Worker free plan
caps at 50 sub-requests per call; we leave 5 for D1). Take a refs-only
export and pull the bytes via \`wrangler\`:

\`\`\`bash
jq -r '.source_asset[].storage_key' < <(unzip -p loom-backup.zip data.json) \\
  | while read key; do
      wrangler r2 object get "learning-project-images/$key" \\
        --file "./assets/$key"
    done
\`\`\`

Then pack \`./assets/\` into the ZIP next to \`data.json\` before re-importing
via the restore endpoint above.

## Schema version

This bundle was exported at schema_version ${m.schema_version}. Restore will
refuse a ZIP whose manifest declares a different version — there is no
auto-migration in this version. If you need to migrate across versions,
write a one-off transformer that updates \`data.json\` to the new schema
and bumps \`manifest.json\`.
`;
}
