# TEST LAN binding — owner decision 2026-10-11

URL: http://192.168.50.76:8787. The private current Compose app ports are exactly `127.0.0.1:8787:8787` and `192.168.50.76:8787:8787`. No wildcard host binding was added. Current image remains sha256:56d8c16bc2d886886634a7477383af511121416ec829ac116b01afb777fe04b5 (source80e63a065). App identity is126ecd247eedf8866462143e022c295e66216cc38be5367f94d6c4b95474e5e2.

Parent acquired the atomic shared deployment lock, backed up private Compose outside git, changed app ports only, and recreated only app with --no-deps --pull never. Worker, PG and storage identity/image/start/health remained identical; app image and canonical environment key/value mapping stayed identical. No keys were printed or added, including the retained OPENCODE_API_KEY. No business/provider request was made.

First run stopped on an order-sensitive environment-array digest comparison and rolled back. Failure evidence is retained at the local deployment root/lan-access-20261011. After verifying the rolled-back container environment mapping against image defaults plus unchanged Compose environment (zero differing keys), the second run compared canonical mappings. It succeeded at local deployment root/lan-access-20261011-02. Owner token was verified before lock removal. current-release.json records appBindings and evidence path; release source/image are unchanged.

Host-origin HTTP checks, through both addresses: /api/health200, /api/ready200, /api/auth/check401, /api/copilot/sessions401, /today200. Probing LAN address ports5432,5433,5544,7333,8080,8333,8888,9333 from this Mac returned connection refused. PG still binds loopback5433/5544; storage and worker expose no host ports. Tailscale Serve configuration remains unchanged.

These checks do NOT prove another LAN device can connect. UI has been asked to check the actual iPad: sign-in page, unauthenticated API401, health200, and unavailable infrastructure ports. Phone Add-to-Home-Screen/camera/pen acceptance is UI-owned. No claim of remote-device PASS is made.

Rebuild requirement: every future private Compose generation must retain both exact app bindings and all original environment values. UI release owner received this constraint. README records the same; do not copy the historical loopback-only template over the current config. Plain HTTP is authorized; service workers/getUserMedia or other secure-context-only requirements need a separate HTTPS decision.
