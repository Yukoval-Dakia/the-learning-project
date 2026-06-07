# Real-ingestion provisioning runbook (Strategy D / Slice A)

> Goal: provision the external credentials the real upload → OCR → VLM → blob
> pipeline needs, verify them with the pre-flights, then ingest your first real
> worksheet through the existing manual-review flow. First real material =
> **math / physics** (both `SubjectProfile`s are registered — run `pnpm
> audit:profile` to confirm).
>
> This is the owner-operated half of Strategy D. The headless auto-tag audit
> trail (Slice B, YUK-190) rides on top of the same real sessions once they exist.

## 1. What real ingestion needs

The canonical variable list + inline docs live in [`.env.example`](../../.env.example).
This runbook only groups them by the external account they come from. Three
credential groups gate the real path; everything else has a working default.

| Group | Vars | Used by | Source |
|-------|------|---------|--------|
| **OCR (GLM-OCR, DEFAULT)** | `ZHIPU_API_KEY` (+ optional `EXTRACT_OCR_ENGINE`, default `glm`) | Default character-level text + layout extraction — `layout_parsing` (`src/server/ingestion/glm_ocr.ts`). Lives in `.env`. Billable: 0.2 元/M tokens, logged to `cost_ledger` (provider `glm`). **Required on the default path** — a missing key fails every extraction `failed_permanent` (YUK-253). | open.bigmodel.cn console |
| **OCR (Tencent, ROLLBACK)** | `TENCENT_SECRET_ID`, `TENCENT_SECRET_KEY` (+ optional `TENCENT_OCR_REGION`, default `ap-shanghai`) | Retained rollback engine behind `EXTRACT_OCR_ENGINE='tencent'` (YUK-253). `SubmitQuestionMarkAgentJob` / `DescribeQuestionMarkAgentJob` (`src/server/ingestion/tencent_mark.ts`). Extraction is a deterministic API, **not** an LLM (ADR-0002). Keep set during the GLM bake-in window. | Tencent Cloud console |
| **VLM (xiaomi/mimo)** | `XIAOMI_API_KEY` (+ optional `MIMO_VISION_BASE_URL`, `MIMO_VISION_MODEL`) | Vision **rescue** (explicit, paid, user-authorized — `src/server/ingestion/vision.ts`) + every AI task (tagging, judge, brief, dreaming, coach). | xiaomi/mimo console |
| **Blob (Cloudflare R2)** | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Original uploads + auto-cropped figures (`src/server/r2.ts:50`). | Cloudflare R2 |

Also relevant but **not** blocking ingestion:

- `OPENAI_API_KEY` — only the Mem0 fact layer (ADR-0017). Unset ⇒ the fact layer
  degrades gracefully; upload → extract → review → import still works. The
  pre-flight reports it as a warning, not a failure.
- `DATABASE_URL`, `INTERNAL_TOKEN` — already set in any running stack; the
  pre-flight checks them so a half-configured env is caught early.

## 2. Where to obtain each credential

> These are the owner's external accounts — they cannot be provisioned from the
> repo. Keep the secrets out of git; they live only in the worker `.env` (§3).

- **GLM-OCR (default)** — in the Zhipu open-platform console (open.bigmodel.cn),
  create an API key on an account with GLM-OCR (`layout_parsing`) enabled. Put it
  in `ZHIPU_API_KEY`. Leave `EXTRACT_OCR_ENGINE` unset (defaults to `glm`); set it
  to `tencent` only to roll back to the Tencent engine during the bake-in window.
- **Tencent OCR (rollback)** — in the Tencent Cloud console, create a CAM API key
  (`SecretId` / `SecretKey`) on an account with OCR (文字识别) enabled, and make
  sure the 试题批改 / QuestionMarkAgent capability is available in your region.
  Put the pair in `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`. Leave
  `TENCENT_OCR_REGION` unless your account is provisioned elsewhere than
  `ap-shanghai`. Only consulted when `EXTRACT_OCR_ENGINE=tencent`.
- **Cloudflare R2** — create an R2 bucket, then an R2 **S3 API token** (Access
  Key ID + Secret). `R2_ENDPOINT` is `https://<account-id>.r2.cloudflarestorage.com`
  (substitute your real account id — a leftover `<account-id>` placeholder is
  flagged as misconfigured by the pre-flight). `R2_BUCKET` is the bucket name.
- **xiaomi / mimo** — get the API key from the mimo console; it speaks the
  Anthropic-compatible protocol at `https://api.xiaomimimo.com/anthropic`
  (the default `MIMO_VISION_BASE_URL`). Put it in `XIAOMI_API_KEY`.

## 3. Where to set them

The app + pg-boss **worker** containers both read the compose-level `.env`
(`docs/../docker-compose.yml`, `.env.example` header). For real ingestion the
**worker** is what matters — extraction + rescue + tagging all run as pg-boss
jobs in `scripts/worker.ts`.

- **NAS / prod (compose):** put the values in the compose `.env` injected to the
  app + worker services, then restart the worker so it re-reads them.
- **Local host-side dev:** `pnpm dev:local` copies `.env.example` → `.env`; edit
  `.env` and restart `pnpm worker:dev`.

> Never put these in `.env.local` (host Neon) for seeding/testing — real OCR/R2
> calls cost money and write to your real bucket. Provision them where you
> actually intend to ingest.

> 外网访问（tunnel / 反代）是 owner 自有基础设施层，不属本 runbook 范围
> （2026-06-05 owner 裁定）；ingestion 数据链（OCR / R2 / AI）全为出站调用，
> 与入口方式无关。

## 4. Verify before ingesting (the pre-flights)

Run in order; each is fast and the first two are free:

```bash
# (a) presence + format checklist — all required vars set, no leftover placeholders
pnpm preflight:ingestion

# (b) live R2 connectivity — non-mutating HeadBucket (validates endpoint+keys+bucket)
pnpm preflight:ingestion -- --live-r2

# (c) live VLM round-trip — confirms the mimo endpoint does vision + JSON
pnpm preflight:vision
```

`preflight:ingestion` exits `0` only when every **required** var is present
(warnings allowed); `2` if a required var is missing or still a placeholder; `1`
if `--live-r2` is set and the bucket probe fails. Tencent has no cheap
non-mutating probe (a real `SubmitQuestionMarkAgentJob` costs money + needs a
real image), so the live Tencent check is the first real upload below.

## 5. Ingest your first worksheet

Confirm the subject profile first:

```bash
pnpm audit:profile   # math + physics + wenyan should all be valid
```

**UI path:** the `/record` page (`app/(app)/record/page.tsx`) has a **拍试卷**
tab (the `vision_paper` mode) that uploads a full worksheet image and runs it
through the pipeline. This is the intended owner entry point.

**API path (authoritative, what the UI drives):**

1. `POST /api/ingestion` — create an ingestion session (`learning_session`
   with `type='ingestion'`), upload the asset (`POST /api/assets`).
2. `POST /api/ingestion/[id]/extract` — enqueue Tencent OCR extraction.
3. Review the extracted blocks: `GET /api/ingestion/[id]/blocks`; rescue a bad
   block with `POST /api/ingestion/[id]/rescue` (explicit, paid VLM).
4. `POST /api/ingestion/[id]/import` — commit the reviewed blocks to question /
   knowledge rows.

The session state machine is guarded in a single place,
`src/server/session/ingestion.ts`:
`uploaded | failed → enqueueExtraction() → queued → extracting →
extracted | partial | failed`, then `commitImport()` takes the session from
`extracted` (or `reviewed`) → `imported` (terminal, read-only).
`markReviewed()` (`extracted | partial → reviewed`) is an optional checkpoint
not yet wired into the flow — today import commits straight from `extracted`.
All five write sites (`POST /api/ingestion`, `/extract`, the handler,
`/rescue`, `/import`) go through this guard. Don't bypass it.

This is the **manual-review** friction the data the flywheel runs on today: per
block you fill wrong-answer + ≥1 knowledge point + kind + difficulty + cause
(~2–5 min/block). That friction is exactly what the auto-tag path (next section)
exists to remove.

## 6. How this connects to the auto-tag path (Slice B / YUK-190)

Slice B wires `runAutoEnrollForSession` to run **observe-only** (flag
`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` stays OFF) on every extracted session. With
the flag OFF it does **not** auto-import or change any status — it runs the
TaggingTask + WorkflowJudge and writes a `generated_by='workflow_judge'` event
trail, so once your real math/physics sessions exist you can audit how good the
AI's would-be tagging is **in the event log** before ever flipping the flag or
building the review UI (OC-5, deferred). Provisioning + ingesting real material
here is what gives that audit trail something real to score.

## 7. Out of scope here

- The OC-5 "AI auto-enrolled N items" review/revert UI (YUK-164 #2/#3 — redraw-blocked).
- Flipping `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` ON (YUK-164 #4 — needs OC-5 first, ADR-0026).
- The figure page-index fix (YUK-163).
