# Canonical note and question-block editors

YUK983 retires the Artifact/QuestionBlock editor flag and pre-anchor direct-write
fallback. Deployment prepares only eventless legacy rows, atomically validates
complete history and symmetric fold/live parity, then business editors always
write through the existing projection under their existing row locks. A missing
base rejects the edit; it never silently succeeds or snapshots incomplete history.

This trades environment-only rollback for one implementation: rollback uses the
previous release, preserving append-only events and existing reducer compatibility.
Artifact and question-block retraction may legitimately fold to null, unlike the
three prior canonical entities' retained tombstones. Calibration remains Scheme A;
knowledge/edge structural mutation retirement is separate, not claimed here.
