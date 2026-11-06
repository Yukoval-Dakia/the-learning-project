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

need gh; need ssh; need ssh-keygen; need find; need python3
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
      -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "${NAS_USER}@${NAS_HOST}" "$@"
}
nas_stdin() {
  ssh -F none -i "$NAS_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "${NAS_USER}@${NAS_HOST}" "$@"
}

# ---------- download ----------------------------------------------------
note "listing artifacts of run ${RUN_ID} in ${REPO}"
names=$(gh api "repos/${REPO}/actions/runs/${RUN_ID}/artifacts" \
        --jq '.artifacts[].name') || die "could not list artifacts for run ${RUN_ID}"
count=$(printf '%s\n' "$names" | grep -c "^${ART_PREFIX}" || true)
[ "$count" = 1 ] || die "expected exactly 1 ${ART_PREFIX}* artifact, found ${count}"
art=$(printf '%s\n' "$names" | grep "^${ART_PREFIX}")

DL=$DEST/artifact-${RUN_ID}
mkdir -p "$DL"
note "downloading artifact '${art}' into ${DL}"
gh run download "$RUN_ID" --repo "$REPO" --name "$art" --dir "$DL" \
  || die "artifact download failed"

# ---------- locate + verify archive -------------------------------------
# Files are located by name anywhere under the download dir — artifact
# extraction does not guarantee a fixed top-level layout.
archives=$(find "$DL" -type f \( -name '*.tar.gz' -o -name '*.tar' \) -print | sort)
acount=$(printf '%s\n' "$archives" | grep -c .)
[ "$acount" = 1 ] || die "expected exactly 1 image archive in artifact, found ${acount}"
ARCHIVE=$archives

SHA_FILE=$(find "$DL" -type f -name '*.sha256' -print | sort | head -1)
[ -n "$SHA_FILE" ] || die "no .sha256 file in artifact — refusing to continue"
MANIFEST=$(find "$DL" -type f -name 'manifest.json' -print | sort | head -1)
[ -n "$MANIFEST" ] || die "manifest.json missing in artifact"

# The .sha256 references the archive by basename, so verify inside its own dir.
if command -v shasum >/dev/null 2>&1; then
  (cd "$(dirname "$SHA_FILE")" && shasum -a 256 -c "$(basename "$SHA_FILE")" >/dev/null) \
    || die "archive sha256 MISMATCH — nothing is sent to the NAS"
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$SHA_FILE")" && sha256sum -c "$(basename "$SHA_FILE")" >/dev/null) \
    || die "archive sha256 MISMATCH — nothing is sent to the NAS"
else
  die "no shasum or sha256sum available to verify the archive"
fi
ARCHIVE_SHA=$(awk 'NR==1{print $1}' "$SHA_FILE")
note "archive sha256 verified: ${ARCHIVE_SHA}"

# ---------- verify manifest commit --------------------------------------
VERIFY=$(mktemp "${TMPDIR:-/tmp}/tlp-ci-manifest.XXXXXX") || die "mktemp failed"
trap 'rm -f "$VERIFY" "$VERIFY".targets' EXIT HUP INT TERM
python3 - "$MANIFEST" >"$VERIFY" <<'PY' || die "could not parse manifest.json"
import json, sys
m = json.load(open(sys.argv[1]))
print("commit=" + str(m.get("commit", "")))
for t in m.get("targets", []):
    ids = ",".join(t.get("diff_ids") or [])
    print("|".join(["T", str(t.get("target", "")), str(t.get("tag", "")),
                    str(t.get("config_digest", "")), ids]))
PY
MANI_COMMIT=$(sed -n 's/^commit=//p' "$VERIFY")
[ "$MANI_COMMIT" = "$WANT_COMMIT" ] \
  || die "manifest commit ${MANI_COMMIT} != expected ${WANT_COMMIT} — refusing to load"
grep -q '^T|' "$VERIFY" || die "manifest lists no targets"
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
  sed -n '1,10p' "$DL/docker-load.log" >&2 || true
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
