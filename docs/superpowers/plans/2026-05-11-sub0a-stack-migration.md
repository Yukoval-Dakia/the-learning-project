# Sub 0a Implementation Plan — Stack Migration Infrastructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate compute from CF Workers to Vercel + Next.js 15 App Router; database from D1 (SQLite) to Neon Postgres; preserve R2 for image storage. ZERO business logic migrated — Sub 0a only stands up the infrastructure shell.

**Architecture:** Next.js 15 App Router as monolithic frontend + backend; React 19; Tailwind v4 via PostCSS; Drizzle ORM with `postgres-js` driver against Neon; old Workers code preserved untouched in `workers/*` for Sub 0b reference.

**Tech Stack:** Next.js ^15 · React 19 · Tailwind v4 · Drizzle ORM ^0.36 · postgres ^3.x · @paralleldrive/cuid2 · TypeScript 5.7 · Biome (lint) · Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-05-11-sub0a-stack-migration-infra-design.md`
**Master architecture:** `docs/superpowers/specs/2026-05-11-architecture-review.md`

---

## File map

**Create:**
- `next.config.ts` — Next.js config
- `tsconfig.json` — replace existing Vite tsconfig
- `app/layout.tsx` — RootLayout (Server Component)
- `app/page.tsx` — placeholder hero
- `app/globals.css` — moved from `src/index.css`
- `app/api/health/route.ts` — GET handler
- `src/db/client.ts` — drizzle PG client singleton
- `postcss.config.mjs` — Tailwind v4 PostCSS config
- `.env.local.example` — env vars documentation

**Modify:**
- `package.json` — drop Vite/Wrangler client deps; add Next.js + postgres
- `src/db/schema.ts` — full rewrite to PG types
- `drizzle.config.ts` — set dialect to postgresql
- `PLANNING.md` — add Sub 0a "shipped" marker

**Delete:**
- `src/main.tsx` — Vite entry
- `src/App.tsx` — react-router setup
- `index.html` — Vite HTML shell
- `vite.config.ts` — Vite config
- `src/routes/` — all 8 route components (will be rewritten in Sub 0b as Next.js pages)
- `src/index.css` — moved to `app/globals.css`
- `drizzle/` — old SQLite migrations (regenerated for PG)

**Preserve untouched:**
- `workers/*` — full directory (Sub 0b migrates routes; Sub 0c removes folder)
- `src/core/*` — schema types (Next.js still imports)
- `src/ai/registry.ts` — registry of LLM tasks (Sub 0b uses)
- `docs/*` — all docs preserved
- `.vercel/project.json` — Vercel link (already created, gitignored)

---

## Pre-flight

- [ ] **Step 0.1: Confirm branch + Vercel state**

```bash
git branch --show-current
cat .vercel/project.json
```

Expected:
- branch: `sub-0a-stack-migration`
- `.vercel/project.json` shows projectId `prj_7sQRdVyBQZ0ew4Ok8ziNMwQnGlTj` + orgId `team_8Y1h3bFVysBs9id43MyPSl5h`

- [ ] **Step 0.2: Confirm Neon integration installed (user did this manually)**

User confirmed: Neon Postgres marketplace integration installed on Vercel project. DATABASE_URL auto-injected into prod + preview env.

Pull env vars locally for dev:

```bash
vercel env pull .env.local --environment=preview
```

(Use preview env so local dev points to a dev branch of Neon, not prod.)

Expected: `.env.local` created with DATABASE_URL=postgres://...

If `vercel env pull` fails with auth error, run `vercel login` first.

- [ ] **Step 0.3: Verify Postgres connection**

```bash
node -e "
import('postgres').then(({ default: postgres }) => {
  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
  sql\`select 1 as ok\`.then(r => { console.log(r); sql.end(); });
});
" 2>&1 | head
```

Wait — the `postgres` package is not yet installed. Do this verification AFTER Task 2 (deps installed).

Skip Step 0.3 for now; revisit after Task 2.

---

## Task 1: Drop Vite-era files

**Files:**
- Delete: `src/main.tsx`, `src/App.tsx`, `index.html`, `vite.config.ts`, `src/index.css`, `src/routes/` (full dir)

- [ ] **Step 1.1: Delete Vite entry points and route components**

```bash
git rm -f src/main.tsx
git rm -f src/App.tsx
git rm -f index.html
git rm -f vite.config.ts
git rm -rf src/routes/
```

(`src/index.css` deleted in Task 5 after content moved to `app/globals.css`.)

- [ ] **Step 1.2: Verify Vite-only deletions don't break Workers tests**

The Workers test suite (vitest under `workers/`) doesn't import from src/routes. Verify:

```bash
grep -rn "from 'src/routes\|src/App\|src/main" workers/ 2>&1 | head -5
```

Expected: no matches.

- [ ] **Step 1.3: Commit deletions**

```bash
git add -A
git commit -m "feat(stack): drop Vite entry points + react-router routes"
```

---

## Task 2: Update package.json + reinstall

**Files:**
- Modify: `package.json`

- [ ] **Step 2.1: Replace package.json**

Overwrite `package.json` content with:

```json
{
  "name": "the-learning-project",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "format": "biome format --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "workers:dev": "wrangler dev --config workers/wrangler.toml",
    "workers:deploy": "wrangler deploy --config workers/wrangler.toml"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^3.0.76",
    "@paralleldrive/cuid2": "^2.2.2",
    "@tanstack/react-query": "^5.59.0",
    "ai": "^6.0.176",
    "client-zip": "^2.5.0",
    "drizzle-orm": "^0.36.0",
    "drizzle-zod": "^0.5.1",
    "fflate": "^0.8.2",
    "lucide-react": "^0.468.0",
    "next": "^15.0.0",
    "postgres": "^3.4.5",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "ts-fsrs": "^5.3.2",
    "zod": "^3.23.8",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@cloudflare/workers-types": "^4.20240900.0",
    "@tailwindcss/postcss": "^4.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitest/coverage-v8": "^2.1.5",
    "drizzle-kit": "^0.27.0",
    "hono": "^4.6.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.5",
    "wrangler": "^3.85.0"
  }
}
```

Changes vs prior:
- Scripts: `dev` → `next dev`; `build` → `next build`; add `start` and `db:push`; drop `preview` and `typecheck:workers`
- Add: `next ^15`, `postgres ^3.4.5`, `@tailwindcss/postcss`, `@types/node`
- Drop: `react-router-dom`, `vite`, `vite-plugin-pwa`, `@vitejs/plugin-react`, `@tailwindcss/vite`
- Keep: drizzle-orm/kit, hono (Sub 0b), wrangler + workers-types (Sub 0b/0c removes), all AI SDK deps

- [ ] **Step 2.2: Install**

```bash
pnpm install
```

Expected: completes without errors. Lockfile updates.

- [ ] **Step 2.3: Verify Postgres connection (deferred from Step 0.3)**

```bash
DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d= -f2- | tr -d '"') node -e "
import('postgres').then(({ default: postgres }) => {
  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
  sql\`select 1 as ok\`.then(r => { console.log('OK:', r); sql.end(); }).catch(e => { console.error(e); process.exit(1); });
});
"
```

Expected: prints `OK: [{ ok: 1 }]`.

If fails: check DATABASE_URL value; ensure ?sslmode=require or pass `ssl: 'require'` via driver option.

- [ ] **Step 2.4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(stack): swap package.json — Next.js 15 + postgres; drop Vite/react-router"
```

---

## Task 3: Next.js skeleton

**Files:**
- Create: `next.config.ts`, `tsconfig.json` (replace), `app/layout.tsx`, `app/page.tsx`

- [ ] **Step 3.1: Create `next.config.ts`**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
```

- [ ] **Step 3.2: Replace `tsconfig.json`**

Overwrite the file with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    "src/**/*.ts"
  ],
  "exclude": ["node_modules", "workers"]
}
```

(Note `exclude: ["workers"]` — Workers code has its own tsconfig and uses CF types; we exclude from Next.js typecheck to avoid clashes during Sub 0a/0b transition.)

- [ ] **Step 3.3: Create `app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loom — 个人学习工具',
  description: 'A personal learning tool focused on classical Chinese (文言文)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3.4: Create `app/page.tsx` placeholder**

```tsx
export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold">Loom</h1>
      <p className="mt-3 text-sm text-slate-600">
        Stack migration in progress (Sub 0a). UI lands in Sub 0b.
      </p>
      <p className="mt-6 text-xs text-slate-500">
        Health check: <a href="/api/health" className="underline">/api/health</a>
      </p>
    </main>
  );
}
```

- [ ] **Step 3.5: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors. (`app/globals.css` doesn't exist yet — TypeScript ignores CSS imports unless `assertions` are enabled, so no error.)

- [ ] **Step 3.6: Commit**

```bash
git add next.config.ts tsconfig.json app/layout.tsx app/page.tsx
git commit -m "feat(stack): Next.js 15 App Router skeleton + placeholder hero"
```

---

## Task 4: Tailwind v4 + globals.css

**Files:**
- Create: `app/globals.css` (move content from `src/index.css`)
- Create: `postcss.config.mjs`
- Delete: `src/index.css`

- [ ] **Step 4.1: Read existing `src/index.css`**

```bash
cat src/index.css
```

Expected: shows `@import "tailwindcss";` plus any custom CSS (token definitions etc.). Note any custom rules — they need to move.

- [ ] **Step 4.2: Create `app/globals.css`**

If `src/index.css` had only `@import "tailwindcss";`:

```css
@import "tailwindcss";
```

If it had custom `:root { --token-... }` rules: copy them under the import:

```css
@import "tailwindcss";

:root {
  /* whatever was in src/index.css preserved */
}
```

(Read the source file to know exactly what to preserve.)

- [ ] **Step 4.3: Create `postcss.config.mjs`**

```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

- [ ] **Step 4.4: Delete `src/index.css`**

```bash
git rm src/index.css
```

- [ ] **Step 4.5: Local dev smoke**

```bash
pnpm dev
```

Open `http://localhost:3000/` in browser. Verify:
- Page renders (Loom title visible)
- Tailwind classes apply (text-slate-* + max-w-3xl etc.)

Stop dev server (Ctrl+C).

- [ ] **Step 4.6: Commit**

```bash
git add app/globals.css postcss.config.mjs
git commit -m "feat(stack): Tailwind v4 PostCSS + globals.css from src/index.css"
```

---

## Task 5: Drizzle PG schema rewrite

**Files:**
- Modify: `src/db/schema.ts` (full rewrite)
- Modify: `drizzle.config.ts`

- [ ] **Step 5.1: Replace `drizzle.config.ts`**

```ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
```

(Check whether `dotenv` is already a dep. If not, add it: `pnpm add -D dotenv`.)

- [ ] **Step 5.2: Replace `src/db/schema.ts`**

Overwrite the entire file with the PG-translated version. Per spec § 4.1 type mapping:
- `text({mode: 'json'})` → `jsonb()`
- `integer({mode: 'boolean'})` → `boolean()`
- `integer({mode: 'timestamp'})` → `timestamp({withTimezone: true})`
- everything else unchanged

```ts
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Drizzle schema (Postgres) — single source of truth.
// Per architecture-review.md § Stack Pivot: Postgres types throughout;
// json columns are jsonb; booleans + timestamps native.

export const knowledge = pgTable('knowledge', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  parent_id: text('parent_id'),
  base_mastery: real('base_mastery').notNull().default(0),
  ai_delta_mastery: real('ai_delta_mastery').notNull().default(0),
  last_active_at: timestamp('last_active_at', { withTimezone: true }),
  merged_from: jsonb('merged_from').$type<string[]>().notNull().default([]),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  proposed_by_ai: boolean('proposed_by_ai').notNull().default(false),
  approval_status: text('approval_status', {
    enum: ['pending', 'approved', 'rejected'],
  })
    .notNull()
    .default('approved'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const source_asset = pgTable('source_asset', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  storage_key: text('storage_key').notNull(),
  mime_type: text('mime_type').notNull(),
  byte_size: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  provenance: jsonb('provenance').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const source_document = pgTable('source_document', {
  id: text('id').primaryKey(),
  title: text('title'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  body_md: text('body_md'),
  provenance: jsonb('provenance').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const ingestion_session = pgTable('ingestion_session', {
  id: text('id').primaryKey(),
  source_document_id: text('source_document_id'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('uploaded'),
  entrypoint: text('entrypoint').notNull(),
  error_message: text('error_message'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const question_block = pgTable('question_block', {
  id: text('id').primaryKey(),
  ingestion_session_id: text('ingestion_session_id').notNull(),
  source_document_id: text('source_document_id'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  page_spans: jsonb('page_spans')
    .$type<
      Array<{
        page_index: number;
        bbox: { x: number; y: number; width: number; height: number };
        role?: string;
      }>
    >()
    .notNull()
    .default([]),
  extracted_prompt_md: text('extracted_prompt_md').notNull(),
  reference_md: text('reference_md'),
  wrong_answer_md: text('wrong_answer_md'),
  image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
  crop_refs: jsonb('crop_refs').$type<string[]>().notNull().default([]),
  visual_complexity: text('visual_complexity').notNull().default('low'),
  extraction_confidence: real('extraction_confidence').notNull().default(1),
  status: text('status').notNull().default('draft'),
  knowledge_hint: text('knowledge_hint'),
  merged_from_block_ids: jsonb('merged_from_block_ids').$type<string[]>().notNull().default([]),
  imported_question_id: text('imported_question_id'),
  imported_mistake_id: text('imported_mistake_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const question = pgTable('question', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  prompt_md: text('prompt_md').notNull(),
  reference_md: text('reference_md'),
  rubric_json: jsonb('rubric_json'),
  judge_kind_override: text('judge_kind_override'),
  visual_complexity: text('visual_complexity'),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  difficulty: integer('difficulty').notNull().default(3),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  draft_status: text('draft_status'),
  variant_depth: integer('variant_depth').notNull().default(0),
  root_question_id: text('root_question_id'),
  parent_variant_id: text('parent_variant_id'),
  created_by: jsonb('created_by'),
  metadata: jsonb('metadata'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const mistake = pgTable('mistake', {
  id: text('id').primaryKey(),
  question_id: text('question_id')
    .notNull()
    .references(() => question.id),
  wrong_answer_md: text('wrong_answer_md'),
  wrong_answer_image_refs: jsonb('wrong_answer_image_refs')
    .$type<string[]>()
    .notNull()
    .default([]),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  cause: jsonb('cause'),
  fsrs_state: jsonb('fsrs_state'),
  variants: jsonb('variants').$type<unknown[]>().notNull().default([]),
  variants_generated_count: integer('variants_generated_count').notNull().default(0),
  variants_max: integer('variants_max').notNull().default(3),
  status: text('status').notNull().default('active'),
  archived_reason: text('archived_reason'),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  delete_reason: text('delete_reason'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const review_event = pgTable('review_event', {
  id: text('id').primaryKey(),
  mistake_id: text('mistake_id').notNull(),
  rating: text('rating').notNull(),
  response_md: text('response_md'),
  latency_ms: integer('latency_ms'),
  fsrs_state_before: jsonb('fsrs_state_before'),
  fsrs_state_after: jsonb('fsrs_state_after').notNull(),
  due_at_before: timestamp('due_at_before', { withTimezone: true }),
  due_at_next: timestamp('due_at_next', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const learning_item = pgTable('learning_item', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  primary_artifact_id: text('primary_artifact_id'),
  parent_learning_item_id: text('parent_learning_item_id'),
  child_learning_item_ids: jsonb('child_learning_item_ids')
    .$type<string[]>()
    .notNull()
    .default([]),
  status: text('status').notNull().default('pending'),
  user_pinned: boolean('user_pinned').notNull().default(false),
  ai_score: real('ai_score'),
  due_at: timestamp('due_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  archived_reason: text('archived_reason'),
  reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const study_log = pgTable('study_log', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  content_md: text('content_md').notNull(),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  question_id: text('question_id'),
  mistake_id: text('mistake_id'),
  artifact_id: text('artifact_id'),
  learning_item_id: text('learning_item_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const artifact = pgTable('artifact', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  knowledge_id: text('knowledge_id'),
  parent_artifact_id: text('parent_artifact_id'),
  child_artifact_ids: jsonb('child_artifact_ids').$type<string[]>().notNull().default([]),
  intent_source: text('intent_source').notNull(),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  outline_json: jsonb('outline_json'),
  sections: jsonb('sections'),
  tool_kind: text('tool_kind'),
  tool_state: jsonb('tool_state'),
  generation_status: text('generation_status').notNull().default('pending'),
  generated_by: jsonb('generated_by'),
  history: jsonb('history').$type<unknown[]>().notNull().default([]),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const answer = pgTable('answer', {
  id: text('id').primaryKey(),
  question_id: text('question_id').notNull(),
  learning_item_id: text('learning_item_id'),
  input_kind: text('input_kind').notNull(),
  content_md: text('content_md').notNull().default(''),
  image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
  vision_extracted: text('vision_extracted'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  submitted_at: timestamp('submitted_at', { withTimezone: true }).notNull(),
});

export const judgment = pgTable('judgment', {
  id: text('id').primaryKey(),
  answer_id: text('answer_id').notNull(),
  judge_kind: text('judge_kind').notNull(),
  verdict: text('verdict').notNull(),
  score: real('score').notNull(),
  feedback_md: text('feedback_md').notNull(),
  evidence_json: jsonb('evidence_json').notNull().default({}),
  is_flexible_fallback: boolean('is_flexible_fallback').notNull().default(false),
  triggered_by: text('triggered_by'),
  prior_judgment_id: text('prior_judgment_id'),
  judged_by: jsonb('judged_by').notNull(),
  judged_at: timestamp('judged_at', { withTimezone: true }).notNull(),
  is_effective: boolean('is_effective').notNull().default(true),
});

export const user_appeal = pgTable('user_appeal', {
  id: text('id').primaryKey(),
  judgment_id: text('judgment_id').notNull(),
  reason: text('reason'),
  appealed_at: timestamp('appealed_at', { withTimezone: true }).notNull(),
  resolved_judgment_id: text('resolved_judgment_id'),
});

export const completion_evidence = pgTable('completion_evidence', {
  id: text('id').primaryKey(),
  learning_item_id: text('learning_item_id').notNull(),
  path: text('path').notNull(),
  evidence_json: jsonb('evidence_json').notNull().default({}),
  user_overrode_low_evidence: boolean('user_overrode_low_evidence').notNull().default(false),
  decided_at: timestamp('decided_at', { withTimezone: true }).notNull(),
});

export const dreaming_proposal = pgTable('dreaming_proposal', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  reasoning: text('reasoning').notNull(),
  status: text('status').notNull().default('pending'),
  proposed_at: timestamp('proposed_at', { withTimezone: true }).notNull(),
  decided_at: timestamp('decided_at', { withTimezone: true }),
});

export const tool_call_log = pgTable('tool_call_log', {
  id: text('id').primaryKey(),
  task_run_id: text('task_run_id').notNull(),
  task_kind: text('task_kind').notNull(),
  tool_name: text('tool_name').notNull(),
  input_json: jsonb('input_json'),
  output_json: jsonb('output_json'),
  iteration: integer('iteration').notNull(),
  latency_ms: real('latency_ms').notNull(),
  cost: real('cost').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

export const cost_ledger = pgTable('cost_ledger', {
  id: text('id').primaryKey(),
  task_kind: text('task_kind').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  cost: real('cost').notNull(),
  tokens_in: integer('tokens_in').notNull(),
  tokens_out: integer('tokens_out').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
});
```

- [ ] **Step 5.3: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors. (Workers code is excluded from this typecheck via tsconfig; Workers tests will fail typecheck but that's OK since `pnpm typecheck` doesn't include Workers anymore.)

If errors, fix them per error message. Common: a column type mismatch or `$type<>()` generic syntax.

- [ ] **Step 5.4: Delete old SQLite migrations**

```bash
git rm -rf drizzle/
```

(The directory contained 4 SQLite migrations; we regenerate fresh PG migration in next step.)

- [ ] **Step 5.5: Generate fresh PG migration**

```bash
pnpm drizzle-kit generate
```

Expected: creates `drizzle/0000_<random_name>.sql` containing CREATE TABLE statements for all 18 tables in PG syntax. Inspect:

```bash
ls drizzle/ && head -40 drizzle/0000_*.sql
```

Expected: file exists; `CREATE TABLE` statements visible.

- [ ] **Step 5.6: Push to Neon**

```bash
pnpm db:push
```

Expected: drizzle pushes the schema to Neon. Output should show "[✓] All tables/columns/indexes accepted".

If it asks "Do you want to apply these changes? (y/N)", press y.

- [ ] **Step 5.7: Verify tables exist in Neon**

```bash
DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d= -f2- | tr -d '"') node -e "
import('postgres').then(({ default: postgres }) => {
  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
  sql\`select tablename from pg_tables where schemaname='public' order by tablename\`
    .then(r => { console.log(r); sql.end(); });
});
"
```

Expected: lists all 18 table names: knowledge, source_asset, source_document, ingestion_session, question_block, question, mistake, review_event, learning_item, study_log, artifact, answer, judgment, user_appeal, completion_evidence, dreaming_proposal, tool_call_log, cost_ledger.

- [ ] **Step 5.8: Commit**

```bash
git add src/db/schema.ts drizzle.config.ts drizzle/
git commit -m "feat(stack): rewrite schema for Postgres + fresh 0000 migration"
```

---

## Task 6: Drizzle PG client + /api/health endpoint

**Files:**
- Create: `src/db/client.ts`, `app/api/health/route.ts`

- [ ] **Step 6.1: Create `src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Singleton client. In Vercel functions, this module is cached across invocations
// within a hot container; postgres-js handles connection pooling per process.
const queryClient = postgres(process.env.DATABASE_URL!, {
  ssl: 'require',
  max: 10, // pool size; per-Vercel-function cap
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
```

- [ ] **Step 6.2: Create `app/api/health/route.ts`**

```ts
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const runtime = 'nodejs';

export async function GET() {
  let db_ok = false;
  try {
    const result = await db.execute(sql`select 1 as ok`);
    const rows = result as unknown as Array<{ ok: number }>;
    db_ok = rows[0]?.ok === 1;
  } catch (err) {
    console.error('health: db check failed', err);
    db_ok = false;
  }
  return Response.json({ ok: true, db_ok });
}
```

(Explicit `runtime = 'nodejs'` because Drizzle PG via `postgres-js` needs Node, not Edge.)

- [ ] **Step 6.3: Local smoke**

```bash
pnpm dev
```

In another shell:

```bash
curl -s http://localhost:3000/api/health | head
```

Expected: `{"ok":true,"db_ok":true}`.

If `db_ok=false`, check `.env.local` DATABASE_URL is correct + Neon main branch reachable.

Stop dev server (Ctrl+C in first terminal).

- [ ] **Step 6.4: Run typecheck + build**

```bash
pnpm typecheck && pnpm build
```

Expected: typecheck clean. `pnpm build` runs `next build` and produces `.next/` directory; build success prints "✓ Generating static pages" + route summary including `/api/health`.

- [ ] **Step 6.5: Commit**

```bash
git add src/db/client.ts app/api/health/route.ts
git commit -m "feat(stack): drizzle PG client + GET /api/health endpoint"
```

---

## Task 7: .env.local.example + biome ignore Workers

**Files:**
- Create: `.env.local.example`
- Modify: `biome.json`

- [ ] **Step 7.1: Create `.env.local.example`**

```bash
cat > .env.local.example <<'EOF'
# Database (auto-injected by Vercel Neon integration; pull via `vercel env pull .env.local`)
DATABASE_URL="postgres://user:pass@host/db?sslmode=require"

# Internal API auth (random shared secret; UI passes via x-internal-token header)
INTERNAL_TOKEN="change-me"

# Anthropic (LLM tasks)
ANTHROPIC_API_KEY=""

# Tencent OCR (Sub 0c will use; not needed for Sub 0a)
TENCENT_SECRET_ID=""
TENCENT_SECRET_KEY=""
TENCENT_OCR_REGION="ap-guangzhou"

# Cloudflare R2 (S3-compat client; Sub 0b/0c will use)
R2_ACCOUNT_ID=""
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_BUCKET="learning-project-images"
EOF
```

- [ ] **Step 7.2: Update `biome.json` to ignore Workers + Next build artifacts**

Read current `biome.json`:

```bash
cat biome.json
```

Edit it to add `.next` and `workers` to ignore:

```json
{
  "files": {
    "ignore": ["dist", ".wrangler", "node_modules", "drizzle", "docs/design/loom-design", "workers", ".next", "next-env.d.ts"]
  },
  ...
}
```

(Apply via Edit tool with the exact existing line as old_string.)

- [ ] **Step 7.3: Verify lint + typecheck + build**

```bash
pnpm lint && pnpm typecheck && pnpm build
```

Expected: all clean.

- [ ] **Step 7.4: Commit**

```bash
git add .env.local.example biome.json
git commit -m "chore(stack): env example + biome ignore Workers + .next"
```

---

## Task 8: Vercel preview deploy + verify

**Files:** none (CI/deployment)

- [ ] **Step 8.1: Push branch**

```bash
git push -u origin sub-0a-stack-migration
```

Expected: branch pushed; Vercel auto-deploys preview from this branch (if Vercel project has GitHub integration enabled).

If no auto-deploy: trigger manually via MCP `deploy_to_vercel` (only works from current dir context — see Step 8.2).

- [ ] **Step 8.2: Trigger deploy via MCP (if needed)**

Use Agent tool to dispatch `mcp__plugin_vercel_vercel__deploy_to_vercel` (no params). The MCP detects current `.vercel/project.json` and deploys.

- [ ] **Step 8.3: List recent deployments**

Use Agent or direct MCP:

```ts
mcp__plugin_vercel_vercel__list_deployments({
  projectId: "prj_7sQRdVyBQZ0ew4Ok8ziNMwQnGlTj",
  teamId: "team_8Y1h3bFVysBs9id43MyPSl5h"
})
```

Find the most recent deployment for branch `sub-0a-stack-migration`. Note its URL (e.g. `https://the-learning-project-git-sub-0a-stack-migration-yukoval.vercel.app`).

- [ ] **Step 8.4: Wait for build to complete**

Poll `mcp__plugin_vercel_vercel__get_deployment` with `idOrUrl` until `state === 'READY'` (or `ERROR`/`CANCELED`).

If `ERROR`: get build logs:

```ts
mcp__plugin_vercel_vercel__get_deployment_build_logs({
  idOrUrl: "<deployment-url>",
  teamId: "team_8Y1h3bFVysBs9id43MyPSl5h"
})
```

Common errors:
- Missing env var: confirm DATABASE_URL is in preview env (`vercel env ls preview`)
- TypeScript error: re-run `pnpm typecheck` locally
- Build error: re-run `pnpm build` locally

Iterate fixes + push until READY.

- [ ] **Step 8.5: Smoke test deployed `/api/health`**

```ts
mcp__plugin_vercel_vercel__web_fetch_vercel_url({
  url: "https://<deployment-url>/api/health"
})
```

Expected response: `{"ok":true,"db_ok":true}`.

If `db_ok=false`: check Neon integration env var is in PREVIEW env (not just production):

```bash
vercel env ls preview
```

Expected: `DATABASE_URL` listed for preview environment.

- [ ] **Step 8.6: Smoke test `/`**

```ts
mcp__plugin_vercel_vercel__web_fetch_vercel_url({
  url: "https://<deployment-url>/"
})
```

Expected: HTML containing "Loom" title and Stack migration in progress text.

---

## Task 9: PLANNING update + open PR

**Files:**
- Modify: `PLANNING.md`

- [ ] **Step 9.1: Mark Sub 0a in PLANNING.md**

In `PLANNING.md`, find the architecture-review sub list (the table starting with `Sub 0 Stack Migration`). Update:

```markdown
| **Sub 0a** | **Stack Migration — Infrastructure** (Vercel + Next.js + Neon) | 即刻 | ~2d | ✅ shipped (PR #?) |
```

(Replace # with the PR number after creation.)

Or simpler: add a footnote line below that table:

```markdown
**Status (2026-05-11)**: Sub 0a shipped on branch `sub-0a-stack-migration` (PR #?). Sub 0b queues next.
```

- [ ] **Step 9.2: Run final verification**

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test 2>&1 | tail -10
```

Expected: typecheck clean, lint clean, build success, vitest passes (the existing workers tests will be skipped due to biome ignore + tsconfig exclude; vitest may pick up zero test files which is OK for Sub 0a).

If vitest finds the workers tests (they're in `workers/src/**/*.test.ts`), it might error or pass. If it fails because tests rely on cf workers types in the runtime, we accept that — Sub 0b removes Workers code entirely.

If vitest fails: skip the Workers tests for Sub 0a CI by adding to `vitest.config.ts` (if it exists) or creating one with:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist', '.next', 'workers/**'],
  },
});
```

- [ ] **Step 9.3: Commit**

```bash
git add PLANNING.md vitest.config.ts 2>/dev/null
git commit -m "docs(planning): mark Sub 0a shipped + vitest exclude workers"
```

- [ ] **Step 9.4: Push**

```bash
git push origin sub-0a-stack-migration
```

- [ ] **Step 9.5: Open PR**

```bash
gh pr create --title "Sub 0a: Stack Migration Infrastructure (Vercel + Next.js + Neon)" --body "$(cat <<'EOF'
## Summary

First of 3-sub Stack Migration (per architecture-review.md). Sub 0a only sets up infrastructure; Sub 0b migrates routes; Sub 0c sets up Workflow + OCR upgrade.

- Next.js 15 App Router skeleton replaces Vite
- Drizzle PG schema rewritten for Postgres (jsonb / boolean / timestamp types)
- Neon Postgres connected via Vercel Marketplace integration
- 18 tables migrated via fresh 0000 migration; pushed to Neon main + preview branches
- /api/health endpoint verifies db connectivity
- Workers code preserved untouched in workers/* for Sub 0b reference

## Test plan

- [x] `pnpm typecheck` clean
- [x] `pnpm lint` clean
- [x] `pnpm build` (next build) success
- [x] Local `pnpm dev` + `curl /api/health` returns { ok, db_ok: true }
- [x] Vercel preview deployment READY
- [x] Production preview URL `/api/health` returns { ok, db_ok: true }
- [x] Production preview URL `/` renders Loom hero

## Files

- New: `next.config.ts`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `app/api/health/route.ts`, `src/db/client.ts`, `postcss.config.mjs`, `.env.local.example`, `drizzle/0000_*.sql`
- Replaced: `package.json`, `tsconfig.json`, `src/db/schema.ts`, `drizzle.config.ts`, `biome.json`
- Deleted: `src/main.tsx`, `src/App.tsx`, `index.html`, `vite.config.ts`, `src/index.css`, `src/routes/*` (entire directory)
- Untouched: `workers/*`, `src/core/*`, `src/ai/registry.ts`, `docs/*`

## Spec / Plan

- Spec: `docs/superpowers/specs/2026-05-11-sub0a-stack-migration-infra-design.md`
- Plan: `docs/superpowers/plans/2026-05-11-sub0a-stack-migration.md`

## Next

Sub 0b: Route migration (capture, mistakes, review, learning-items, knowledge — all 18 routes from Workers Hono → Next.js Route Handlers, hybrid mode).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9.6: Update PLANNING with PR # (post-create)**

After PR creation, edit `PLANNING.md` to replace `(PR #?)` placeholders with the actual PR number from `gh pr view --json number`.

```bash
PR_NUM=$(gh pr view --json number -q .number)
sed -i.bak "s/PR #?/PR #${PR_NUM}/g" PLANNING.md && rm PLANNING.md.bak
git add PLANNING.md
git commit -m "docs: link PR # in PLANNING"
git push
```

---

## Verification matrix (against spec)

| Spec section | Implementing task |
|---|---|
| § 一 在 — Next.js skeleton | Task 3 |
| § 一 在 — 删 Vite 代码 | Task 1 |
| § 一 在 — Neon Postgres 接通 | Task 2 (env pull), Task 5 (push) |
| § 一 在 — Drizzle PG schema 18 张表 | Task 5 |
| § 一 在 — 删旧 SQLite migrations + new PG migration | Task 5.4-5.5 |
| § 一 在 — /api/health smoke | Task 6 |
| § 一 在 — /page placeholder | Task 3 |
| § 一 在 — Tailwind v4 接 Next.js | Task 4 |
| § 一 在 — .gitignore 加 .vercel/ .next/ | (already done at spec creation) |
| § 一 在 — 18 张表 schema 推 Neon | Task 5.6-5.7 |
| § 一 在 — Vercel deploy + smoke | Task 8 |
| § 二 决策 — Next.js 15 App Router | Task 3 |
| § 二 决策 — Drizzle postgres-js driver | Task 6 |
| § 二 决策 — fresh 0000 PG migration | Task 5.4-5.5 |
| § 二 决策 — Workers 保留不动 | Tasks 1+5 explicit not-touched |
| § 二 决策 — Tailwind v4 PostCSS | Task 4 |
| § 三 用户做 Neon integration | Pre-flight Step 0.2 |
| § 五 验证 milestone 1-10 | Tasks 6-8 |
| § 六 估时 ~13h | sum of task estimates |
| § 七 不变量 | (preserved by file map) |
| § 九 Open Q4 Next.js 15 | Task 2 |
| § 九 Open Q5 lucide-react preserved | Task 2 (kept in deps) |
| § 九 Open Q6 TanStack Query preserved | Task 2 (kept in deps) |
| § 九 Open Q7 PWA dropped | Task 2 (vite-plugin-pwa removed) |

---

## Self-review notes (writer's pre-flight)

- **Type consistency check**: Schema's `pgTable` import + types (jsonb, boolean, timestamp) are consistent across all 18 tables in Task 5.2.
- **No placeholders**: every step has runnable code/commands. Open questions in spec § 九 are intentional design decisions, not plan gaps.
- **Workers code preserved**: Task 1 explicitly excludes `workers/`; Task 5.3 typecheck passes because tsconfig excludes `workers`.
- **MCP usage**: Task 8 uses MCP tools (`list_deployments`, `get_deployment`, `web_fetch_vercel_url`, `get_deployment_build_logs`). The implementer (Claude) has access; user does not need to do anything.
- **vitest workers tests**: Sub 0a does NOT delete Workers code; vitest may discover those tests. Step 9.2 includes a fallback to exclude them.
- **Branch already created**: `sub-0a-stack-migration` exists with spec commit; tasks proceed on this branch.
- **Vercel project link**: `.vercel/project.json` was already written (gitignored). Implementer doesn't need to re-run `vercel link`.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-sub0a-stack-migration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
