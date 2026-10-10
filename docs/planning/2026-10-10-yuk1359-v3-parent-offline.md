# YUK-1359 parent v3 artifact acceptance

Helper revision is b52e255f746ebbf6a4f2f44ae06e7d1b672a4fff, with mandatory content algorithm v2 and receipt envelope2. Parent compared all33 exported helper/configuration files to exact Git blobs and the live external capture closure. Worker source remains7472f4395f4a12a5167e33034d5d8af8bf695049, artifact SHA256 4e2ec8ace103cf535c3472f2f2c4611438d8cfe5a6f14a1c65abe272674824a9. Earlier handoff omitted two hash characters; the actual artifact and accepted manifest matched throughout.

Parent initial verification matched all sealed source/evidence and historical trees, but strict admission rejected one installed dependency metadata file. The pnpm workspace state JSON expected698f7ed95ec902a937343a7bf0441be79688b527c9cf3c218479ec8e27fc9c80 and observed6ebbebad263a5b3b7ffe5d1b9b3a21836d55dcd60535ffaec89d6f4112f458c1. All other121548 files and3756 dependency links matched. Installed pnpm11.13.1 source at workspace/state/createWorkspaceState emits this metadata, including a validation timestamp and package-manager settings. The previous file bytes are unavailable, so the parent does not claim a timestamp-only change or reclassify old evidence.

Fresh v3 acceptance explicitly binds the observed exact hash. It does not edit installed files, omit a dependency, or relax the runtime verifier. The original manifest, failed verification and author handoff remain archived under v3/history/parent-dependency-transition-before. The old v2 prep and failedrun01–07 records are untouched. The new dependency manifest also relocates worker.file from the historical v2 path to the actual v3 lifecycle executable; byte count and SHA256 are identical.

Parent ran the complete558-check offline suite successfully, then repeated it after the worker path correction; both runs exited0 with zero connection/listener/child attempts. This includes463 inherited checks and95 array/algorithm checks. Final parent source/evidence verification exited0: 3005 source files,3044 evidence files,121549 dependency files and3756 links matched; all original historical trees and transition archive bytes matched. No fresh runtime capture, restore or DBOS reopen has run. Original R2 scope is helper887012, not this later delta; no third review.

Evidence paths:

- /tmp/yuk1359-v3-parent-initial-verification.json
- /tmp/yuk1359-dbos-restore-offline-prep-v3/dependency-binding-transition.json
- /tmp/yuk1359-v3-parent-full-attempt01.json and .err
- /tmp/yuk1359-v3-parent-full-final.json and .err
- /tmp/yuk1359-v3-parent-final-verification.json and .err

Fixed source seal ae9d706fea8599efbbe37c4d28059d27008975ca31cb17187021353358ae12cb; evidence seal57e24c9773ad71e714a37be0cb77a3ce9f04777d2013fbfb51bb1b50cc1e06f0. These hashes bind artifacts; they are not runtime evidence. Parent prepared new run08 scripts without starting resources. Historical failed sources will not restart.
