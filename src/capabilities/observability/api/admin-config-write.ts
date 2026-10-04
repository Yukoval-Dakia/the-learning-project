import { ApiError, errorResponse } from '@/kernel/http';
import { getAdminConfigWriter } from '../server/admin-config-writer';
import {
  AdminConfigResetBodySchema,
  AdminConfigWriteBodySchema,
} from './admin-config-write-contracts';

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError('invalid_json', 'Expected a JSON request body', 400);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body = AdminConfigWriteBodySchema.safeParse(await jsonBody(request));
    if (!body.success)
      throw new ApiError('invalid_config_request', 'Expected changes and an optional note', 400);
    const writer = getAdminConfigWriter();
    if (!writer)
      throw new ApiError('config_writer_unavailable', 'Configuration writer is unavailable', 503);
    return Response.json(await writer(body.data.changes, body.data.note));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function RESET(request: Request): Promise<Response> {
  try {
    const body = AdminConfigResetBodySchema.safeParse(await jsonBody(request));
    if (!body.success)
      throw new ApiError('invalid_config_request', 'Expected keys and an optional note', 400);
    const writer = getAdminConfigWriter();
    if (!writer)
      throw new ApiError('config_writer_unavailable', 'Configuration writer is unavailable', 503);
    return Response.json(
      await writer(
        body.data.keys.map((key) => ({ action: 'clear', key })),
        body.data.note,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
