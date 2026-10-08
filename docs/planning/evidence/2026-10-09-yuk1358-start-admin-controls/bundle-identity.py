"""Read emitted bytes only; never import or execute a server/browser bundle."""

import hashlib
import json
import re
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


host_path = Path("dist/server.cjs")
host = host_path.read_text()
checks = []


def check(name, condition, **evidence):
    if not condition:
        raise AssertionError(name)
    checks.append({"check": name, "result": "PASS", **evidence})


def block(marker):
    start = host.index(marker)
    end = host.index("\n}", start) + 2
    return host[start:end]


def location(marker):
    return {"path": str(host_path), "line": host[: host.index(marker)].count("\n") + 1}


alias_pattern = r"\((init_public\d*\(\)), (public_exports\d*)\)"
markers = [
    "async function createStartAdminControlReader",
    "async function injectAdminConfigFactsBeforeServe",
    "async function injectAdminConfigWriterBeforeServe",
]
aliases = [re.findall(alias_pattern, block(marker)) for marker in markers]
check(
    "host control adapter, facts bootstrap and writer bootstrap resolve one domain export object",
    all(len(a) == 1 for a in aliases) and aliases[0] == aliases[1] == aliases[2],
    aliases=aliases,
    locations=[location(marker) for marker in markers],
)
check(
    "frontdoor binds canonical host operations and passes them through request context",
    "adminControls: () => controls ??= createStartAdminControlReader()"
    in block("function createFrontdoorContext")
    and "entry.default.fetch(c7.req.raw, { context: context4 })" in block("async function createFrontdoor("),
    locations=[location("function createFrontdoorContext"), location("async function createFrontdoor(")],
)
check(
    "host awaits subject/config hydration and facts/writer injection before opening the frontdoor",
    host.index("await hydrateSubjectsBeforeServe();")
    < host.index("await hydrateConfigBeforeServe();")
    < host.index("await injectAdminConfigFactsBeforeServe();")
    < host.index("await injectAdminConfigWriterBeforeServe();")
    < host.index("await createFrontdoor(app, env6.RW_STATIC_DIR)"),
    location=location("await hydrateSubjectsBeforeServe();"),
)
check(
    "host bootstrap and control adapter acquire the same owned database export",
    "(init_client12(), client_exports5)" in block("async function createStartAdminControlReader")
    and "(init_client12(), client_exports5)" in block("async function hydrateSubjectsBeforeServe")
    and "(init_client12(), client_exports5)" in block("async function hydrateConfigBeforeServe"),
)
check(
    "one host config store supplies both hydration and the read model",
    host.count("// src/core/config/store.ts\n") == 1
    and host.count("function getConfigSnapshot()") == 1
    and host.count("function replaceConfigSnapshot(") == 1
    and "const snap = getConfigSnapshot();" in block("function buildAdminConfigReadModel(")
    and "() => doHydrate(db2)" in block("function hydrateConfigFromDb(")
    and "replaceConfigSnapshot({" in block("async function doHydrate("),
    locations=[location("function buildAdminConfigReadModel("), location("async function doHydrate(")],
)
handler_paths = list(Path("dist/start/server/assets").glob("admin-control-function-*.js"))
check("exactly one emitted control handler chunk", len(handler_paths) == 1)
handler_path = handler_paths[0]
handler = handler_path.read_text()
exports = re.findall(
    r"export const (\w+) = createServerFn", Path("server/start/admin-control-function.ts").read_text()
)
compiled_handlers = re.findall(r"^var (\w+) = createServerFn.*$", handler, re.M)
check(
    "all eighteen emitted handlers call the authenticated context adapter",
    len(exports) == 18
    and set(compiled_handlers) == set(exports)
    and all(
        "runAuthenticatedStartAdminControl(context, getRequest()," in line
        for line in handler.splitlines()
        if re.match(r"^var \w+ = createServerFn", line)
    ),
    names=exports,
    path=str(handler_path),
)
check(
    "all sixteen parameter validators defer canonical parsing until after authorization",
    handler.count(".inputValidator((input) => input)") == 16,
)
check(
    "Start control handlers resolve host operations through context and have no local domain import",
    "operation(await context.adminControls())" in handler
    and "observability/public" not in handler
    and "createStartAdminControlReader" not in handler
    and not re.search(r'from ["\'][^"\']*public[^"\']*["\']', handler),
)
start_server = sorted(Path("dist/start/server").rglob("*.js"))
start_client = sorted(Path("dist/start/client").rglob("*.js"))
check(
    "canonical operation factory is absent from emitted Start server and browser JavaScript",
    all("createStartAdminControlReader" not in p.read_text() for p in start_server + start_client),
    server_files=len(start_server),
    browser_files=len(start_client),
)
resolver_paths = list(Path("dist/start/server/assets").glob("__23tanstack-start-server-fn-resolver-*.js"))
check("exactly one emitted function resolver", len(resolver_paths) == 1)
resolver_path = resolver_paths[0]
resolver = resolver_path.read_text()
check(
    "built resolver contains every control function exactly once",
    all(resolver.count('functionName: "' + name + '_createServerFn_handler"') == 1 for name in exports),
    path=str(resolver_path),
)
report = {
    "evidence_layer": "static emitted bytes; no built server, DB, browser or provider execution",
    "checks": checks,
    "artifacts": [
        {"path": str(p), "sha256": digest(p)}
        for p in [host_path, handler_path, resolver_path]
    ],
    "limit": "Other existing Start consumers may contain duplicated domain modules. New control handlers consume only host context operations. Parent built-RPC and DB acceptance remains required.",
}
print(json.dumps(report, indent=2) + "\n")
