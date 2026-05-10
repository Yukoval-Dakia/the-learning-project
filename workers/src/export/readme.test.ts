import { describe, it, expect } from 'vitest';
import { buildReadme } from './readme';

const fakeManifest = {
  schema_version: '1.0',
  exported_at: 1715357200,
  include_assets: true,
  row_counts: { mistake: 17, knowledge: 42 } as Record<string, number>,
  asset_count: 12,
};

describe('buildReadme', () => {
  it('starts with a header that names schema_version', () => {
    const md = buildReadme(fakeManifest);
    expect(md.split('\n')[0]).toMatch(/Loom backup/);
    expect(md).toContain('schema_version: 1.0');
  });

  it('mentions all 5 ZIP files explicitly', () => {
    const md = buildReadme(fakeManifest);
    expect(md).toContain('manifest.json');
    expect(md).toContain('data.json');
    expect(md).toContain('mistakes.csv');
    expect(md).toContain('review_events.csv');
    expect(md).toContain('README.md');
  });

  it('includes restore CLI example with confirm query', () => {
    const md = buildReadme(fakeManifest);
    expect(md).toContain('?confirm=wipe-and-reload');
    expect(md).toContain('curl');
  });

  it('warns about destructive import', () => {
    const md = buildReadme(fakeManifest);
    expect(md.toLowerCase()).toMatch(/destructive|wipe|清空/);
  });

  it('mentions wrangler r2 cp sidecar for >45 assets', () => {
    const md = buildReadme(fakeManifest);
    expect(md).toContain('wrangler r2');
  });

  it('reports include_assets state and asset_count', () => {
    const md = buildReadme(fakeManifest);
    expect(md).toContain('include_assets: true');
    expect(md).toContain('12');
  });

  it('CSV note covers Excel-on-Mac newline gotcha', () => {
    const md = buildReadme(fakeManifest);
    expect(md.toLowerCase()).toMatch(/excel|libreoffice|csv\.reader/);
  });
});
