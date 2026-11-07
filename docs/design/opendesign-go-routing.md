# OpenDesign Go custom route

OpenDesign uses the existing custom provider owner, not a task default or a new
business-provider branch. Save `custom:opendesign` through
`PUT /api/admin/custom-providers/opendesign`:

```json
{
  "display_name": "OpenDesign Go",
  "base_url": "https://amr-link.open-design.ai/v1",
  "api_key_env": "OPENDESIGN_API_KEY",
  "protocol": "openai-completions"
}
```

The credential value stays in the process environment. The exact endpoint host
is code-owned because models.dev does not list it. Both save and execution retain
host/port validation and the credential binding: this key goes only to this host,
and this host accepts only this key env. No wildcard or alternate port is admitted.

`lane.global.provider`, `.model`, and `.reasoning` select the product route via the
configuration center. Environment pins take precedence; remove them from the dev
process when validating the DB selection. Preserve grading task identities using
the existing per-task `override_global_pin` mechanism before changing the global
route. Typed execution keeps its separate fixed provider contract. No task default,
grading identity or admission slice changes in this implementation.

## Catalog and costs

`GET /models` on 2026-11-07 listed 14 models. Only `deepseek-v4.1-flash` has a
route-specific runnable entry here. The other 13 remain unknown rather than
borrowing another provider's prices/capabilities. Input modalities and limits
come from that listing: context 1,048,000, input budget 328,000, output budget
128,000. Text, tools, high reasoning, named structured submit and prefix cache
were exercised; image execution and other reasoning levels were not.

[OpenDesign's model page](https://go.open-design.ai/models/deepseek-v4-1-flash/)
lists USD per million tokens: uncached input 0.30, output 1.20, cache read 0.006;
cache write is unlisted. These are the catalog rates. Pi estimates
`(uncached_input*0.30 + cached_input*0.006 + output*1.20)/1e6`;
`cost_ledger` records `estimated` with
`pi-catalog:custom:opendesign/deepseek-v4.1-flash`. This is not a provider invoice.

[OpenDesign billing](https://open-design.ai/help/billing/) describes a separate
0.5x plan-credit multiplier for this model. It is not a token unit price, and is
not applied to the ledger estimate. Actual plan deductions need provider billing
readback; completion responses in this run supplied usage, not billed dollars.

Custom providers use their own `/models` listing and receive no inference auth
probe. `inference:unprobed` is honest after listing success; it is not an auth
failure. Refresh may still probe an already configured built-in provider. Missing
listing/cache facts keep execution fail-closed without making startup depend on
models.dev recognizing this host. Existing snapshot and built-in models are unchanged.

## Validation receipt

External evidence: `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1960/`.
The closeout receipt contains revision/digests, bounded dev results, interrupted
attempts, known estimated spend and unknown costs. No new tests were added.
Security invariant proposal: through the real save/resolve boundary, accept the
exact OpenDesign pair and reject wrong host, wrong credential, alternate port
and suffix impersonation before any credential-bearing request. Four negative
save requests were manually observed as HTTP 422; no automated case was authored.

Implementation receipt: base `2b957bcb9e5c58c9c8030816419f54a2e9604607`, source
commit `9252ce603` (final static checks). External `final-source.patch` SHA256:
`ed76d9877c4e8eacf734439e34a8074cbe11002009f137e51f843ec5a319886f`. Paid dev runs preceded the final forced-choice provenance
annotation; no paid exact-final-commit rerun. See external `receipt.md` for the
interrupted third ask, pending costs and the unsuccessful trace-link lookup.
