#!/usr/bin/env bash
set -euo pipefail

# End-to-end CLI integration test.
# Boots the monorepo server against owlmetry_test, seeds it, ingests sample
# events, then runs the integration vitest against the live server.
#
# Expects ../owlmetry/ checked out alongside this repo.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MONOREPO_DIR="$ROOT_DIR/../owlmetry"
SERVER_PID=""
TEST_PORT=4114
TEST_DB="postgres://localhost:5432/owlmetry_test"
TEST_DB_NAME="owlmetry_test"
TEST_CLIENT_KEY="owl_client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TEST_CLI_AGENT_KEY="owl_agent_ffffffffffffffffffffffffffffffffffffffffffffffff"

if [ ! -d "$MONOREPO_DIR" ]; then
    echo "error: monorepo not found at $MONOREPO_DIR" >&2
    echo "clone owlmetry/owlmetry alongside this repo and try again." >&2
    exit 1
fi

cleanup() {
    if [ -n "$SERVER_PID" ]; then
        echo "Stopping test server (pid $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "=== Building monorepo (for server + seed scripts) ==="
cd "$MONOREPO_DIR"
pnpm build

echo "=== Seeding test database ==="
cd "$MONOREPO_DIR/apps/server"
./node_modules/.bin/tsx "$MONOREPO_DIR/scripts/seed-test-db.mts"

# Create a full-permission agent key for CLI integration tests
TEAM_ID=$(psql -tA "$TEST_DB_NAME" -c "SELECT id FROM teams LIMIT 1")
OWNER_ID=$(psql -tA "$TEST_DB_NAME" -c "SELECT user_id FROM team_members WHERE team_id = '$TEAM_ID' AND role = 'owner' LIMIT 1")

EXISTING_CLI_KEY=$(psql -tA "$TEST_DB_NAME" -c "SELECT id FROM api_keys WHERE secret = '$TEST_CLI_AGENT_KEY' LIMIT 1")
PERMS='["events:read","apps:read","apps:write","projects:read","projects:write","metrics:read","metrics:write","funnels:read","funnels:write","audit_logs:read","feedback:read","feedback:write"]'
if [ -z "$EXISTING_CLI_KEY" ]; then
    echo "Creating full-permission CLI agent key..."
    psql -tA "$TEST_DB_NAME" <<SQL
INSERT INTO api_keys (secret, key_type, app_id, team_id, name, created_by, permissions)
VALUES ('$TEST_CLI_AGENT_KEY', 'agent', NULL, '$TEAM_ID', 'CLI Test Agent Key', '$OWNER_ID',
  '$PERMS'::jsonb);
SQL
    echo "CLI agent key seeded"
else
    echo "CLI agent key exists — refreshing permissions"
    psql -tA "$TEST_DB_NAME" -c "UPDATE api_keys SET permissions = '$PERMS'::jsonb WHERE secret = '$TEST_CLI_AGENT_KEY'"
fi

APP_ID=$(psql -tA "$TEST_DB_NAME" -c "SELECT id FROM apps WHERE platform = 'apple' LIMIT 1")

echo "=== Starting test server on port $TEST_PORT ==="
DATABASE_URL="$TEST_DB" \
PORT="$TEST_PORT" \
JWT_SECRET="test-secret" \
HOST="127.0.0.1" \
    ./node_modules/.bin/tsx "$MONOREPO_DIR/apps/server/src/index.ts" &
SERVER_PID=$!

echo "Waiting for server..."
for i in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:$TEST_PORT/health" > /dev/null 2>&1; then
        echo "Server ready"
        break
    fi
    if [ "$i" -eq 20 ]; then
        echo "Server failed to start"
        exit 1
    fi
    sleep 0.5
done

echo "=== Ingesting test events ==="
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
curl -sf -X POST "http://127.0.0.1:$TEST_PORT/v1/ingest" \
  -H "Authorization: Bearer $TEST_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"bundle_id\":\"com.owlmetry.test\",\"events\":[
    {\"message\":\"CLI test event info\",\"level\":\"info\",\"timestamp\":\"$TIMESTAMP\",\"session_id\":\"00000000-0000-0000-0000-000000000099\"},
    {\"message\":\"CLI test event error\",\"level\":\"error\",\"timestamp\":\"$TIMESTAMP\",\"session_id\":\"00000000-0000-0000-0000-000000000099\"}
  ]}" > /dev/null

echo "Events ingested"

echo "=== Running CLI integration tests ==="
cd "$ROOT_DIR"
OWLMETRY_TEST_ENDPOINT="http://127.0.0.1:$TEST_PORT" \
OWLMETRY_TEST_AGENT_KEY="$TEST_CLI_AGENT_KEY" \
OWLMETRY_TEST_TEAM_ID="$TEAM_ID" \
OWLMETRY_TEST_APP_ID="$APP_ID" \
    npx vitest run src/__tests__/integration/ --test-timeout 15000 2>&1

echo "=== CLI integration tests passed ==="
