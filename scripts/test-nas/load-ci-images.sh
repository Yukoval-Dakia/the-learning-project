#!/bin/sh
# load-ci-images.sh — fetch a "Build TEST images" workflow artifact and load it on the NAS.
#
# Usage: load-ci-images.sh <run-id> <dest-dir> <expected-commit>
#
#   <run-id>           GitHub Actions run id of the build-test-images workflow.
#   <dest-dir>         directory on the external disk the artifact downloads into.
#   <expected-commit>  40-hex commit the artifact manifest must claim to have built.
#
# Verification chain before anything reaches the NAS: the archive bytes match
# its .sha256 file, the manifest commit matches the expected commit, the NAS
# MEMORY_STOP sentinel is absent, and the NAS host key is already in
# known_hosts. After `docker load`, each tag's image id and revision label are
# read back over ssh and compared with the manifest. On a classic image store
# inspect .Id is the config digest; on a containerd store it is the manifest
# digest (which a docker-save archive cannot reproduce), so the content check
# falls back to rootfs diff_ids — identical on both stores. If neither
# comparison can verify the image, this fails loudly.
#
# The artifact zip is downloaded with aria2c straight into
# <dest>/artifact-<run-id>.zip (multi-connection, resumable): the blob host
# caps a single connection near 38 KB/s on this network, so gh run download
# takes hours for a 1.2 GB artifact and spills into the internal-disk temp
# directory. The signed URL is fetched from the API without following the
# redirect, never printed, and handed to aria2c only through an owner-only
# input file removed on exit; the gh token lives in process env only. Signed
# URLs expire mid-download as a normal case: rc=22 / leftover .aria2 control
# file triggers a fresh-URL resume for a bounded number of attempts.
#
# Only `docker load` and read-only `docker image inspect` run on the NAS.
# Nothing is stopped, started, restarted, or deleted. Works under sh, bash,
# and zsh invocation. Every remote command gets stdin from /dev/null (-n)
# except the one `docker load`, which deliberately receives the archive.
set -eu

die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

[ $# -eq 3 ] || die "usage: $0 <run-id> <dest-dir> <expected-commit>"
RUN_ID=$1
DEST=$2
WANT_COMMIT=$3

REPO=${TLP_REPO:-Yukoval-Dakia/the-learning-project}
NAS_HOST=bancho-nb2.local
NAS_USER=yukoval
NAS_KEY=$HOME/.ssh/tlp_nas_ed25519
NAS_STOP=/volume1/docker/tlp-test/_load/MEMORY_STOP
ART_PREFIX=tlp-test-images-

need gh; need ssh; need ssh-keygen; need find; need python3; need curl; need unzip
command -v aria2c >/dev/null 2>&1 \
  || die "aria2c is required for the multi-connection artifact download (brew install aria2)"
case $RUN_ID in
  (*[!0-9]*|'') die "run-id must be numeric, got [$RUN_ID]";;
esac
case $WANT_COMMIT in
  (*[!0-9a-f]*|'') die "expected-commit must be 40 lowercase hex, got [$WANT_COMMIT]";;
esac
[ "${#WANT_COMMIT}" -eq 40 ] || die "expected-commit must be 40 hex chars, got [${WANT_COMMIT}]"

mkdir -p "$DEST" 2>/dev/null || die "cannot create destination $DEST"
[ -w "$DEST" ] || die "destination $DEST is not writable"

# Remote commands never see this script's stdin: nas() pins ssh -n
# (stdin from /dev/null). The single exception is nas_stdin() for
# `docker load`, whose stdin the caller explicitly redirects.
nas() {
  ssh -n -F none -i "$NAS_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=4 \
      "${NAS_USER}@${NAS_HOST}" "$@"
}
nas_stdin() {
  ssh -F none -i "$NAS_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=4 \
      "${NAS_USER}@${NAS_HOST}" "$@"
}

# ---------- download ----------------------------------------------------
# Only a successful workflow_dispatch of THIS workflow on this repository's
# own main branch is a trusted producer. A fork-PR run can modify this same
# workflow path and upload arbitrary images under a fork head repo, and a
# push run on another branch is not a release build — all are refused here.
note "checking provenance of run ${RUN_ID} in ${REPO}"
prov=$(gh api "repos/${REPO}/actions/runs/${RUN_ID}" \
  --jq '[.path, .event, .conclusion, (.head_branch // ""), (.head_repository.full_name // "")] | @tsv') \
  || die "could not read run ${RUN_ID}"
wpath=$(printf '%s' "$prov" | cut -f1)
wevent=$(printf '%s' "$prov" | cut -f2)
concl=$(printf '%s' "$prov" | cut -f3)
wbranch=$(printf '%s' "$prov" | cut -f4)
wrepo=$(printf '%s' "$prov" | cut -f5)
[ "$wpath" = ".github/workflows/build-test-images.yml" ] \
  || die "run ${RUN_ID} is not a build-test-images run (workflow: ${wpath})"
[ "$wevent" = "workflow_dispatch" ] \
  || die "run ${RUN_ID} event is '${wevent}', not workflow_dispatch — refusing its artifact"
[ "$wrepo" = "$REPO" ] \
  || die "run ${RUN_ID} head repository is '${wrepo}', not ${REPO} — refusing its artifact"
[ "$wbranch" = "main" ] \
  || die "run ${RUN_ID} head branch is '${wbranch}', not main — refusing its artifact"
[ "$concl" = "success" ] \
  || die "run ${RUN_ID} concluded '${concl}', not success — refusing its artifact"

note "listing artifacts of run ${RUN_ID} in ${REPO}"
arts=$(gh api "repos/${REPO}/actions/runs/${RUN_ID}/artifacts" \
       --jq '.artifacts[] | [.name, .id] | @tsv') \
  || die "could not list artifacts for run ${RUN_ID}"
count=$(printf '%s\n' "$arts" | grep -c "^${ART_PREFIX}" || true)
[ "$count" = 1 ] || die "expected exactly 1 ${ART_PREFIX}* artifact, found ${count}"
art=$(printf '%s\n' "$arts" | grep "^${ART_PREFIX}" | cut -f1)
art_id=$(printf '%s\n' "$arts" | grep "^${ART_PREFIX}" | cut -f2)
[ -n "$art_id" ] || die "artifact '${art}' has no id in API response"

DL=$DEST/artifact-${RUN_ID}
ZIP=$DEST/artifact-${RUN_ID}.zip
mkdir -p "$DL"

# Owner-only carrier for the signed URL — neither URL nor token ever lands
# in argv, and the file is removed on exit. VERIFY is the manifest scratch.
URLFILE=$(mktemp "$DEST/.tlp-ci-uri.XXXXXX") || die "mktemp failed"
VERIFY=$(mktemp "${TMPDIR:-/tmp}/tlp-ci-manifest.XXXXXX") || die "mktemp failed"
trap 'rm -f "$VERIFY" "$VERIFY".targets "$URLFILE"' EXIT
trap 'exit 1' HUP INT TERM

# Redirect URL only, never followed: gh api follows it, so curl asks for the
# 302 itself. The token reaches curl through env + --variable, not argv.
signed_url() {
  tok=$(gh auth token) || return 1
  GHA_TOK=$tok curl -sS -o /dev/null --variable %GHA_TOK \
    --expand-header "Authorization: Bearer {{GHA_TOK}}" \
    -w '%{redirect_url}' \
    "https://api.github.com/repos/${REPO}/actions/artifacts/${art_id}/zip" 2>/dev/null
}

if [ -f "$ZIP" ] && [ ! -f "$ZIP.aria2" ] && unzip -tq "$ZIP" 2>/dev/null; then
  note "reusing existing ${ZIP} (integrity ok)"
else
  if [ -f "$ZIP" ] && [ ! -f "$ZIP.aria2" ] && ! unzip -tq "$ZIP" 2>/dev/null; then
    note "existing ${ZIP} failed integrity check — re-downloading"
    rm -f "$ZIP"
  fi
  note "downloading artifact '${art}' (id ${art_id}) to ${ZIP} (16 connections)"
  attempt=0; MAX_ATTEMPTS=4
  while :; do
    attempt=$((attempt+1))
    u=$(signed_url) || die "could not obtain a download URL for artifact ${art_id}"
    [ -n "$u" ] || die "artifact zip request returned no redirect URL"
    # aria2 input file: the indented out= pins the local name — the server
    # sends Content-Disposition and -o alone is ignored in this input form.
    { printf '%s\n' "$u"; printf '  out=%s\n' "artifact-${RUN_ID}.zip"; } > "$URLFILE"
    aria2c --console-log-level=warn --download-result=hide --summary-interval=0 \
      -x16 -s16 -k1M -c --file-allocation=none \
      --retry-wait=5 --max-tries=3 --timeout=60 --connect-timeout=30 \
      --auto-file-renaming=false --allow-overwrite=true \
      -d "$DEST" -i "$URLFILE" \
      && arc=0 || arc=$?
    # Complete = exit 0 AND no .aria2 control file left. rc=22 (or any
    # non-zero with a control file) means resume with a fresh URL.
    if [ ! -f "${ZIP}.aria2" ]; then
      [ "$arc" = 0 ] && break
      [ "$attempt" -ge "$MAX_ATTEMPTS" ] \
        && die "artifact download failed (aria2c exit ${arc})"
      note "aria2c exited ${arc} without resume data — retrying with a fresh URL"
    else
      [ "$attempt" -ge "$MAX_ATTEMPTS" ] \
        && die "artifact download incomplete after ${MAX_ATTEMPTS} attempts"
      note "download interrupted (aria2c exit ${arc}) — fetching a fresh URL and resuming"
    fi
  done
  unzip -tq "$ZIP" 2>/dev/null \
    || die "downloaded zip failed integrity test — nothing reaches the NAS"
fi

note "extracting artifact into ${DL}"
unzip -qo "$ZIP" -d "$DL" || die "could not extract ${ZIP}"

# ---------- locate + verify archive -------------------------------------
# Files are located by name anywhere under the download dir — artifact
# extraction does not guarantee a fixed top-level layout.
# Only the image archive matches tlp-test-*: fs-lists.tar.gz and other
# evidence files in the same artifact must not be mistaken for it.
archives=$(find "$DL" -type f \( -name 'tlp-test-*.tar.gz' -o -name 'tlp-test-*.tar' \) -print | sort)
acount=$(printf '%s\n' "$archives" | grep -c . || true)
[ "$acount" = 1 ] || die "expected exactly 1 tlp-test-* image archive in artifact, found ${acount}"
ARCHIVE=$archives

SHA_FILE=$(find "$DL" -type f -name '*.sha256' -print | sort | head -1)
[ -n "$SHA_FILE" ] || die "no .sha256 file in artifact — refusing to continue"
MANIFEST=$(find "$DL" -type f -name 'manifest.json' -print | sort | head -1)
[ -n "$MANIFEST" ] || die "manifest.json missing in artifact"

# Hash the archive we actually located, then require agreement from both the
# .sha256 file and the manifest — a .sha256 naming another file cannot pass.
if command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$ARCHIVE" | awk '{print $1}')
else
  die "no shasum or sha256sum available to verify the archive"
fi
file_sha=$(awk 'NR==1{print $1}' "$SHA_FILE")
file_named=$(awk 'NR==1{print $NF}' "$SHA_FILE" | sed 's|.*/||')
[ "$file_sha" = "$actual_sha" ] \
  || die "archive sha256 MISMATCH — nothing is sent to the NAS"
[ "$file_named" = "$(basename "$ARCHIVE")" ] \
  || die ".sha256 names '${file_named}' but archive is '$(basename "$ARCHIVE")'"
ARCHIVE_SHA=$actual_sha
note "archive sha256 verified: ${ARCHIVE_SHA}"

# ---------- verify manifest commit --------------------------------------
python3 - "$MANIFEST" >"$VERIFY" <<'PY' || die "could not parse manifest.json"
import json, sys
m = json.load(open(sys.argv[1]))
print("commit=" + str(m.get("commit", "")))
print("archive=" + str(m.get("archive", "")))
print("archive_sha256=" + str(m.get("archive_sha256", "")))
for t in m.get("targets", []):
    ids = ",".join(t.get("diff_ids") or [])
    print("|".join(["T", str(t.get("target", "")), str(t.get("tag", "")),
                    str(t.get("config_digest", "")), ids]))
PY
MANI_COMMIT=$(sed -n 's/^commit=//p' "$VERIFY")
[ "$MANI_COMMIT" = "$WANT_COMMIT" ] \
  || die "manifest commit ${MANI_COMMIT} != expected ${WANT_COMMIT} — refusing to load"
grep -q '^T|' "$VERIFY" || die "manifest lists no targets"
MANI_ARCHIVE=$(sed -n 's/^archive=//p' "$VERIFY")
MANI_AWSHA=$(sed -n 's/^archive_sha256=//p' "$VERIFY")
[ -n "$MANI_ARCHIVE" ] && [ "$(basename "$ARCHIVE")" = "$(basename "$MANI_ARCHIVE")" ] \
  || die "manifest archive '${MANI_ARCHIVE}' != located '$(basename "$ARCHIVE")'"
[ "$MANI_AWSHA" = "$ARCHIVE_SHA" ] \
  || die "manifest archive_sha256 != verified ${ARCHIVE_SHA} — refusing to load"

# Every expected image must be present and tagged exactly
# tlp-test:<commit>-<target>; anything else is not loaded. Literal words in
# the list — `for t in $var` does not word-split under zsh.
for t in runner worker builder; do
  grep -q "^T|${t}|tlp-test:${WANT_COMMIT}-${t}|" "$VERIFY" \
    || die "manifest missing expected target/tag tlp-test:${WANT_COMMIT}-${t}"
done
# Reject manifest entries whose tag could carry shell metacharacters: the tag
# is interpolated into a remote ssh command.
bad=$(grep '^T|' "$VERIFY" | cut -d'|' -f3 | grep -v '^tlp-test:[0-9a-f]\{40\}-[a-z]*$' || true)
[ -z "$bad" ] || die "manifest contains unexpected tag: ${bad}"
note "manifest commit verified: ${MANI_COMMIT}"

# ---------- NAS preflight ------------------------------------------------
[ -f "$NAS_KEY" ] || die "ssh identity ${NAS_KEY} is missing"
ssh-keygen -F "$NAS_HOST" >/dev/null 2>&1 \
  || die "no known_hosts entry for ${NAS_HOST}; verify the host key before running this"

stop=$(nas "test -f '${NAS_STOP}' && echo present || echo absent") \
  || die "ssh to ${NAS_HOST} failed — nothing was sent"
[ "$stop" = absent ] \
  || die "sentinel ${NAS_STOP} exists on the NAS (or answer was '${stop}') — aborting"

# ---------- load ----------------------------------------------------------
note "streaming $(basename "$ARCHIVE") to docker load on ${NAS_HOST}"
if ! nas_stdin 'docker load' < "$ARCHIVE" > "$DL/docker-load.log" 2>&1; then
  tail -10 "$DL/docker-load.log" >&2 || true
  die "docker load failed on NAS (log: $DL/docker-load.log)"
fi
cat "$DL/docker-load.log"

# ---------- read back + compare ------------------------------------------
grep '^T|' "$VERIFY" > "$VERIFY.targets"
: > "$DL/receipt.txt"
fails=0
while IFS='|' read -r _t _target tag cdig dids; do
  out=$(nas "docker image inspect '${tag}' --format '{{.Id}}|{{index .Config.Labels \"org.opencontainers.image.revision\"}}|{{json .RootFS.Layers}}'" 2>/dev/null) \
    || { printf 'FAIL %s: docker image inspect failed\n' "$tag" | tee -a "$DL/receipt.txt" >&2; fails=1; continue; }
  iid=${out%%|*}
  rest=${out#*|}
  irev=${rest%%|*}
  ilayers=${rest#*|}
  if [ "$irev" != "$WANT_COMMIT" ]; then
    printf 'FAIL %s: revision label [%s] != expected %s\n' "$tag" "$irev" "$WANT_COMMIT" \
      | tee -a "$DL/receipt.txt" >&2
    fails=1
    continue
  fi
  if [ "$iid" = "$cdig" ]; then
    kind="config digest match (classic image store)"
  else
    got=$(printf '%s' "$ilayers" | tr -d '"[][:space:]')
    want=$(printf '%s' "$dids" | tr -d '[:space:]')
    if [ -n "$want" ] && [ "$got" = "$want" ]; then
      kind="rootfs diff_ids content match (containerd image store)"
    else
      printf 'FAIL %s: .Id %s matches neither config digest %s nor content diff_ids — cannot verify\n' \
        "$tag" "$iid" "$cdig" | tee -a "$DL/receipt.txt" >&2
      fails=1
      continue
    fi
  fi
  printf 'ok   %s  %s  [%s]\n' "$tag" "$iid" "$kind" | tee -a "$DL/receipt.txt"
done < "$VERIFY.targets"

echo "---- load receipt ----"
echo "commit:  ${WANT_COMMIT}"
echo "run id:  ${RUN_ID}"
echo "archive: $(basename "$ARCHIVE")  sha256=${ARCHIVE_SHA}"
cat "$DL/receipt.txt"
[ "$fails" = 0 ] || die "one or more images failed verification"
note "all images verified on ${NAS_HOST}"
