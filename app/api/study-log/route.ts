export const runtime = 'nodejs';

const goneBody = {
  error: 'gone',
  message: '/api/study-log was replaced by /api/records',
  replacement: '/api/records',
};

export async function GET(): Promise<Response> {
  return Response.json(goneBody, { status: 410 });
}

export async function POST(): Promise<Response> {
  return Response.json(goneBody, { status: 410 });
}
