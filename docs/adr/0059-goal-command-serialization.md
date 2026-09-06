# Goal mutation order is assigned while holding the goal lock

Goal commands serialize status/scope mutations under the row lock and assign event/materialization
time as the later of the requested time and the persisted updated time plus one millisecond.
This gives the existing timestamp-ordered reducer the same strict order as committed mutations,
including simultaneous requests and delayed callers carrying older timestamps. Keeping caller time
verbatim was rejected: it could reverse replay order and roll back an otherwise valid update.

No historical event is rewritten. A time correction is local to new goal status/scope commands;
it is not a claim about learner activity time. Retraction retains its already-written correction
event timestamp and historical no-version-bump semantics. Creation, mutation and retraction use
one Agency-owned materialization policy; legacy no-anchor rows remain protected without backfill.
