import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(resolve(process.cwd(), 'docs/sub5-restore-cli.md'), 'utf8');

describe('backup and restore runbook drift guard', () => {
  it('does not regress to retired deployment commands or terminology', () => {
    expect(runbook).not.toMatch(/\.dev\.vars|wrangler|workers\.dev|\bD1\b/u);
  });

  it('keeps both current recovery layers and the S3-compatible R2 path discoverable', () => {
    expect(runbook).toContain('/api/_/export');
    expect(runbook).toContain('/api/_/import');
    expect(runbook).toContain('docker compose exec -T postgres pg_dump');
    expect(runbook).toContain('docker compose exec -T postgres pg_restore');
    expect(runbook).toContain('aws s3api get-object');
    expect(runbook.match(/\.question_block\[\]\?\.crop_refs\[\]\?/gu)).toHaveLength(2);
    expect(runbook.match(/\.question_block\[\]\?\.figures\[\]\?\.asset_id/gu)).toHaveLength(2);
    expect(runbook).toContain('--single-transaction --exit-on-error');
    expect(runbook).toContain('Postgres');
  });
});
