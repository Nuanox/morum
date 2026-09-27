#!/bin/bash
# Per-session setup for Claude Code cloud sessions (and any Ubuntu box with PostgreSQL 16 installed):
# starts the local Postgres cluster, creates the disposable test database, and applies the migrations.
# Cached cloud snapshots keep installed packages but not running processes, so run this at session start:
#   bash scripts/cloud-session.sh
# Then: npm run test:functional ; TEST_DATABASE_URL=postgresql://claude:claude@localhost/kb_core_test_cloud ALLOW_TEST_DB_WRITES=1 ACK_DISPOSABLE_POSTGRES=1 npm run test:db
set -e
cd "$(dirname "$0")/.."
# As root (cloud containers) run as the postgres user via runuser; otherwise via sudo.
if [ "$(id -u)" -eq 0 ]; then AS_PG="runuser -u postgres --"; ROOT=""; else AS_PG="sudo -u postgres"; ROOT="sudo"; fi
$ROOT pg_ctlcluster 16 main start 2>/dev/null || true
for i in 1 2 3 4 5; do $AS_PG pg_isready -q && break; sleep 1; done
$AS_PG psql -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claude') THEN CREATE ROLE claude LOGIN SUPERUSER PASSWORD 'claude'; END IF; END \$\$;"
$AS_PG psql -qtc "SELECT 1 FROM pg_database WHERE datname='kb_core_test_cloud'" | grep -q 1 || $AS_PG createdb -O claude kb_core_test_cloud
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://claude:claude@localhost/kb_core_test_cloud}" ALLOW_TEST_DB_WRITES=1 ACK_DISPOSABLE_POSTGRES=1
[ -d node_modules ] || npm ci
node scripts/apply-test-db.mjs
echo "cloud session ready: Postgres running, migrations applied to $TEST_DATABASE_URL"
