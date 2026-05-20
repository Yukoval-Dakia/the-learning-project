export interface LocalEnvInput {
  [key: string]: string | undefined;
  POSTGRES_USER?: string;
  POSTGRES_PASSWORD?: string;
  POSTGRES_DB?: string;
  LOCAL_POSTGRES_HOST?: string;
  LOCAL_POSTGRES_PORT?: string;
  LOCAL_NEXT_PORT?: string;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function buildLocalDatabaseUrl(env: LocalEnvInput = process.env): string {
  const user = env.POSTGRES_USER ?? 'loom';
  const password = env.POSTGRES_PASSWORD ?? 'loom';
  const database = env.POSTGRES_DB ?? 'loom';
  const host = env.LOCAL_POSTGRES_HOST ?? '127.0.0.1';
  const port = env.LOCAL_POSTGRES_PORT ?? '5433';

  return `postgres://${encode(user)}:${encode(password)}@${host}:${port}/${encode(database)}?sslmode=disable`;
}

export function buildLocalDevEnv(env: LocalEnvInput = process.env): {
  DATABASE_URL: string;
  NEXT_PUBLIC_BASE_URL: string;
  LOCAL_NEXT_PORT: string;
} {
  const port = env.LOCAL_NEXT_PORT ?? '3001';

  return {
    DATABASE_URL: buildLocalDatabaseUrl(env),
    NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    LOCAL_NEXT_PORT: port,
  };
}
