import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  type ApiPaginationDecl,
  type ApiRouteDecl,
  type CapabilityManifest,
  apiSuccessStatuses,
} from './manifest';

type JsonObject = Record<string, unknown>;

function toJsonSchema(schema: ZodTypeAny): JsonObject {
  return zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    effectStrategy: 'input',
  }) as JsonObject;
}

function toOpenApiPath(path: string): string {
  return path.replace(/\[([^\]]+)\]/g, '{$1}');
}

function schemaParameters(schema: ZodTypeAny, location: 'path' | 'query'): JsonObject[] {
  const json = toJsonSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set(Array.isArray(json.required) ? (json.required as string[]) : []);
  return Object.entries(properties).map(([name, value]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: value,
  }));
}

function responseDescription(status: number, successStatuses: number[]): string {
  if (successStatuses.includes(status)) return 'Successful response';
  if (status === 400) return 'Malformed request';
  if (status === 401) return 'Unauthorized';
  if (status === 404) return 'Resource not found';
  if (status === 409) return 'State or version conflict';
  if (status === 422) return 'Semantic validation failed';
  if (status === 429) return 'Rate limited';
  if (status >= 500) return 'Internal error';
  return `HTTP ${status} response`;
}

function openApiResponses(route: ApiRouteDecl): JsonObject {
  if (route.responses === undefined || Object.keys(route.responses).length === 0) {
    return {
      default: {
        description: 'Legacy route; response contract is not declared yet',
      },
    };
  }
  const successStatuses = apiSuccessStatuses(route);
  return Object.fromEntries(
    Object.entries(route.responses).map(([statusText, schema]) => {
      const status = Number(statusText);
      const response: JsonObject = { description: responseDescription(status, successStatuses) };
      if (status !== 204 && schema !== undefined) {
        response.content = {
          'application/json': { schema: toJsonSchema(schema) },
        };
      }
      return [statusText, response];
    }),
  );
}

function paginationExtension(pagination: ApiPaginationDecl): JsonObject | string {
  if (pagination === 'none') return 'none';
  return {
    kind: pagination.kind,
    defaultLimit: pagination.defaultLimit,
    maxLimit: pagination.maxLimit,
  };
}

function fallbackOperationId(
  capability: CapabilityManifest,
  route: ApiRouteDecl,
  routeIndex: number,
): string {
  const slug = route.path.replace(/^\/api\/?/, '').replace(/[^A-Za-z0-9]+/g, '_');
  return `legacy_${capability.name}_${route.method.toLowerCase()}_${routeIndex}_${slug || 'root'}`;
}

function openApiOperation(
  capability: CapabilityManifest,
  route: ApiRouteDecl,
  routeIndex: number,
): JsonObject {
  const parameters = [
    ...(route.request?.params ? schemaParameters(route.request.params, 'path') : []),
    ...(route.request?.query ? schemaParameters(route.request.query, 'query') : []),
  ];
  const operation: JsonObject = {
    operationId: route.operationId ?? fallbackOperationId(capability, route, routeIndex),
    tags: [capability.name],
    responses: openApiResponses(route),
    'x-capability': capability.name,
    'x-contract-status': route.operationId ? 'declared' : 'legacy',
  };
  if (parameters.length > 0) operation.parameters = parameters;
  if (route.request?.body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: toJsonSchema(route.request.body) } },
    };
  }
  if (route.pagination !== undefined) {
    operation['x-pagination'] = paginationExtension(route.pagination);
  }
  if (route.deprecation !== undefined) {
    operation.deprecated = true;
    operation['x-successor'] = route.deprecation.successor;
    if (route.deprecation.since) operation['x-deprecation-since'] = route.deprecation.since;
    if (route.deprecation.sunset) operation['x-sunset'] = route.deprecation.sunset;
  }
  return operation;
}

export function generateOpenApiDocument(capabilities: CapabilityManifest[]): JsonObject {
  const paths: Record<string, JsonObject> = {
    '/api/health': {
      get: {
        operationId: 'getHealth',
        security: [],
        responses: { 200: { description: 'Service is healthy' } },
        'x-contract-status': 'builtin',
      },
    },
    '/api/auth/check': {
      get: {
        operationId: 'checkAuth',
        responses: { 200: { description: 'Internal token is valid' } },
        'x-contract-status': 'builtin',
      },
    },
    '/api/openapi.json': {
      get: {
        operationId: 'getOpenApiDocument',
        responses: { 200: { description: 'OpenAPI document for the mounted API' } },
        'x-contract-status': 'builtin',
      },
    },
  };

  for (const capability of capabilities) {
    for (const [routeIndex, route] of (capability.api?.routes ?? []).entries()) {
      const path = toOpenApiPath(route.path);
      const pathItem = paths[path] ?? {};
      pathItem[route.method.toLowerCase()] = openApiOperation(capability, route, routeIndex);
      paths[path] = pathItem;
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Loom API',
      version: '1.0.0',
      description: 'Generated from capability manifests. Legacy operations are explicitly marked.',
    },
    security: [{ internalToken: [] }],
    components: {
      securitySchemes: {
        internalToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-internal-token',
        },
      },
    },
    paths,
  };
}
