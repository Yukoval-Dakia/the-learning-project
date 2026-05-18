export const runtime = 'nodejs';

const goneBody = {
  error: 'gone',
  message: '/api/study-log was replaced by /api/records',
  replacement: '/api/records',
};

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, _ctx: RouteParams): Promise<Response> {
  return Response.json(goneBody, { status: 410 });
}
