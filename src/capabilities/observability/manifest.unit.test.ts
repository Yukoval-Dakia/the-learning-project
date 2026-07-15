import { generateOpenApiDocument } from '@/kernel/openapi';
import { describe, expect, it } from 'vitest';
import { observabilityCapability } from './manifest';

describe('observability event operation contracts', () => {
  it('publishes event detail, correction and generic job SSE contracts', () => {
    const routes = observabilityCapability.api?.routes ?? [];
    const expected = new Map([
      ['GET /api/events/[id]', 'getEvent'],
      ['POST /api/events/[id]/correct', 'createEventCorrectionLegacy'],
      ['POST /api/events/[id]/corrections', 'createEventCorrection'],
      ['GET /api/jobs/[kind]/[id]/events', 'streamJobEvents'],
    ]);

    const declared = routes.filter((route) => expected.has(`${route.method} ${route.path}`));
    expect(declared).toHaveLength(expected.size);
    for (const route of declared) {
      const key = `${route.method} ${route.path}`;
      expect(route.operationId, key).toBe(expected.get(key));
    }

    const document = generateOpenApiDocument([observabilityCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths['/api/events/{id}/correct'].post).toMatchObject({
      deprecated: true,
      'x-successor': '/api/events/[id]/corrections',
    });
    expect(document.paths['/api/events/{id}/corrections'].post.responses).toEqual(
      expect.objectContaining({ 201: expect.any(Object) }),
    );
    expect(document.paths['/api/events/{id}/corrections'].post.requestBody).toMatchObject({
      required: true,
    });

    const jobEvents = document.paths['/api/jobs/{kind}/{id}/events'].get;
    expect(jobEvents.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'kind', in: 'path', required: true }),
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'Last-Event-ID', in: 'header' }),
      ]),
    );
    const jobResponses = jobEvents.responses as Record<
      string,
      { content: Record<string, unknown> }
    >;
    expect(jobResponses['200'].content).toHaveProperty('text/event-stream');
  });
});

describe('observability backup archive contracts', () => {
  it('publishes raw ZIP import and export media types', () => {
    const document = generateOpenApiDocument([observabilityCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    const exportArchive = document.paths['/api/_/export'].get;
    expect(exportArchive).toMatchObject({
      operationId: 'exportBackupArchive',
      'x-pagination': 'none',
      parameters: [expect.objectContaining({ name: 'include_assets', in: 'query' })],
      responses: {
        200: {
          content: {
            'application/zip': { schema: { type: 'string', format: 'binary' } },
          },
        },
      },
    });

    const importArchive = document.paths['/api/_/import'].post;
    expect(importArchive).toMatchObject({
      operationId: 'importBackupArchive',
      parameters: [expect.objectContaining({ name: 'confirm', in: 'query', required: true })],
      requestBody: {
        required: true,
        content: {
          'application/zip': { schema: { type: 'string', format: 'binary' } },
        },
      },
      responses: { 200: { content: { 'application/json': expect.any(Object) } } },
    });
  });
});
