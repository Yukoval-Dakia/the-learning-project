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
and provider save/resolve paths accept only this key env for this host. These
bindings do not cover every process-env endpoint override (for example MEM0 or
vision preflight overrides that only check the host allowlist). No wildcard or
alternate port is admitted.

`lane.global.provider`, `.model`, and `.reasoning` select the chat product route
through the configuration center. For release, chat and
`QuestionAdmissionSolveTask` must follow OpenDesign globally, with no solve task
provider/model/reasoning/override pin. Preserve grading and
adjudication identities when changing the global route.

Before switching the global keys, capture the target deployment's effective
bindings and active slices. For **each** of `AssessmentRubricJudgeTask` and
`AssessmentRuleJudgeTask`, write all four task keys together:

```text
task.<kind>.provider            = current admitted provider
task.<kind>.model               = current admitted model
task.<kind>.reasoning           = {level: current requested level}
task.<kind>.override_global_pin = true
```

Values come from the target's resolved configuration and must agree with its
active slice, not from dev or a hard-coded example. `override_global_pin` only
protects the provider/model pair. Reasoning independently resolves task > global
> catalog; capture requested and applied values and verify that the explicit task
level reproduces the current applied value. If no explicit level reproduces it,
stop the switch rather than guessing: `model_version` includes the applied wire
reasoning as well as the provider and prompt hash.

Clear obsolete solve task provider/model/reasoning/override keys so it follows
the global selection. Leave `JevScoringDecisionTask` unconfigured (fixed typed
contract), and do not add overrides to `QuestionAdmissionAdjudicateTask` (its
`ignoreGlobalPin` dedicated route remains). Keep the existing vision judges on a
verified image route via `lane.vision_judge` or explicit task pins until OpenDesign
image execution has been accepted. The scoped vision lane also serves
`SourceGroundingVerifyTask`; check its fallback route and reasoning too.

Remove both `AI_PROVIDER_OVERRIDE` and `AI_PROVIDER_MODEL` from each application
and worker process when DB global selection is intended. A provider-only env pin
selects the env route and does not borrow the DB global model; it may use an
existing task model or fail for a missing/incompatible model. A model-only env
value does not activate an env pin. These env values do not set reasoning.

## Catalog and costs

`GET /models` on 2026-11-07 listed 14 models. Only `deepseek-v4.1-flash` has a
route-specific runnable entry here. Facts are selected by the endpoint key,
not by the editable custom-provider slug. The other 13 remain unknown rather than
borrowing another provider's prices/capabilities. Input modalities and limits
come from that listing: context 1,048,000, input budget 328,000, output budget
128,000. Text, tools, high reasoning, named structured submit and prefix cache
were exercised; image execution and other reasoning levels were not.

[OpenDesign's model page](https://go.open-design.ai/models/deepseek-v4-1-flash/)
lists USD per million tokens: uncached input 0.30, output 1.20, cache read 0.006;
cache write is unlisted. These are the catalog rates. Pi estimates
`(uncached_input*0.30 + cached_input*0.006 + output*1.20)/1e6`;
`cost_ledger` records `estimated` with
`pi-catalog:<custom-provider-id>/deepseek-v4.1-flash`. This is not a provider invoice.

[OpenDesign billing](https://open-design.ai/help/billing/) describes a separate
0.5x plan-credit multiplier for this model. It is not a token unit price, and is
not applied to the ledger estimate. Actual plan deductions need provider billing
readback; completion responses in this run supplied usage, not billed dollars.

Custom providers use their own `/models` listing and receive no inference auth
probe. `inference:unprobed` is honest after listing success; it is not an auth
failure. Refresh may still probe an already configured built-in provider. Missing
listing/cache facts keep execution fail-closed without making startup depend on
models.dev recognizing this host. Existing snapshot and built-in models are unchanged.
