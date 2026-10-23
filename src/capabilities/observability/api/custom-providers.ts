import { ApiError, errorResponse } from '@/kernel/http';
import {
  deleteCustomProviderRow,
  listCustomProviderPanelRows,
  putCustomProviderRow,
} from '../server/custom-provider-store';
import {
  CustomProviderDeleteResponseSchema,
  CustomProviderParamsSchema,
  CustomProviderPutBodySchema,
  CustomProviderWriteResponseSchema,
  CustomProvidersListResponseSchema,
} from './custom-providers-contracts';

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError('invalid_json', 'Expected a JSON request body', 400);
  }
}

function slugOf(raw: Record<string, string>): string {
  const parsed = CustomProviderParamsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'invalid_custom_provider_input',
      'provider id must be lowercase letters, digits, and dashes',
      400,
    );
  }
  return parsed.data.id;
}

export async function GET(): Promise<Response> {
  try {
    // The boundary contract is enforced here: the projection must parse
    // against the response schema, so drift fails loudly, not silently.
    const result = CustomProvidersListResponseSchema.parse(await listCustomProviderPanelRows());
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, params: Record<string, string>): Promise<Response> {
  try {
    const body = CustomProviderPutBodySchema.safeParse(await jsonBody(request));
    if (!body.success) {
      throw new ApiError(
        'invalid_custom_provider_input',
        `invalid custom provider body: ${JSON.stringify(body.error.issues.slice(0, 3))}`,
        400,
      );
    }
    const written = await putCustomProviderRow({
      slug: slugOf(params),
      displayName: body.data.display_name,
      baseUrl: body.data.base_url,
      apiKeyEnv: body.data.api_key_env,
      protocol: body.data.protocol,
    });
    // Re-project through the same panel read so the response carries the
    // post-write auth/model state, not a bare definition.
    const panel = await listCustomProviderPanelRows();
    const provider = panel.providers.find((row) => row.id === written.provider.id);
    if (!provider) {
      throw new ApiError('custom_provider_write_failed', 'provider vanished after write', 500);
    }
    const result = CustomProviderWriteResponseSchema.parse({
      provider,
      catalog: written.catalog,
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, params: Record<string, string>): Promise<Response> {
  try {
    const removed = await deleteCustomProviderRow(slugOf(params));
    const result = CustomProviderDeleteResponseSchema.parse({
      removed: removed.removed,
      ...(removed.catalog.outcome === 'stored' ? { catalog_version: removed.catalog.version } : {}),
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
