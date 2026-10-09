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

describe('current full Postgres source binding', () => {
  it('keeps source, maintenance and the independent restore gate in every current consumer', () => {
    for (const text of [
      runbook,
      readFileSync(resolve(process.cwd(), 'README.md'), 'utf8'),
      readFileSync(
        resolve(process.cwd(), 'docs/runbooks/2026-09-27-assessment-cutover.md'),
        'utf8',
      ),
    ]) {
      expect(text).toContain('--source-manifest');
      expect(text).toContain('--quiescence-evidence');
      expect(text).toContain('--require-restore-parity');
      expect(text).toContain('--strict');
    }
    expect(runbook).toContain('operator-attested-with-observations');
    expect(runbook).toContain('--restore-only');
    expect(runbook).toContain('reported_verified');
    expect(runbook).toContain('before migrations');
  });
});
