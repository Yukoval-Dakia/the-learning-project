# Retire completed tool-migration oracles

Scope: Agency, Ingestion and Copilot ownership tests. No product, schema, prompt,
provider, timeout, fixture-data or production-state changes.

| Retired assertion | Retained evidence |
| --- | --- |
| Agency/Ingestion complete schema fingerprints and fingerprint algorithm self-test | Actual manifest loading, exact tool names and permission surfaces; readable effect, local cost and mirror policies; real tool behavior tests below |
| Agency/Copilot old file absent / new file present and import spelling | Actual manifest loaders; architecture audit rejects non-infrastructure central tool files and capability boundary audit rejects deep imports |
| Copilot old central event reader file absent | Architecture audit's central event transport allowlist; public reader export and mutation-prohibition checks remain |

Schema evolution is no longer judged by an opaque migration-era byte digest.
The bridge still validates output before successful observation/log/return;
reader and mutation tests assert meaningful public values, provenance, rejection,
concurrency and replay behavior. This does not claim every historical schema byte
is frozen or that a smaller test count proves complete coverage.

Focused retained behavior:

- `read-tools-m2.test.ts`: material/record/learning-item context, evidence bounds,
  missing/archived state and claim scope.
- `fixtures.test.ts`: real multi-tool learning-item completion and failure-learning
  chains, seeded evidence references and agent-readable outputs (model mocked).
- `proposal-tools.test.ts`: propose-only mutation, field validation, attribution
  idempotency and failures, record links and promotion proposals.
- `agent-note-tools.db.test.ts`: input/output parsing, hint-channel ownership,
  expiration, non-agent rejection and evidence-linked downstream visibility.
- `question-block-edits.db.test.ts`: six editing tools, provenance, versioning,
  concurrent edits, nested structures, cross-session rejection and null/no-op cases.
- `question-block-structure.db.test.ts`: addressable tree projection and missing/null state.
- `mcp-bridge.integration.test.ts`: permission, lifecycle, logging and output validation.

Legacy controls' drain-only presence/exposure checks remain. No rollback, parser,
prompt, billing or cancellation test is retired. The same constant-valued cost and
mirror policies previously hidden inside hashes are now asserted directly; in
particular `read_agent_notes` remains `when_causal`, not the ordinary read policy.

Required closeout: focused unit/DB, architecture/capability audits,
typecheck/lint/build, independent initial review and exact-head CI. Production
rollout/SoT retirement and the unfinished full ADR sweep are separate boundaries.

Local result: 15 focused unit cases and 103 DB cases across seven behavior suites
passed. Typecheck, lint, production build and both architecture audits passed.
Independent initial review passed with no findings. Exact-head CI is pending.
