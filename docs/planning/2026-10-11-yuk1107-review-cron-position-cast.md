# Restore positional review-cron horizon parsing (YUK-1107)

Owner requested a minimal main-unblock repair before all speed work. Baseff2c9e229961db695ebacbab1f984d67de6e2792. The independent horizon oracle was introduced by #1690 e178690eb; its untyped position36 resolves PostgreSQL’s regex substring overload. #1658 head5d9ccebec run38139669828 DB2job114470799267 reports22008 and actual argument types[25,1184]. The regex extracted36 from a valid workflow identity, then timestamptz rejected it. Log /tmp/yuk1404-pr1658-5d9-db2-first.log preserves284PASS/1FAIL.

The explicit integer cast is smaller and more certain than reverting the full clock fixture. It restores the intended positional substring, retaining every SDK workflow row and the independent max(control barrier, SDK scheduledDate, DBOS tick)+60seconds oracle. Early rollback rejection, exact-boundary acceptance and strict ledger/history assertions are unchanged. No product or business assertion changes.

Case-insensitive scan of all tests/dbos-* extraction functions found exactly two SQLsubstring/cast sites: review cron (fixed here) and session cron (alreadyexplicitinteger in1696). No other substring/substr/split_part/regexp/position SQL extraction cast was found. Existing JavaScript Date.slice identities are schema-validated and do not use PostgreSQL’s overloaded parameter dispatch.

Affected existing case: review-orphan cron1. Proposed guarded localscope also includes existing session-orphan cron2, total3, only after freshDNS-complete/coordinatorwindow approval. New independentreview/static/build/local/exact-headCI are pending; no runtime or120s claim. Speed work remainsisolated/paused, three exacthead consecutive fullgreenruns required beforemain.
