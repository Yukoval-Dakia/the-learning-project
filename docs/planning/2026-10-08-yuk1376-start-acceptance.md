# YUK1376 Start acceptance matrix

Prepared against c40a1862122f809b7f01ac4520651dcc058c72fb. This is an execution checklist, not PASS evidence. Start candidate commit, image, port, authentication mechanism and owner handoff are pending from YUK1352.

## Preconditions

- Inspect exact candidate diff and provenance. Confirm authenticated server-side readMistakes consumer; a route that only falls back to the old SPA does not qualify.
- Confirm whether PR1600 is merged into the candidate. Without it, do not claim frozen public-material acceptance for that candidate.
- Before services change, inspect release and deployment.lock, atomically acquire the lock and notify owners. Reuse only the isolated acceptance PG/S3 volumes after verifying database identity. No production DB, model call, worker, replay or reseeding.
- Preserve original release digest and service state. At teardown stop only owned services, retain volumes, owner-check lock release and notify both owners.

## Required observations

| Behavior | Actual observation required | Existing evidence limits |
| --- | --- | --- |
| Auth before data | Unauthenticated direct /mistakes navigation and server read invocation reveal no rows; authenticated request succeeds. Record actual redirect/status and verify no token in returned HTML or bundle. | Previous Hono 401 does not prove Start server-function auth. |
| Real Start route | Direct navigation, full reload and return navigation render the candidate's Start route; record requests and route identity. | Old SPA rendering is insufficient. |
| Retained evidence | Existing four rows retain frozen prompt, wrong answer, selected submission images, absent reference and excluded mutable/private markers. | Prior exact-image HTTP results apply only to that image. |
| Subject selection | Select a subject with no fixture rows, observe empty result, then clear and recover the four rows. Confirm readMistakes receives the filter through the Start consumer. | UI currently also filters using knowledge-tree effective domain. Check both request and displayed result. |
| State and attribution | Exercise existing state/attribution filters and clear action; counts match fixture facts. Pending attribution must not be described as completed without a worker result. | Four-row fixture may not cover every correction state. Report missing states honestly; scoped DB tests remain separate. |
| Images | Thumbnails decode; open and close EvidenceLightbox; actual authenticated asset bytes, MIME and digest match retained fixture. Unauthenticated access is rejected. | Asset IDs or buttons alone are not delivery evidence. |
| Auxiliary reads | Subject registry and knowledge labels load under the new entry; preserve short-ID fallback when labels are absent. | These are separate consumers from readMistakes. |
| Navigation | Verify existing links to /record, /practice, /knowledge/:id and /events/:id resolve through the shared navigator without submitting/starting practice or modifying those domains. | Do not claim those destinations have themselves migrated based on navigation. |
| Failure and retry | A controlled scoped read failure shows existing error/retry behavior and recovers without silently displaying empty data. Use existing test seams or isolated runtime only; do not disrupt shared services. | Unit mocks prove only the seam, not an observed browser failure. |
| Read-only effects | Compare all non-system table counts/digests before and after the read-only flow; no jobs, learning records or model runs created. | Previous 86-table invariance is not evidence for a new entry. |
| Exit | Inspect actual route ownership and build/fallback configuration. Distinguish /mistakes replacement from global web/ and fallback retirement. | Whole SPA retirement belongs to all 28 routes and YUK1359; this matrix cannot close it. |

## Existing behavior constraints

The page requests at most 200 rows and displays N+ at the cap; it does not expose cursor pagination. Do not claim cursor UI acceptance from API pagination tests. Its current card does not render prompt_materials; API completeness and unchanged existing UI are separate claims. Do not expand this migration into a visual rewrite.

Evidence must name candidate commit/image, authentication boundary, actual request results, browser captures and DB invariance. Mark unexercised cases pending rather than borrowing PASS from old SPA or another image.
