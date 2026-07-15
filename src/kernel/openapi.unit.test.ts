import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityManifest } from './manifest';
import { generateOpenApiDocument } from './openapi';

describe('generateOpenApiDocument', () => {
  it('renders declared schemas, path/query params, pagination and deprecation metadata', () => {
    const capabilities: CapabilityManifest[] = [
      {
        name: 'test',
        description: 'test',
        api: {
          routes: [
            {
              method: 'POST',
              path: '/api/widgets/[id]',
              operationId: 'createWidgetRevision',
              request: {
                params: z.object({ id: z.string() }),
                query: z.object({ dry_run: z.boolean().optional() }),
                headers: z.object({ 'X-Request-ID': z.string().optional() }),
                body: z.object({ file: z.string().base64() }),
                bodyMediaType: 'multipart/form-data',
                bodyRequired: false,
              },
              successStatus: [200, 201],
              responses: {
                200: z.object({ id: z.string(), created: z.literal(false) }),
                201: z.object({ id: z.string(), created: z.literal(true) }),
              },
              responseMediaTypes: { 200: 'text/event-stream' },
              deprecation: { successor: '/api/widget-revisions', since: '@1783987200' },
            },
            {
              method: 'GET',
              path: '/api/widgets',
              operationId: 'listWidgets',
              request: {
                query: z.object({ limit: z.number().optional(), cursor: z.string().optional() }),
              },
              successStatus: 200,
              responses: { 200: z.object({ data: z.array(z.unknown()) }) },
              pagination: { kind: 'cursor', defaultLimit: 20, maxLimit: 100 },
            },
            { method: 'GET', path: '/api/legacy' },
          ],
        },
      },
    ];

    const document = generateOpenApiDocument(capabilities) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const create = document.paths['/api/widgets/{id}'].post;
    expect(create).toMatchObject({
      operationId: 'createWidgetRevision',
      deprecated: true,
      'x-successor': '/api/widget-revisions',
      'x-contract-status': 'declared',
    });
    expect(create.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'dry_run', in: 'query', required: false }),
        expect.objectContaining({ name: 'X-Request-ID', in: 'header', required: false }),
      ]),
    );
    expect(create.requestBody).toMatchObject({
      required: false,
      content: {
        'multipart/form-data': {
          schema: { properties: { file: { type: 'string', format: 'binary' } } },
        },
      },
    });
    expect(create.responses).toHaveProperty('201');
    expect(create.responses).toMatchObject({
      200: { content: { 'text/event-stream': expect.any(Object) } },
      201: { content: { 'application/json': expect.any(Object) } },
    });

    expect(document.paths['/api/widgets'].get['x-pagination']).toEqual({
      kind: 'cursor',
      defaultLimit: 20,
      maxLimit: 100,
    });
    expect(document.paths['/api/legacy'].get).toMatchObject({
      'x-contract-status': 'legacy',
      responses: { default: expect.any(Object) },
    });
    expect(document.paths['/api/health'].get).toMatchObject({ security: [] });
  });
});
