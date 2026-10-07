# Pinned dependency corrections

## mem0ai 3.0.13 — YUK-979

Both OSS exports (CJS and ESM) must propagate extraction HTTP/SDK failures,
reject malformed or schema-invalid extraction output, and propagate required
embedding/primary vector-write failures. The upstream implementation returned
empty success, indistinguishable from valid `{"memory":[]}`. A real bounded
Memory acceptance exposed this after a successful DashScope embedding.

PGVector batch insert is one parameterized statement: event-id recovery regards
stored rows as the completed provider result, so partial primary writes are unsafe.
The normal batch-to-single embedding compatibility fallback remains, but a failed
required embedding may not be skipped. Auxiliary history and entity enrichment
remain best-effort. No package API, schema, model or credentials changed.

The patch is pinned in pnpm-workspace.yaml and the lockfile; Docker's dependency
stage copies patches before frozen install. On a Mem0 upgrade, verify the upstream
behavior and remove/rebase the patch deliberately. The real-SDK ESM/CJS unit suite
and PG/ingestion-owner DB suite are the behavioral acceptance, not patch text hashes.

`src/server/memory/mem0-sdk-failure.unit.test.ts` covers local HTTP failures,
invalid outputs, valid empty extraction and stored result identity.
`src/server/memory/mem0-sdk-failure.db.test.ts` covers atomic writes and failed
attempt/no-completion/no-reburn versus legitimate empty completion.


## mem0ai 3.0.13 — YUK-1341 product routing

The existing correction also preserves `llm.config.defaultHeaders`, `maxRetries`
and `timeout` through ConfigManager and its schema in ESM/CJS, and forwards them
to the OpenAI client. Go needs `x-opencode-session`; its Mem0 client uses a unique
SDK session UUID, not a fabricated `ai_task_run` id. The product Go config disables
SDK HTTP retries and uses a 60 second request timeout. Local 503 acceptance checks
both exports, the chosen model, JSON mode, the header and exactly one request.
Opaque memory operations retain unknown usage/cost; no new usage estimate is
attributed to the SDK. Existing extraction/write failure and atomicity fixes remain.
