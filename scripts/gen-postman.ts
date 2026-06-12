/**
 * gen:postman — rebuild the Postman collection from committed endpoint specs.
 *
 * Source of truth: `postman/api-endpoints.json` (array of route specs). When a
 * route under `app/api/**` changes, edit that file and run `pnpm gen:postman`
 * rather than hand-editing the generated collection.
 *
 *   spec shape: { path, methods: [{ method, summary, query, contentType,
 *                                   bodyExample, formFields, notes }] }
 *
 * Output: `postman/learning-api.postman_collection.json` (Postman v2.1).
 * Deterministic — folders and requests are sorted, the collection/folder IDs
 * are fixed constants, so regenerating with unchanged specs is a no-op diff.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { capabilities } from '@/capabilities';

interface QueryParam {
  name: string;
  required?: boolean;
  example?: unknown;
}

interface MethodSpec {
  method: string;
  summary?: string;
  query?: QueryParam[];
  contentType?: string | null;
  bodyExample?: unknown;
  formFields?: string[] | null;
  notes?: string;
}

interface EndpointSpec {
  path: string;
  methods: MethodSpec[];
}

const SOURCE = 'postman/api-endpoints.json';
const OUTPUT = 'postman/learning-api.postman_collection.json';

const FOLDER_LABELS: Record<string, string> = {
  _: '_ admin/dev utils',
};

const endpoints: EndpointSpec[] = JSON.parse(readFileSync(SOURCE, 'utf8'));

// M5-T5c (YUK-321) — manifest 对账层：spec 条目必须存在于组合根路由清单，
// 死条目（旧 app/ 独有路由）进不了 collection；manifest 有而 spec 缺的路由
// 打印 WARN 鼓励补 spec（不 fail——内部调试端点允许不进 collection）。

// 路径风格归一化：manifest 路由参数写 `[id]`（如 /api/ingestion/[id]/blocks），
// api-endpoints.json 写 `:id`（如 /api/_/logs/jobs/:id）——不归一化 Set 永不命中。
const normalize = (p: string) => p.replace(/\[([^\]]+)\]/g, ':$1');

const manifestRoutes = new Set(
  capabilities.flatMap((c) => (c.api?.routes ?? []).map((r) => `${r.method} ${normalize(r.path)}`)),
);
manifestRoutes.add('GET /api/health'); // 组合根直挂（server/app.ts，token 豁免），不在任何 manifest——缺此行对账层会误杀健康探针条目
for (const ep of endpoints) {
  for (const m of ep.methods) {
    const key = `${m.method} ${ep.path}`;
    if (!manifestRoutes.has(key)) {
      throw new Error(
        `gen-postman: '${key}' 不在任何 capability manifest 中（死条目，请从 api-endpoints.json 删除）`,
      );
    }
  }
}

function folderKey(path: string): string {
  return path.split('/').filter(Boolean)[1] ?? 'root';
}

function pathVarsOf(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1));
}

function placeholderFor(name: string): string {
  return `REPLACE_${name}`;
}

function buildUrl(path: string, query?: QueryParam[]) {
  const segs = path.split('/').filter(Boolean);
  const variable = pathVarsOf(path).map((v) => ({
    key: v,
    value: placeholderFor(v),
  }));
  const url: Record<string, unknown> = {
    raw: `{{baseUrl}}${path}`,
    host: ['{{baseUrl}}'],
    path: segs,
  };
  if (variable.length) url.variable = variable;
  if (Array.isArray(query) && query.length) {
    url.query = query.map((q) => ({
      key: q.name,
      value: String(q.example ?? ''),
      disabled: !q.required,
      description: q.required ? 'required' : 'optional',
    }));
  }
  return url;
}

function buildBody(m: MethodSpec) {
  if (m.contentType === 'multipart/form-data' || Array.isArray(m.formFields)) {
    const fields = m.formFields ?? ['file'];
    return {
      mode: 'formdata',
      formdata: fields.map((f) => ({
        key: f,
        type: f === 'file' ? 'file' : 'text',
        ...(f === 'file' ? { src: [] } : { value: '' }),
      })),
    };
  }
  if (m.contentType === 'application/octet-stream') {
    return { mode: 'file', file: { src: '' } };
  }
  if (m.bodyExample != null) {
    return {
      mode: 'raw',
      raw: JSON.stringify(m.bodyExample, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  return undefined;
}

function buildHeaders(m: MethodSpec) {
  const headers: Array<{ key: string; value: string }> = [];
  if (m.bodyExample != null && (!m.contentType || m.contentType === 'application/json')) {
    headers.push({ key: 'Content-Type', value: 'application/json' });
  }
  if (m.contentType === 'application/octet-stream') {
    headers.push({ key: 'Content-Type', value: 'application/octet-stream' });
  }
  return headers;
}

function descriptionOf(path: string, m: MethodSpec): string {
  const lines: string[] = [];
  if (m.summary) lines.push(m.summary);
  if (Array.isArray(m.query) && m.query.length) {
    lines.push('', '**Query:**');
    for (const q of m.query)
      lines.push(`- \`${q.name}\` (${q.required ? 'required' : 'optional'}) e.g. \`${q.example}\``);
  }
  if (pathVarsOf(path).length) {
    lines.push(
      '',
      `**Path vars:** ${pathVarsOf(path)
        .map((v) => `\`:${v}\``)
        .join(', ')} — set under the request's Path Variables (placeholder \`REPLACE_*\`).`,
    );
  }
  if (m.notes) lines.push('', `**Notes:** ${m.notes}`);
  return lines.join('\n');
}

function buildRequest(path: string, m: MethodSpec, isHealth: boolean) {
  const request: Record<string, unknown> = {
    method: m.method,
    header: buildHeaders(m),
    url: buildUrl(path, m.query),
    description: descriptionOf(path, m),
  };
  const body = buildBody(m);
  if (body) request.body = body;
  if (isHealth) request.auth = { type: 'noauth' };
  return { name: `${m.method} ${path}`, request, response: [] };
}

const folders = new Map<string, Array<ReturnType<typeof buildRequest>>>();
for (const ep of endpoints) {
  const key = folderKey(ep.path);
  if (!folders.has(key)) folders.set(key, []);
  const isHealth = ep.path === '/api/health';
  for (const m of ep.methods) folders.get(key)?.push(buildRequest(ep.path, m, isHealth));
}

const items = [...folders.keys()].sort().map((key) => ({
  name: FOLDER_LABELS[key] ?? key,
  item: (folders.get(key) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
}));

const collection = {
  info: {
    _postman_id: 'c1d2e3f4-a5b6-47c8-9d0e-1f2a3b4c5d6e',
    name: 'learning-api',
    description:
      'The Learning Project — Hono backend (server/app.ts).\n\n' +
      'Auth: every /api/* request needs header `x-internal-token` (collection-level API-key auth → `{{internalToken}}`), except `/api/health`.\n\n' +
      'Base URL: `{{baseUrl}}` (default http://localhost:8787 — the Hono dev port).\n\n' +
      'Path vars and request bodies use placeholder example values — replace `REPLACE_*` and example IDs with real ones before sending mutating requests.\n\n' +
      'Generated from postman/api-endpoints.json by `pnpm gen:postman` — do not hand-edit. Run headlessly: `pnpm api:smoke [folder]`.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'apikey',
    apikey: [
      { key: 'key', value: 'x-internal-token', type: 'string' },
      { key: 'value', value: '{{internalToken}}', type: 'string' },
      { key: 'in', value: 'header', type: 'string' },
    ],
  },
  variable: [{ key: 'baseUrl', value: 'http://localhost:8787', type: 'string' }],
  item: items,
};

writeFileSync(OUTPUT, `${JSON.stringify(collection, null, 2)}\n`);

// Normalise to repo Biome style so a bare `pnpm gen:postman` is idempotent
// (Biome collapses short arrays that JSON.stringify expands).
execSync(`pnpm exec biome format --write ${OUTPUT}`, { stdio: 'ignore' });

const count = endpoints.reduce((n, e) => n + e.methods.length, 0);
console.log(
  `[gen:postman] ${items.length} folders, ${endpoints.length} paths, ${count} requests → ${OUTPUT}`,
);
