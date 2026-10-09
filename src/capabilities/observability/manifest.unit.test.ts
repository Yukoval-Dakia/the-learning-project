import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '@/kernel/openapi';
import { observabilityCapability } from './manifest';

describe('observability housekeeping schedule contracts', () => {
  it('preserves both orphan cleanup times and staggers the profile audit', () => {
    const expected = new Map([
      ['prune_orphan_conversation_sessions', '25 4 * * *'],
      ['subject_profile_audit_nightly', '26 4 * * *'],
      ['prune_orphan_placement_sessions', '35 4 * * *'],
    ]);
    const jobs = (observabilityCapability.jobs?.handlers ?? []).filter((job) =>
      expected.has(job.name),
    );
    expect(jobs).toHaveLength(expected.size);
    for (const job of jobs) {
      expect(job.schedule, job.name).toEqual({
        cron: expected.get(job.name),
        tz: 'Asia/Shanghai',
      });
      expect(job.queue, job.name).toBe('fast');
    }
  });
});

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

describe('observability admin read contracts', () => {
  it('publishes run pagination plus cost and failure filters', () => {
    const routes = observabilityCapability.api?.routes ?? [];
    const expected = new Map([
      ['GET /api/admin/runs', 'listAdminRuns'],
      ['GET /api/admin/runs/[id]', 'getAdminRun'],
      ['GET /api/admin/cost', 'getAdminCost'],
      ['GET /api/admin/failures', 'listAdminFailureClusters'],
      ['GET /api/cost/today', 'getTodayCost'],
    ]);
    for (const [key, operationId] of expected) {
      const route = routes.find((candidate) => `${candidate.method} ${candidate.path}` === key);
      expect(route?.operationId, key).toBe(operationId);
    }

    const document = generateOpenApiDocument([observabilityCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths['/api/admin/runs'].get).toMatchObject({
      'x-pagination': { kind: 'cursor', defaultLimit: 50, maxLimit: 200 },
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'limit', in: 'query' }),
        expect.objectContaining({ name: 'status', in: 'query' }),
        expect.objectContaining({ name: 'cursor', in: 'query' }),
      ]),
    });
    expect(document.paths['/api/admin/runs/{id}'].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]),
    );
    expect(document.paths['/api/admin/cost'].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'days', in: 'query' })]),
    );
    expect(document.paths['/api/admin/failures'].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'limit', in: 'query' })]),
    );
  });
});

describe('observability diagnostic read contracts', () => {
  it('declares the five non-paginated diagnostic surfaces', () => {
    const routes = observabilityCapability.api?.routes ?? [];
    const expected = new Map([
      ['GET /api/admin/conjecture-scores', 'getConjectureScores'],
      ['GET /api/admin/judge-calibration', 'getJudgeCalibration'],
      ['GET /api/admin/coverage-lattice', 'getCoverageLattice'],
      ['GET /api/observability/calibration-maturity', 'getCalibrationMaturity'],
      ['GET /api/observability/effectiveness-trend', 'getEffectivenessTrend'],
    ]);
    for (const [key, operationId] of expected) {
      const route = routes.find((candidate) => `${candidate.method} ${candidate.path}` === key);
      expect(route?.operationId, key).toBe(operationId);
      expect(route?.pagination, key).toBe('none');
      expect(route?.responses?.[200], key).toBeDefined();
    }
  });
});

describe('observability admin config read contract', () => {
  it('publishes the YUK-1007 config read surface as a single non-paginated GET', () => {
    const routes = observabilityCapability.api?.routes ?? [];
    const route = routes.find(
      (candidate) => `${candidate.method} ${candidate.path}` === 'GET /api/admin/config',
    );
    expect(route?.operationId).toBe('getAdminConfig');
    expect(route?.pagination).toBe('none');
    expect(route?.responses?.[200]).toBeDefined();

    const document = generateOpenApiDocument([observabilityCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = document.paths['/api/admin/config'].get;
    expect(operation).toMatchObject({ operationId: 'getAdminConfig', 'x-pagination': 'none' });
    const responses = operation?.responses as Record<string, { content: Record<string, unknown> }>;
    expect(responses[200].content).toHaveProperty('application/json');
  });
});

describe('observability subject control contracts', () => {
  it('publishes all control operations and keeps validation overrides partial', () => {
    const routes = observabilityCapability.api?.routes ?? [];
    const expected = new Map([
      ['PATCH /api/admin/subjects/[id]', 'updateAdminSubject'],
      ['POST /api/admin/subjects/[id]/retire', 'retireAdminSubject'],
      ['POST /api/admin/subjects/[id]/restore', 'restoreAdminSubject'],
      ['POST /api/admin/subjects/[id]/reset', 'resetAdminSubject'],
      ['POST /api/admin/subjects/[id]/validate', 'validateAdminSubject'],
    ]);
    for (const [key, operationId] of expected) {
      const route = routes.find((candidate) => `${candidate.method} ${candidate.path}` === key);
      expect(route?.operationId, key).toBe(operationId);
      expect(route?.responses?.[200], key).toBeDefined();
    }

    const document = generateOpenApiDocument([observabilityCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const validate = document.paths['/api/admin/subjects/{id}/validate'].post;
    expect(validate.requestBody).toMatchObject({ required: false });
    const requestBody = validate.requestBody as {
      content: {
        'application/json': {
          schema: { properties: { traitPayloadOverrides: { required?: string[] } } };
        };
      };
    };
    expect(
      requestBody.content['application/json'].schema.properties.traitPayloadOverrides.required,
    ).toBeUndefined();
  });
});
