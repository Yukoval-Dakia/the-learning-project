import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ingestionCapability } from './manifest';

// YUK-882 (F3.6c) — OCR / auto-enroll 注册收编：ingestion 包在自己的 manifest
// 声明两条 job 的精确 load/worker 元数据；中央渐缩簿（src/server/boss/
// handlers.ts）不再注册它们。实现本体（jobs/tencent_ocr_extract.ts /
// jobs/auto_enroll.ts）已在包内，本 lane 不再搬移。
describe('ingestion OCR / auto-enroll job declarations (YUK-882)', () => {
  it('declares tencent_ocr_extract with the exact AGENT-tier worker metadata', () => {
    const decl = ingestionCapability.jobs?.handlers.find((h) => h.name === 'tencent_ocr_extract');
    // 0.5s polling 与 includeMetadata（provider-attempt resume 读 retryCount）
    // 都是非注册器默认的 worker 选项，必须显式携带，缺一即等价漂移。
    expect(decl).toEqual({
      name: 'tencent_ocr_extract',
      queue: 'agent',
      pollingIntervalSeconds: 0.5,
      batchSize: 1,
      includeMetadata: true,
      load: expect.any(Function),
    });
  });

  it('declares auto_enroll on the LLM tier with the registrar-default worker shape', () => {
    const decl = ingestionCapability.jobs?.handlers.find((h) => h.name === 'auto_enroll');
    expect(decl).toEqual({
      name: 'auto_enroll',
      queue: 'llm',
      load: expect.any(Function),
    });
  });

  it('keeps the implementations in the package and loads them from the manifest', () => {
    const root = process.cwd();
    expect(existsSync(join(root, 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts'))).toBe(
      true,
    );
    expect(existsSync(join(root, 'src/capabilities/ingestion/jobs/auto_enroll.ts'))).toBe(true);

    const manifest = readFileSync(join(root, 'src/capabilities/ingestion/manifest.ts'), 'utf8');
    expect(manifest).toContain("import('./jobs/tencent_ocr_extract')");
    expect(manifest).toContain("import('./jobs/auto_enroll')");
  });

  it('deletes both registrations from the central handler book', () => {
    const root = process.cwd();
    const central = readFileSync(join(root, 'src/server/boss/handlers.ts'), 'utf8');
    expect(central, 'central book must not register or mention tencent_ocr_extract').not.toContain(
      'tencent_ocr_extract',
    );
    expect(central, 'central book must not register or mention auto_enroll').not.toContain(
      'auto_enroll',
    );
  });
});
