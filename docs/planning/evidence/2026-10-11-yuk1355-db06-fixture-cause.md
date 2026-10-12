# DB06 provenance fixture correction

DB06 at `288acbe82` retained 23 passes and one failure. The failed recovery case
expected both lane snapshots to be `xiaomi`, but its initial configuration set
only the sampling-enabled flag. The neighbouring case set the two lane keys;
`afterEach` cleared them before this case. The isolated run supplied no provider
environment. `readCalibrationLaneSnapshots` therefore correctly captured null
for these two unset configuration values. Actual rejudge provider/model are
separately recorded in receipt `config`.

This is a fixture defect, not a recovered receipt dropping attribution. The
repair sets both lane keys before the first execution and additionally checks
the persisted pre-recovery result: its actual rejudge provider/model and both
lane values must match the fixture. It retains the original post-recovery
`xiaomi` assertions, later configuration change, one-call assertion and immutable
result comparison. No production source changes.

Biome and typecheck pass. Real DB rerun remains pending a new coordinated window.
Only three cases are requested: the failed rollback/recovery case, the frozen
input/config mutation neighbour, and the T2 repeated-reuse case. The other DB06
passes and the shared 34 cases are not repeated. Original DB06 logs and cleanup
are retained at `/tmp/yuk1355-consumer-parent-db-06`.
