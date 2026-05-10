# Phase 1a Sub 5 设计 — 数据导出 / 还原 (D1 + R2 backup via ZIP)

> **Master spec**: `docs/superpowers/specs/2026-05-09-phase1a-design.md`（Phase 1a 整体）
>
> **触发**：Phase 1a 收尾要件。PLANNING § 项目结构："数据导出（JSON / Markdown）—— 给未来的自己买保险"。

**Goal**：2 天 / 1 PR。让用户能一键 ZIP 备份完整 D1 + (可选) R2 内容，能从同结构 ZIP 清空重装。

---

## 一、范围 / 不在范围

| 在 | 不在（推 Phase 2 / 后续）|
|---|---|
| `GET /api/_/export` 输出 ZIP（含 manifest + data.json + 2 个 CSV + README） | 增量导出 / 按表过滤 / 按日期过滤 |
| `?include_assets=1` 把 R2 字节流式打包进 `assets/<storage_key>/` | R2 bucket-level 备份 |
| `POST /api/_/import?confirm=wipe-and-reload` 解 ZIP → 清空 D1 → 重装 → R2 put | 增量 import / 冲突合并 / upsert |
| `mistakes.csv` 错题摘要（denormalized + knowledge 名字 join）| Markdown / PDF rendering |
| `review_events.csv` 复习时间序列（含 before/after FSRS state 解构）| 其他衍生 CSV（quiz / artifact 等）|
| `manifest.json.schema_version` 严格匹配（`"1.0"`） | 跨版本迁移工具 |
| `/_/inspect` 加 "数据" tab：2 个下载按钮 + 还原 file picker + 下载进度（"已下载 N MB"） | 单独页面 |
| CLI 用法 doc（curl + wrangler 双示例 + R2 旁路 cp 脚本） | wrangler tunnel / dev 模式专用步骤 |
| `MAX_INLINE_ASSETS = 45` 守卫：含 R2 字节时若超 45 张直接 400 + 引导走 R2 旁路 | 真正大量 R2 异步导出（Phase 2 Workers Queue） |

---

## 二、关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| Wire format | 一律 ZIP（含 refs-only 也是 ZIP）| 单一代码路径；数据 / CSV / README 自然多文件，ZIP 是本能选择 |
| ZIP 编码库 | `client-zip` (~3KB, Web Streams native, Workers-compatible) | 流式不占内存；活跃维护 |
| ZIP 解码库 | `fflate` (~50KB, ES module, Workers-compatible) | 一次性 unzipSync；MVP 不需要流式 import |
| Schema 版本 | 常量 `SCHEMA_VERSION = "1.0"`，写入 `manifest.json`；不匹配拒绝 import | 升级路径 Phase 2 再说，不阻塞当前 |
| Import 语义 | 清空 + 重装（**非** merge / upsert） | 简化代码；满足"灾后还原"主要 use case |
| 误触防护 | `?confirm=wipe-and-reload` query param 必须存在 | 防 curl 误调；UI 还要 `confirm()` + 输入"wipe" 字样 |
| FK 拓扑序 | 单一 `FK_ORDER` 常量数组；export 顺序 / import wipe-reverse / insert-forward 都引用它 | 单一真相；改 schema 时只动一处 |
| Auth | 复用既有 `x-internal-token` 中间件（`/api/*` 已挂） | 0 新代码 |
| R2 含与不含 | 默认不含；`?include_assets=1` 才加 `assets/` 目录 | refs-only 几 MB；含 R2 可几十 MB；让调用方选 |
| 部分失败语义 | export 单点失败 → HTTP 5xx + 结束（不 partial ZIP）；import wipe 后失败 → 500 + stats 截止；R2 put 失败逐个记录 + 继续 | 用户重跑友好；半 D1 但 R2 OK 不阻塞 |
| 文件名命名 | export 响应头 `Content-Disposition: attachment; filename="loom-backup-<ISO date>.zip"` | 浏览器下载文件名稳定 |
| 下载进度 | client 用 `Response.body.getReader()` 累积 chunks；UI 显示"已下载 X MB"（Content-Length 未知则不显示百分比） | streaming 不知道最终长度；显示已传输量足够安抚用户 |
| 子请求上限守卫 | server 检查 `source_asset.length > MAX_INLINE_ASSETS=45` → 400 `too_many_assets`；用户走 wrangler r2 cp 旁路 | CF Worker free 50 子请求上限；留 5 个给 D1 SELECT |

---

## 三、Server 设计

### 3.1 路由 + 中间件

新文件 `workers/src/routes/export.ts` + `workers/src/routes/import.ts`。

挂在 `workers/src/index.ts`：

```ts
app.route('/api/_/export', exportRoute);
app.route('/api/_/import', importRoute);
```

`/api/*` 已被 `internalAuth` middleware 守住（`workers/src/auth.ts` 检查 `x-internal-token`），无需改 auth。

### 3.2 共享常量 (`workers/src/export/constants.ts`)

```ts
export const SCHEMA_VERSION = '1.0';

// CF Worker free plan 子请求上限 50；留 5 个给 D1 SELECT * × 18 张表 + 容错。
// 付费版 1000，可上调到 ~950（Phase 2 升级时改这里）。
export const MAX_INLINE_ASSETS = 45;

// FK 拓扑顺序：插入沿此向前；wipe 沿其反向。
// 任何 schema 改动（增 / 删表）必须更新此数组并 bump SCHEMA_VERSION。
export const FK_ORDER = [
  'knowledge',
  'source_asset',
  'source_document',
  'ingestion_session',
  'question_block',
  'question',
  'mistake',
  'review_event',
  'learning_item',
  'completion_evidence',
  'study_log',
  'artifact',
  'answer',
  'judgment',
  'user_appeal',
  'dreaming_proposal',
  'tool_call_log',
  'cost_ledger',
] as const;

export type TableName = typeof FK_ORDER[number];
```

### 3.3 `manifest.json` shape

```json
{
  "schema_version": "1.0",
  "exported_at": 1715357200,
  "include_assets": true,
  "row_counts": {
    "knowledge": 42,
    "mistake": 17,
    "...": 0
  },
  "asset_count": 12
}
```

### 3.4 Export endpoint

```ts
// workers/src/routes/export.ts
import { Hono } from 'hono';
import { downloadZip } from 'client-zip';
import type { AppEnv } from '../types';
import { FK_ORDER, SCHEMA_VERSION } from '../export/constants';
import { buildMistakesCsv, buildReviewEventsCsv } from '../export/csv';
import { buildReadme } from '../export/readme';

export const exportRoute = new Hono<AppEnv>();

exportRoute.get('/', async (c) => {
  const includeAssets = c.req.query('include_assets') === '1';
  const exportedAt = Math.floor(Date.now() / 1000);

  // 1. SELECT * each table → row_counts + data
  const tableRows: Record<string, unknown[]> = {};
  const rowCounts: Record<string, number> = {};
  for (const t of FK_ORDER) {
    const result = await c.env.DB.prepare(`select * from ${t}`).all();
    tableRows[t] = result.results;
    rowCounts[t] = result.results.length;
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    include_assets: includeAssets,
    row_counts: rowCounts,
    asset_count: includeAssets ? rowCounts.source_asset : 0,
  };

  // 2. Build CSVs (string)
  const mistakesCsv = buildMistakesCsv(tableRows);
  const reviewEventsCsv = buildReviewEventsCsv(tableRows);
  const readme = buildReadme(manifest);

  // 3. Build ZIP entries (lazy; client-zip accepts iterables)
  const entries: Array<{ name: string; input: unknown; lastModified?: Date }> = [
    { name: 'manifest.json', input: JSON.stringify(manifest, null, 2) },
    { name: 'data.json', input: JSON.stringify(tableRows, null, 2) },
    { name: 'mistakes.csv', input: mistakesCsv },
    { name: 'review_events.csv', input: reviewEventsCsv },
    { name: 'README.md', input: readme },
  ];

  if (includeAssets) {
    const assets = tableRows.source_asset as Array<{ storage_key: string }>;
    if (assets.length > MAX_INLINE_ASSETS) {
      return c.json(
        {
          error: 'too_many_assets',
          count: assets.length,
          limit: MAX_INLINE_ASSETS,
          suggestion:
            'export with ?include_assets=0 then `wrangler r2 cp` per storage_key (see README)',
        },
        400,
      );
    }
    for (const asset of assets) {
      const obj = await c.env.IMAGES.get(asset.storage_key);
      if (!obj) continue; // missing = skip silently
      entries.push({
        name: `assets/${asset.storage_key}`,
        input: obj.body, // ReadableStream
      });
    }
  }

  const dateStamp = new Date(exportedAt * 1000).toISOString().slice(0, 10);
  return new Response(downloadZip(entries).body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="loom-backup-${dateStamp}.zip"`,
    },
  });
});
```

### 3.5 CSV builders (`workers/src/export/csv.ts`)

```ts
export interface Row {
  [k: string]: unknown;
}

function csvEscape(s: unknown): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function buildMistakesCsv(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    (tables.knowledge as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    (tables.question as Array<{ id: string; prompt_md: string; reference_md: string | null }>)
      .map((q) => [q.id, q]),
  );
  const reviewsByMistake = new Map<string, Row[]>();
  for (const r of tables.review_event as Row[]) {
    const list = reviewsByMistake.get(r.mistake_id as string) ?? [];
    list.push(r);
    reviewsByMistake.set(r.mistake_id as string, list);
  }

  const headers = [
    'id', 'created_at', 'prompt_md', 'reference_md', 'wrong_answer_md',
    'knowledge_names', 'cause_primary', 'cause_user_notes',
    'difficulty', 'fsrs_state_due', 'fsrs_state_reps', 'fsrs_state_lapses',
    'status', 'last_reviewed_at', 'review_count',
  ];

  const lines: string[] = [headers.join(',')];

  for (const m of tables.mistake as Row[]) {
    const q = questionById.get(m.question_id as string);
    const kIds = JSON.parse(m.knowledge_ids as string) as string[];
    const kNames = kIds.map((id) => knowledgeById.get(id) ?? id).join('; ');
    const cause = m.cause ? (JSON.parse(m.cause as string) as { primary_category: string; user_notes: string | null }) : null;
    const fsrs = m.fsrs_state ? (JSON.parse(m.fsrs_state as string) as { due: number; reps: number; lapses: number }) : null;
    const reviews = reviewsByMistake.get(m.id as string) ?? [];
    const lastReview = reviews.length > 0 ? Math.max(...reviews.map((r) => r.rated_at as number)) : null;

    lines.push([
      csvEscape(m.id),
      csvEscape(m.created_at),
      csvEscape(q?.prompt_md ?? ''),
      csvEscape(q?.reference_md ?? ''),
      csvEscape(m.wrong_answer_md),
      csvEscape(kNames),
      csvEscape(cause?.primary_category ?? ''),
      csvEscape(cause?.user_notes ?? ''),
      csvEscape((m as { difficulty?: number }).difficulty),
      csvEscape(fsrs?.due ?? ''),
      csvEscape(fsrs?.reps ?? ''),
      csvEscape(fsrs?.lapses ?? ''),
      csvEscape(m.status),
      csvEscape(lastReview ?? ''),
      csvEscape(reviews.length),
    ].join(','));
  }

  return lines.join('\n');
}

export function buildReviewEventsCsv(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    (tables.knowledge as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    (tables.question as Array<{ id: string; prompt_md: string; knowledge_ids: string }>)
      .map((q) => [q.id, q]),
  );
  const mistakeById = new Map(
    (tables.mistake as Array<{ id: string; question_id: string }>).map((m) => [m.id, m]),
  );

  const RATING_LABEL: Record<number, string> = { 1: 'again', 2: 'hard', 3: 'good' };

  const headers = [
    'id', 'rated_at', 'mistake_id', 'prompt_excerpt', 'knowledge_names',
    'rating', 'rating_label',
    'before_stability', 'before_difficulty', 'before_due', 'before_state',
    'after_stability', 'after_difficulty', 'after_due', 'after_state',
  ];

  const lines: string[] = [headers.join(',')];

  for (const r of tables.review_event as Row[]) {
    const mistake = mistakeById.get(r.mistake_id as string);
    const question = mistake ? questionById.get(mistake.question_id) : undefined;
    const kIds: string[] = question ? (JSON.parse(question.knowledge_ids) as string[]) : [];
    const kNames = kIds.map((id) => knowledgeById.get(id) ?? id).join('; ');
    const promptExcerpt = (question?.prompt_md ?? '').slice(0, 80).replace(/\n/g, ' ');
    const before = r.before_fsrs_state ? JSON.parse(r.before_fsrs_state as string) : null;
    const after = r.after_fsrs_state ? JSON.parse(r.after_fsrs_state as string) : null;

    lines.push([
      csvEscape(r.id),
      csvEscape(r.rated_at),
      csvEscape(r.mistake_id),
      csvEscape(promptExcerpt),
      csvEscape(kNames),
      csvEscape(r.rating),
      csvEscape(RATING_LABEL[r.rating as number] ?? ''),
      csvEscape(before?.stability ?? ''),
      csvEscape(before?.difficulty ?? ''),
      csvEscape(before?.due ?? ''),
      csvEscape(before?.state ?? ''),
      csvEscape(after?.stability ?? ''),
      csvEscape(after?.difficulty ?? ''),
      csvEscape(after?.due ?? ''),
      csvEscape(after?.state ?? ''),
    ].join(','));
  }

  return lines.join('\n');
}
```

### 3.6 Import endpoint

```ts
// workers/src/routes/import.ts
import { Hono } from 'hono';
import { unzipSync } from 'fflate';
import type { AppEnv } from '../types';
import { FK_ORDER, SCHEMA_VERSION } from '../export/constants';

export const importRoute = new Hono<AppEnv>();

const INSERT_BATCH_SIZE = 50;

importRoute.post('/', async (c) => {
  if (c.req.query('confirm') !== 'wipe-and-reload') {
    return c.json(
      { error: 'confirm_required', message: 'pass ?confirm=wipe-and-reload to acknowledge wipe' },
      400,
    );
  }

  // 1. Read ZIP body
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) {
    return c.json({ error: 'validation_error', message: 'empty body' }, 400);
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(ab));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'invalid_zip', message: msg }, 400);
  }

  // 2. Read manifest, validate schema_version
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) {
    return c.json({ error: 'invalid_zip', message: 'manifest.json missing' }, 400);
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    schema_version: string;
    include_assets: boolean;
    row_counts: Record<string, number>;
  };
  if (manifest.schema_version !== SCHEMA_VERSION) {
    return c.json(
      {
        error: 'schema_version_mismatch',
        expected: SCHEMA_VERSION,
        got: manifest.schema_version,
      },
      400,
    );
  }

  // 3. Parse data.json
  const dataBytes = entries['data.json'];
  if (!dataBytes) {
    return c.json({ error: 'invalid_zip', message: 'data.json missing' }, 400);
  }
  const data = JSON.parse(new TextDecoder().decode(dataBytes)) as Record<string, Record<string, unknown>[]>;

  // 4. Wipe in REVERSE FK order
  const stats: Record<string, { deleted: number; inserted: number }> = {};
  for (const t of [...FK_ORDER].reverse()) {
    const r = await c.env.DB.prepare(`delete from ${t}`).run();
    stats[t] = { deleted: (r as { meta?: { changes?: number } }).meta?.changes ?? 0, inserted: 0 };
  }

  // 5. Insert in FORWARD FK order, chunked
  for (const t of FK_ORDER) {
    const rows = data[t] ?? [];
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const placeholders = `(${cols.map(() => '?').join(',')})`;
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const chunk = rows.slice(i, i + INSERT_BATCH_SIZE);
      const stmts = chunk.map((row) =>
        c.env.DB.prepare(
          `insert into ${t} (${cols.join(',')}) values ${placeholders}`,
        ).bind(...cols.map((col) => row[col] ?? null)),
      );
      await c.env.DB.batch(stmts);
      stats[t].inserted += chunk.length;
    }
  }

  // 6. Re-upload R2 if present
  let assetsUploaded = 0;
  let assetsFailed = 0;
  if (manifest.include_assets) {
    for (const [path, bytes] of Object.entries(entries)) {
      if (!path.startsWith('assets/')) continue;
      const key = path.slice('assets/'.length);
      try {
        await c.env.IMAGES.put(key, bytes);
        assetsUploaded += 1;
      } catch (err) {
        console.error('import: R2 put failed', { key, err });
        assetsFailed += 1;
      }
    }
  }

  return c.json({
    ok: true,
    stats,
    assets_uploaded: assetsUploaded,
    assets_failed: assetsFailed,
  });
});
```

### 3.7 README builder (`workers/src/export/readme.ts`)

输出 markdown 字符串，列：
- ZIP 内容清单
- schema_version + 含义
- 还原步骤（CLI + UI）
- R2 缺失语义（如果 include_assets=0，images 全 ref-only）
- 警告：`/api/_/import` 是清空式的

写入 README.md 当个独立文件。

---

## 四、Client 设计

### 4.1 `/_/inspect` 加 "Data" tab

`src/routes/inspect.tsx` 现有 `tab` state `'tool_calls' | 'cost'`。扩展为加 `'data'`：

```tsx
const [tab, setTab] = useState<'tool_calls' | 'cost' | 'data'>('tool_calls');
// ...
<button onClick={() => setTab('data')}>Data</button>
```

新组件 `DataTab`（同文件内）：

```tsx
function DataTab() {
  const [confirmText, setConfirmText] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function downloadExport(includeAssets: boolean) {
    setDownloading(true);
    setDownloadBytes(0);
    setDownloadError(null);
    const url = includeAssets ? '/api/_/export?include_assets=1' : '/api/_/export';
    try {
      const res = await fetch(url, { headers: { 'x-internal-token': INTERNAL_TOKEN } });
      if (!res.ok) {
        const text = await res.text();
        setDownloadError(`${res.status}: ${text}`);
        return;
      }
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.length;
        setDownloadBytes(bytes);
      }
      const blob = new Blob(chunks, { type: 'application/zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `loom-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  async function runImport() {
    if (!importFile) return;
    if (confirmText !== 'wipe') {
      setImportStatus('请先在 confirm 框内输入 "wipe" 字样');
      return;
    }
    setImportStatus('清空 + 还原中...');
    const ab = await importFile.arrayBuffer();
    const res = await fetch('/api/_/import?confirm=wipe-and-reload', {
      method: 'POST',
      headers: {
        'x-internal-token': INTERNAL_TOKEN,
        'content-type': 'application/zip',
      },
      body: ab,
    });
    if (res.ok) {
      const body = (await res.json()) as { stats: unknown; assets_uploaded: number };
      setImportStatus(`完成。assets uploaded: ${body.assets_uploaded}。3 秒后刷新页面...`);
      // Force-reload — TanStack Query cache and component state would otherwise show
      // pre-import data. Simpler than walking every queryKey to invalidate.
      setTimeout(() => window.location.reload(), 3000);
    } else {
      const text = await res.text();
      setImportStatus(`失败: ${res.status} ${text}`);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-base font-medium">下载备份</h2>
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => downloadExport(false)}
            disabled={downloading}
            className="px-3 py-1.5 bg-slate-900 text-white text-sm rounded disabled:opacity-50"
          >
            data only (refs)
          </button>
          <button
            onClick={() => downloadExport(true)}
            disabled={downloading}
            className="px-3 py-1.5 bg-slate-700 text-white text-sm rounded disabled:opacity-50"
          >
            full (含 R2 图片)
          </button>
        </div>
        {downloading && (
          <p className="text-sm text-slate-600 mt-2">
            已下载 {(downloadBytes / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
        {downloadError && <p className="text-sm text-red-600 mt-2">{downloadError}</p>}
      </section>

      <section>
        <h2 className="text-base font-medium text-red-700">还原（清空式）</h2>
        <p className="text-xs text-slate-500 mt-1">
          这个动作会删除所有 D1 数据 + R2 图片，然后从你上传的 ZIP 重装。
        </p>
        <div className="mt-2 space-y-2">
          <input type="file" accept=".zip" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder='输入 "wipe" 确认'
            className="border px-2 py-1 text-sm rounded"
          />
          <button
            onClick={runImport}
            disabled={!importFile || confirmText !== 'wipe'}
            className="px-3 py-1.5 bg-red-700 text-white text-sm rounded disabled:opacity-40"
          >
            清空并还原
          </button>
          {importStatus && <p className="text-sm text-slate-600">{importStatus}</p>}
        </div>
      </section>
    </div>
  );
}
```

### 4.2 文件 / 模块边界

| 路径 | 责任 | 新建 / 修改 |
|---|---|---|
| `workers/src/export/constants.ts` | `SCHEMA_VERSION`, `FK_ORDER` | 新 |
| `workers/src/export/csv.ts` | mistakes / review_events CSV builders | 新 |
| `workers/src/export/csv.test.ts` | CSV builder unit tests | 新 |
| `workers/src/export/readme.ts` | README 字符串 builder | 新 |
| `workers/src/routes/export.ts` | GET endpoint + ZIP streaming | 新 |
| `workers/src/routes/export.test.ts` | endpoint integration tests | 新 |
| `workers/src/routes/import.ts` | POST endpoint + wipe + reinsert | 新 |
| `workers/src/routes/import.test.ts` | import integration tests + round-trip | 新 |
| `workers/src/index.ts` | mount 两个 route | 改 |
| `package.json` | 加 `client-zip` + `fflate` deps | 改 |
| `src/routes/inspect.tsx` | 加 `Data` tab | 改 |
| `PLANNING.md` | 标 Sub 5 完成 | 改 |
| `docs/superpowers/specs/2026-05-10-phase1a-sub5-design.md` | 本文件 | 新 |

---

## 五、约束 / 不变量

- **schema_version 严格相等**：1.0 不能 import 1.1（哪怕 backward-compat 看起来 OK）；防数据 silently corrupt
- **import 是破坏性操作**：endpoint 必须 `?confirm=wipe-and-reload`；UI 必须输入 "wipe"；CLI 必须显式带 query
- **FK 拓扑序单一来源**：`FK_ORDER` 常量；export 顺序、wipe reverse 顺序、insert forward 顺序都引用它；改 schema 时只改一处
- **CSV 是 derived view**：不参与 import；mistakes.csv / review_events.csv 完全可丢失重建；data.json 才是真相
- **R2 不在 D1 batch**：每个 R2.put 独立失败；不影响 D1 已落
- **半失败可重跑**：D1 wipe 后 insert 失败 → 用户拿同 ZIP 重 import（前面已清空，无 UNIQUE 冲突）
- **没有 UNDO**：import 完不能回滚；上一份备份 ZIP 是唯一退路 → README 强调"先 export 当前再 import 新的"
- **ZIP 结构稳定**：manifest.json + data.json + 2 CSV + README.md 5 文件必有；assets/ 目录可选

---

## 六、估时 / PR

| 段 | 任务 | 估时 |
|---|---|---|
| Schema topo + manifest | FK_ORDER + MAX_INLINE_ASSETS + manifest 生成 + readme builder | ~0.1d |
| Export endpoint | client-zip + 流式 R2 + Content-Disposition + asset-count guard | ~0.4d |
| CSV builders | mistakes / review_events JOIN 序列化 | ~0.3d |
| Import endpoint | fflate + wipe + chunked insert + R2 put | ~0.5d |
| Inspect UI Data tab | 2 button + 流式 progress + file input + confirm 输入 + reload | ~0.3d |
| 测试 | 8+ 测试（含 round-trip + too_many_assets 守卫 + schema_version mismatch） | ~0.4d |
| README + PLANNING + R2 旁路脚本 | docs | ~0.2d |
| **合计** | | **~2.2d** |

**1 个 PR**：`feat(export): Phase 1a Sub 5 — D1 + R2 backup/restore via ZIP`

---

## 七、决策（用户已 lock 2026-05-10）

1. **下载进度条** — **lock 实现**。`fetch()` → 读 `Response.body` ReadableStream + 累积 `bytesRead / Content-Length`，在 inspect Data tab 显示 0–100% 进度条。export 端响应头要带 `Content-Length`（client-zip 流式不知道最终长度，但可以**先把 entries 拼成 Blob 后再 send**，牺牲一点首包延迟换 Content-Length —— 或者不带 length 改显示"已下载 N MB"无 % 文案）。MVP 走"已下载 N MB"无总长方案，简单可行；进度条逻辑：
   ```ts
   const res = await fetch('/api/_/export');
   const reader = res.body!.getReader();
   const total = Number(res.headers.get('content-length') ?? 0); // 0 if unknown
   let bytes = 0;
   const chunks: Uint8Array[] = [];
   for (;;) {
     const { done, value } = await reader.read();
     if (done) break;
     chunks.push(value);
     bytes += value.length;
     setProgress({ bytes, total });
   }
   const blob = new Blob(chunks, { type: 'application/zip' });
   // ...trigger download
   ```

2. **Worker 子请求超 50（>50 R2 assets）** — **lock 三层方案**：
   - **Tier A（默认行为）**：MVP `?include_assets=1` 时，server 端如果 `source_asset.length > 45`（留 5 个给 D1 SELECT），返回 `400 + {error: 'too_many_assets', count, suggested: 'use ?include_assets=0 then wrangler r2 cp sidecar'}`。
   - **Tier B（用户解决）**：refs-only export + 旁路 `wrangler r2 cp r2://learning-project-images/<key> ./assets/<key>` 拉每张图。README 提供脚本：
     ```bash
     # extract storage_keys from manifest
     jq -r '.row_counts.source_asset' manifest.json
     # then for each key:
     wrangler r2 cp "r2://learning-project-images/<key>" "./assets/<key>"
     ```
   - **Tier C（Phase 2）**：升级 Workers 付费版（1000 子请求上限）或引入 Workers Queue + R2-staged ZIP（async job 模型）。Sub 5 不实现。
   - 阈值 45 写成 `MAX_INLINE_ASSETS` 常量，付费版上调到 ~950。

3. **CSV newline 处理** — lock。`csvEscape` 已处理；README 加一行"建议 LibreOffice / `csv.reader` 解析；Excel for Mac 可能识别 \n 为多行"。

4. **schema_version bump 流程** — lock：在 `src/db/schema.ts` 文件顶加常量 + 注释 `/* Bump SCHEMA_VERSION in workers/src/export/constants.ts whenever this file changes */`，靠人肉 + code review 维护。CI guard 暂不引入（YAGNI）。

5. **ZIP 包大小上限** — lock：默认 `?include_assets=0`；用户要带图就自觉走 wrangler r2 cp 旁路。Server 不强制 cap。

6. **import 后 React Query cache** — lock：import 成功 alert + `window.location.reload()`。

7. **mistakes.csv prompt_md 全文** — lock。CSV 列 `prompt_md` 写完整文本；`csvEscape` 保证 quoting 正确。
---

## 八、依赖（OSS）

| 包 | 大小 | 用途 | License |
|---|---|---|---|
| `client-zip` | ~3KB | export ZIP 流式编码 | MIT |
| `fflate` | ~50KB | import ZIP 解码 | MIT |

两个都已是 ES module + Workers-compatible。安装：

```bash
pnpm add client-zip fflate
```
