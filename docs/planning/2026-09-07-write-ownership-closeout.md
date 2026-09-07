# YUK-974 — remaining fold-writer ownership

Scope: follow the eight unregistered write sites and five stale registry entries left after
YUK-973, verify their events/derived-field responsibilities, and repair actual behavior before
changing registration. No new framework, allowlist expansion, UI change or provider calls.

## Findings and changes

| Behavior | Verified responsibility | Change |
| --- | --- | --- |
| Import completion | Ingestion transaction emits create snapshots and import/ignore lifecycle events; extraction text/ordinal are non-fold fields | Register current owner path |
| Record promotion | Ingestion emits full returned artifact snapshot in acceptance transaction | Register current owner path |
| Quiz tool materialization | Practice Tx-only writer emits full artifact_create snapshot | Register current owner path |
| Edge acceptance | Knowledge gates create INSERT and feeds same-tx generate into topology projector | Replace stale central path |
| Hub synchronization | Notes fenced transaction owns body CAS, refs, event and cursor acknowledgement | Fix distinct row/event clocks |
| Proposal note archive | Agency previously updated the artifact table, central helper emitted its event | Move complete operation into Notes, lock and validate latest batch time |

Hub synchronization had a real replay mismatch: SQL used clock_timestamp(), while its event
used a later new Date(). Strengthening the existing test from body/version to the complete
artifact was RED (updated_at differed by 1ms). The row now returns one millisecond-precision
database time, strictly after its previous update, reused by the event. The complete test is GREEN;
claim fencing, rollback stages, editor protection and cursor acknowledgment are unchanged.

Proposal archive had a second real ordering hole: a newer note edit could be followed by a
backdated correction/archive. A two-artifact test with a later edit was RED. Notes now owns
sorted row locks, the batch watermark, row archive and matching lifecycle events. Agency calls
only archiveProposalArtifacts(tx, {proposalId, archivedAt}). The existing bounded retract retry
rolls back a stale correction and all its side effects; no new retry loop or compatibility path.
The test is GREEN and checks exact full-row replay and one committed correction for both notes.

The Notes verification write-by-id concern was checked through its actual caller and disproven:
finalizeNoteVerificationResult locks artifact and claim, validates version/type/status/archive,
then invokes the private persistence callback on that same transaction. No duplicate CAS layer
or speculative issue was added.

## Audit semantics

Static code cannot tell which flags are enabled in a particular deployment. Replace LIVE_TABLES
with canonical/switchable/anchor-only code policy; all seven canonical or switchable entities
now expose event-native caller advisories. Calibration retains its explicit anchor-only policy.
Existing Notes and ingestion writer labels describe their actual same-transaction events,
not obsolete claims that those tables are OFF. No allowlist was added or broadened.

Strict inventory: zero violations, zero stale entries; 42 event-native advisories remain visible
(previously 16, because Artifact/QuestionBlock were incorrectly omitted). These are verified
ownership contracts to preserve, not 42 proven bugs and not a blanket proof of all runtime behavior.
Architecture/capability gates retain 437/0/47 with no baseline expansion.

## Evidence and remaining delivery

120 DB cases across six hub-sync/retraction/import/owner/parity suites, 27 scanner unit cases,
typecheck, lint/build and strict writer/architecture/capability audits pass. Independent review
and exact-head CI are required before merge. Production remains the separately verified YUK-973 image4e1dec7c.
The full product architecture goal and provider/crash matrix remain open.

## Initial review and CI correction

Initial independent review of `64a94b71` found one P1: archive preserved version, so a refine
that had already read the old live row could pass its delayed version CAS after retraction.
A real PostgreSQL interleave reproduced `applied` where `skipped:version_conflict` was required.
The archive owner now advances the row version and matching lifecycle nextVersion. The same
test is GREEN, preserving the untouched body, one correction, two archive events and exact replay.
Other current writers were traced: they either CAS on version or lock/check archive status;
the fix does not add a second implementation of their guards.

CI `34123408875` passed both DB shards and all other gates except one legacy Step9 unit check.
That test duplicated Artifact/QuestionBlock writer lists (including retired embedded-check text)
and rejected the new Notes owner. Replace those two lists with the existing audit scanner and
verified registry, keeping exactly their table scope and rejecting every non-sanctioned site.
Raw SQL/DELETE and stale-entry checks are now covered too; no allowlist bypass or new global
hard-gate policy is introduced. This removes roughly 140 lines of duplicate ownership inventory.

After the fix: 101 related DB cases across five suites, 46 scanner/Step9 unit cases, typecheck,
lint/build and architecture/capability gates pass. Unique verification review and new exact-head
CI remain pending; production is unchanged.
