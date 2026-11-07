#!/bin/sh
set -eu
: "${WORKSPACE_IMAGE:?set the owned dev worker image tag}"
: "${WORKSPACE_BOUNDARY_BUNDLE:?set the absolute external boundary bundle path}"
run="yuk1982-$(openssl rand -hex 4)"
cleanup() {
  docker rm -f "$run-probe" "$run-migrate" "$run-http" "$run-pg" >/dev/null 2>&1 || true
  docker network rm "$run" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
# Only these freshly named containers are owned by this run. No host ports or
# existing volumes/databases are used, and the credentials below are synthetic.
docker network create "$run" >/dev/null
docker run -d --name "$run-pg" --network "$run" --network-alias sandbox-pg \
  --memory 512m --pids-limit 100 --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_PASSWORD=synthetic-dev-only -e POSTGRES_DB=workspace_dev \
  pgvector/pgvector:pg16 >/dev/null
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$run-pg" pg_isready -U postgres -d workspace_dev >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ]
url='postgres://postgres:synthetic-dev-only@sandbox-pg:5432/workspace_dev?sslmode=disable'
docker run --name "$run-migrate" --network "$run" --memory 512m --pids-limit 100 \
  -e DATABASE_URL="$url" --entrypoint node "$WORKSPACE_IMAGE" dist/migrate.cjs
docker run -d --name "$run-http" --network "$run" --network-alias sandbox-internal \
  --memory 128m --pids-limit 32 --entrypoint python3 "$WORKSPACE_IMAGE" \
  -m http.server 8080 >/dev/null
docker run --name "$run-probe" --network "$run" --memory 768m --pids-limit 128 \
  --user root -e DATABASE_URL="$url" -e WORKSPACE_BOUNDARY_DEV=1 \
  -e SYNTHETIC_CANARY=WORKSPACE_SYNTHETIC_CANARY \
  -v "$WORKSPACE_BOUNDARY_BUNDLE:/boundary.cjs:ro" --entrypoint /bin/sh "$WORKSPACE_IMAGE" -c '
    mkdir -p /var/lib/tlp/chatgpt-auth
    printf %s WORKSPACE_SYNTHETIC_CANARY > /var/lib/tlp/chatgpt-auth/canary
    chown -R node:node /var/lib/tlp/chatgpt-auth
    chmod 700 /var/lib/tlp/chatgpt-auth
    chmod 600 /var/lib/tlp/chatgpt-auth/canary
    exec setpriv --reuid=1000 --regid=1000 --clear-groups node --test /boundary.cjs
  '
