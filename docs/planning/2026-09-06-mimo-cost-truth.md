# MiMo estimate ownership — YUK-964

Xiaomi SDK USD totals are not provider invoices, even when positive. A real
405-input/389-output-token call produced SDK USD0.01175, matching a $5/$25 SDK
fallback card rather than MiMo pricing. New Xiaomi attempts use the existing
cost owner and a dated local estimate. Unknown models stay unknown/null;
Anthropic, subscription and other compatible-provider policies are unchanged.
Historical ledger rows and user provider settings are not rewritten.

The [official public price card](https://mimo.mi.com/docs/en-US/price/pay-as-you-go),
updated2026-08-06 and checked2026-09-06, matches the already committed catalog:
MiMo-v2.5 USD/M input0.14/output0.28/cache0.0028; pro0.435/0.87/0.0036.
Cache creation is currently free. The implementation reuses these catalog
numbers instead of maintaining another numeric card; the estimate version pins
the dated policy. Domestic CNY terms and actual account invoices remain distinct.

Verification: four new assertions failed before the change. After the change,
37 scoped unit tests and24 runner DB tests pass, covering collected, alias and
streaming result/run/ledger agreement. Ten previously recorded real wire usages
replay through the new cost owner with matching estimates and no new paid calls.
Typecheck/lint/build and architecture audit pass; independent initial review PASS.
The review's non-blocking historical-header wording suggestion is not treated as
a fixed defect or a separate issue. Exact-head CI and merge remain delivery gates.

The first CI run identified four additional old SDK-USD expectations in failure,
partial-stream and budget-error tests. Their terminal failure, usage, retry and
logging assertions remain intact; only expected amount/basis changed. The scoped
AI-directory unit gate now passes32files/418tests, including those failure paths.
