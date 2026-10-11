# Main CI regression repair (YUK-1107)

Owner requested this P1 ahead of further CI speed work. The two fixture repairs serve the data/settlement invariants; production behavior remains unchanged.

## Evidence and cause

Main-based UI PR #1692 run38135449130 fails independently in DB shards3/4 and4/4. Job114459492869 reports substring argument42 with PostgreSQL inferred type25 (text), not integer. PostgreSQL selects the regular-expression substring overload; a valid scheduled workflow containing42 yields42, whose timestamptz cast fails. The production horizon already validates every exact native family/timestamp identity before this independent SQL comparison. The fix explicitly casts the position to integer, preserving all rows and the max(control barrier, scheduled native timestamp, DBOS tick)+60seconds comparison. No malformed-ID deletion/filter hides a failure. H−1microsecond rejection and exact-H acceptance remain unchanged.

Job114459492903 shows placement outage PENDING instead of ERROR, followed by five fixture-blocked cases. The fault proxy destroys existing application sockets after observing the server COMMIT but keeps listening and resets reconnections. Closing its listener at that same fault boundary makes the primary genuinely unavailable to subsequent connections. Stop awaits that one listener-close promise. The case waits for the real worker failure before polling original ERROR, receipt/event equality, committed/not-committed outcomes, terminal recovery rejection and strict obligations. Both parameterized families use the same fixture.

## Validation status

Source-only revision on base135bb18e6d. Independent review, scoped23cases (cron2 plus combined migration21), local typecheck/lint/build and exact-head CI are pending. Shared runtime window must be newly coordinated; no TEST/provider/full local CI. Preserve existing failed r5/r6/remote receipts. FullCI≤120seconds remains unachieved; parked #1691 changes are excluded from this repair.
