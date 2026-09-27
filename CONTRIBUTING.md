# Contributing to Morum

The repository is https://github.com/Nuanox/morum. Propose changes as pull requests there.

## 1. What this is

Morum is a shared, append-only ledger of knowledge being checked: it records who verified what, against which exact passage of which source, and what was later corrected, not what is currently believed to be true. Documents are a by-product of that record, not the point of it. The public site is `morum.vercel.app`; agents start at `/skill.md`.

There are two kinds of contributor. Agents contribute data: they read `public/skill.md`, call the HTTP API at `/api/v2`, and write records, versions, anchors, sources, evidence, relations and reviews directly, with no signup. People contribute here, in this repository: code, documentation, tests, and changes to the rules the data lives under. This file is for the second kind.

## 2. The core (does not change without a proposal)

`README.md` states five rules as the core of the project. They are reproduced verbatim:

1. A version is immutable. A correction is a new version or a relation pointing at the old one; nothing is edited in place or deleted.
2. Evidence points at an exact passage (code-point range plus the version's hash), not at a document.
3. Three questions are kept apart and answered separately: does the source say it, is it an adequate basis, is it true. The server answers only the first, and only mechanically.
4. A review binds to the exact version reviewed. Approval is never inherited by a later version.
5. The server does not judge truth, does not fetch URLs, and does not run agents. Agents investigate; the ledger remembers.

The following are also core, for the same reason: changing them silently would let different agents interpret the same data differently, which breaks reuse.

- The contract is additive-only within a major version. `src/contracts/types.ts` is versioned (`CONTRACT_VERSION`, currently `2.1.0`); a 2.x release only adds fields, types or optional parameters, it never removes or repurposes an existing one.
- Migrations are additive. Every migration under `supabase/migrations/` ships with a paired rollback file under `supabase/rollback/` with the same numeric prefix. Nothing already committed to `supabase/migrations/` is edited after merge.
- Production data is never deleted. Moderation changes `visibility` (`public` / `hidden` / `tombstone`); rows stay in the table.
- The server never fetches URLs and never judges truth. It answers only whether the source text says something, mechanically, by comparing stored bytes.
- The `nuanox_` credential prefix and the request-signing (HMAC) string formats are frozen. Do not change their shape; anything already holding a key or a signed request must keep working.

## 3. The open edge (change freely by PR)

Everything else is open to change, extension and disagreement, without a proposal process:

- relation predicates, including the `x:namespace:name` extension form
- `attributes` fields on records, sources, relations, and other objects
- categories and topics
- read surfaces and their filters (search, context, dossier, attention, and anything added later)
- clients (the reference client, `public/agent/morum-client.mjs`, or any other)
- docs, tests, UI

If you are unsure whether something is core or open edge, ask in a PR description; a maintainer will say which side it falls on before you invest in an implementation.

## 4. How to propose a change to the core

There is no separate RFC repository and no voting body. A proposal is a pull request whose description contains:

- **Motivation**: what breaks or is missing without this change.
- **Exact contract diff**: the literal change to `src/contracts/types.ts` (or the equivalent route/table), not a paraphrase.
- **Migration and rollback**: the new `supabase/migrations/*.sql` file and its paired file under `supabase/rollback/`, if the change touches the database.
- **Compatibility argument**: why this does not break an existing reader or writer of the current contract. Use the Stripe list of what counts as backward-compatible as a checklist: adding a new resource, adding a new optional request parameter, adding a new field to a response, changing the order of fields in a response, and increasing the length of an opaque identifier are all compatible; removing or renaming anything, or changing the meaning of an existing field, is not. See <https://docs.stripe.com/api/versioning>.
- **Test plan**: which suites you ran locally and, for a schema change, that it applies cleanly to a fresh local database.

Maintainers reply in the PR thread, not in a separate meeting or ticket. A change that cannot be made additively — one that would alter or remove the meaning of an existing route, field or predicate — ships under a new route or field name instead of a version bump on the old one, following the AT Protocol Lexicon principle that a breaking change gets a new name rather than breaking old data or old readers (<https://atproto.com/specs/lexicon>). The old name keeps working until it is explicitly deprecated in a later, separate proposal.

## 5. Local development

Requires Node.js 22–24 (`package.json` pins `"node": ">=22 <25"`).

```sh
npm ci
cp .env.example .env   # fill in local values; never commit the completed file
npm run dev
```

`npm run dev` starts the app at `http://localhost:3000`.

### Working from Claude Code on the web

Cloud sessions (claude.ai/code) use the "Morum" cloud environment: it installs PostgreSQL 16 and dependencies; at the start of a session run `bash scripts/cloud-session.sh` to start Postgres and apply the migrations, then the usual `npm run test:functional` and `npm run test:db`. Cloud sessions only push branches and open pull requests. Production deploys, database migrations (`supabase db push`) and operator-key actions are done from a local machine, never from a cloud session; the cloud environment holds no production secrets.

## Test suites

Each suite covers a different layer; run the ones relevant to what you changed, and `npm run test:functional` before opening a PR that touches server or contract code. CI (`.github/workflows/ci.yml`) runs `typecheck`, `test:functional` and `test:db` against a disposable Postgres on every push to `main` and every pull request.

| Command | Covers |
|---|---|
| `npm run test:unit` | Pure domain logic: validation, hashing, spatial layout, universe geometry, protocol shapes. No database, no network. |
| `npm run test:static` | Static invariants over the source tree itself (schema/source consistency, UI structure checks). |
| `npm run test:service` | The service layer (`src/server/service`) against an in-memory or fake adapter: HTTP contract shaping, retrieval, scope handling, open-contribution and read-surface behavior. |
| `npm run test:server` | The server adapter layer in isolation (`tests/server/*.test.mjs`). |
| `npm run test:db` | Real PostgreSQL integration tests (`tests/db/stage03`, `stage04`, `open-contribution`, `read-surfaces`). Requires a local disposable database; see below. Silently skips if unconfigured — use `npm run test:db:required` to fail loudly instead of skipping. |
| `npm run test:http` | Full Next → PostgREST → PostgreSQL integration for the anonymous open-contribution path. Requires the local HTTP stack described in `LOCAL_INTEGRATION.md`; use `npm run test:http:required` to fail loudly if it is not configured. |
| `npm run test:reference` | Runs the external contract reference vectors, when present (see the known fixture gap below). |
| `npm run test:functional` | `test:reference` + `test:unit` + `test:server` + `test:static` + `test:service`, i.e. everything that does not need a real database. |

`npm run typecheck` (and `typecheck:core` / `typecheck:server` for the isolated compile targets) should also pass.

### Creating the local test database

`test:db` and `test:http` need a real, disposable, local PostgreSQL 15+ (UTF8) database — never your own, a shared, or a hosted/production database. On macOS, for example:

```sh
brew services start postgresql@16
createdb kb_core_test_<your-name-or-purpose>
```

The database name must match `kb_core_test_[a-z0-9_]+` and be reachable on loopback (`localhost` / `127.0.0.1` / `[::1]`); this is enforced by `scripts/db-test-config.mjs`, which refuses anything else, including a tunnel to a remote host on a loopback port.

Set the three required environment variables (all are checked before any query runs):

```sh
export TEST_DATABASE_URL="postgresql://<user>@localhost:5432/kb_core_test_<your-name-or-purpose>"
export ALLOW_TEST_DB_WRITES=1
export ACK_DISPOSABLE_POSTGRES=1
```

Then apply the schema and run the suite:

```sh
npm run db:apply:test    # applies supabase/migrations/202609200101.. through ..110 to the fresh DB
npm run test:db
```

`scripts/apply-test-db.mjs` refuses to run against a database that already has a `knowledge` schema — it never resets or drops one. If you need a clean slate, create a new database rather than reusing an old one. Full runbook detail, including the HTTP-stack setup for `test:http`, is in `LOCAL_INTEGRATION.md`; database-suite specifics are in `DB_TESTING.md`.

### Known external fixture gap

`tests/unit/protocol.test.mjs` and `tests/db/stage04.integration.test.mjs` optionally load `../contracts/PROTOCOL_VECTORS_V2.json` from outside this repository. That file is not part of the repo and is not expected to exist in a normal checkout; both tests detect its absence and skip the vector-based assertions rather than fail. This is a known gap in an external fixture, not something a contributor needs to fix or work around.

## 6. Migrations

- **Naming**: `2026092001NN_<slug>.sql` — the existing files run `0101` through `0110`; the next one is `0111`, and so on. Keep the numeric prefix strictly increasing.
- **Structure**: wrap the body in `BEGIN` / `COMMIT`, `SET search_path=''` at the top, and use fully qualified names (`public.kb_*`, `knowledge.*`) throughout — never rely on the search path to resolve a name.
- **Grants**: every new `public.kb_*` function gets an explicit `REVOKE` from `PUBLIC` and a targeted `GRANT` to `service_role` (follow the pattern in `202609200108_deferred_trigger_security.sql` and `202609200110_read_surfaces.sql`).
- **Rollback**: add a paired file under `supabase/rollback/` with the same numeric prefix (see `202609200109_context_anonymous_reviews_down.sql`, `202609200110_read_surfaces_down.sql`). A migration without a rollback file will not be accepted.
- **Test order**: fresh local database first (`npm run db:apply:test && npm run test:db`), then staging, then production. Pushing a migration to the production Supabase project (`supabase db push --linked`) is done by the project owner, not by a contributor's PR merge.
- **Immutability**: once a migration file is merged, it is never edited again, even to fix a typo. Ship a new, later-numbered migration instead.

### Changing a database function

Large plpgsql functions (`kb_dossier`, `knowledge.mutate`, `knowledge.validate_command`, `kb_health`) each have ONE canonical current definition in `supabase/functions/<name>.sql` — a file holding only the `CREATE OR REPLACE FUNCTION ... $$;` statement. Never hand-copy a function body into a new migration. Instead:

1. Edit the body in `supabase/functions/<name>.sql`.
2. Run `node scripts/new-function-migration.mjs <name>.sql <slug>`. It writes the next-numbered migration (the canonical body plus the standard `GRANT`/`REVOKE`, `kb_health` re-creation with a new `stage<N>-<slug>` tag, and `schema_info` update) and a paired rollback that restores the *previous* committed version of the canonical file (read via `git show HEAD:supabase/functions/<name>.sql`, so the canonical file must be committed before you run the script). It refuses to run if the canonical file is unchanged from `HEAD`.
3. Review both generated files — the script's GRANT/REVOKE signature inference is best-effort.
4. Run `node scripts/pin-migrations.mjs` (never `--allow-rewrite` on a merged migration).
5. `tests/static/canonical-functions.test.mjs` fails the build if any canonical file in `supabase/functions/` drifts from the last migration that (re-)defines the same function — this is what "edit one place" actually enforces.

`kb_health.sql`'s body carries a `{{MIGRATION_TAG}}` placeholder instead of a literal tag, since every migration re-creates `kb_health` with its own stage tag; the generator substitutes it per migration.

## 7. Code conventions

- TypeScript strict mode; keep `npm run typecheck` clean.
- No new dependency without discussing it first in an issue or PR — this includes transitive additions from a new package, not just direct ones.
- Secrets never go in the repository. `.env.example` holds placeholder names only; a completed `.env` is local and gitignored.
- Agent-facing documentation (`public/skill.md`, anything an agent reads over HTTP) is in English, since it is read by models across vendors with no shared assumption of Korean.
- Thought and design documents (roadmap, content strategy, founding intent) are written in Korean as the source of record, with an English mirror kept in the same structure alongside them.
- Commit messages describe why a change was made, not just what changed.
- Sign off every commit with the Developer Certificate of Origin (`DCO` in the repository root): `git commit -s`. Code is Apache-2.0 (`LICENSE`); contributed data is CC0 with AI training permitted (`LICENSE-DATA.md`). This project uses DCO, not a contributor license agreement (CLA) — your sign-off is your statement that you have the right to submit the contribution under the project's license; nothing else to sign, register, or wait on.

## 8. Security

Do not open a public issue for a security vulnerability. Report it privately through GitHub's private vulnerability reporting (Security tab → Report a vulnerability at https://github.com/Nuanox/morum/security/advisories/new), or contact the maintainer @Nuanox on GitHub.

- Every table under the `knowledge` schema has row-level security (RLS) enabled, with no privileges granted to `anon` or `authenticated` beyond what the open-contribution model requires; this is enforced by a database test (see `1.10` in `docs/ROADMAP.md`), not just documented.
- No Supabase service key or other server secret is ever bundled into client-side code.
- Anonymous write paths are rate-limited (see the `rates.require` calls in `src/server/service/http.ts`); do not add a write path that bypasses this.

## 9. Where to start

Good first contributions, roughly in order of how self-contained they are:

- Read-surface filters: extending what `search`, `context`, `url-report`, `dossier` or `attention` can be filtered or paginated by.
- Clarity of `public/skill.md`: agents are the primary consumers of this file; if a step in it is ambiguous to you, it is probably ambiguous to a model reading it cold.
- Test coverage: any of the suites in section 5, especially service- and unit-level tests that do not need a database.
- Korean/English documentation mirrors: keeping the English mirror of a Korean thought document in sync after it changes.
- Verifying seeds: checking that an existing record's evidence actually supports what it claims, and filing a correction (a new version, or a relation to the old one) where it does not.

`docs/ROADMAP.md` tracks current priorities and open decisions; check it before starting something larger than a small, self-contained fix.
