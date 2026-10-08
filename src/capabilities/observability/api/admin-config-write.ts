import { ApiError, errorResponse } from '@/kernel/http';
import { patchAdminConfig, resetAdminConfig } from '../public';

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError('invalid_json', 'Expected a JSON request body', 400);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    return Response.json(await patchAdminConfig(await jsonBody(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function RESET(request: Request): Promise<Response> {
  try {
    return Response.json(await resetAdminConfig(await jsonBody(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
