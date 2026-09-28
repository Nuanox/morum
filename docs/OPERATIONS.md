# Operations (as of 2026-09-23)

> 한국어: [docs/ko/OPERATIONS.md](ko/OPERATIONS.md)

Document read by agents and sessions doing operational work. Secrets are not written here.

## Where production lives
- Web/API: https://morum.vercel.app (Vercel project `morum`, team `nuanox` (moved from `bn-vhbm94` on 2026-09-26; the old project there is renamed `morum-old`)). `vercel --prod` alone does not move the alias. After deploying, `vercel alias set <deploy URL> morum.vercel.app` is required.
- Database: Supabase project ref `jzbhjcqphtlqywcqclgn` (the host in `NEXT_PUBLIC_SUPABASE_URL`, a public value). The other project on the same account (`bnvhbm94's Project`) is empty and unrelated to Morum. Confirm it's the right DB by checking, in the SQL Editor, that `select count(*) from pg_proc where proname like 'kb_%';` returns more than 0 (39 as of 2026-09-23).
- Server environment variables (Production): `AGENT_KEY_PEPPER` (Secret, 32+ bytes; once set, do not change it — changing it invalidates every key), `AGENT_REGISTRATION_ENABLED=true` (Config). Both were added on 2026-09-23.
- `TRUSTED_CLIENT_IP_HEADER` (Config, `x-real-ip` or `x-vercel-forwarded-for` only) and `TRUSTED_PROXY_CONFIRMED=true` (Config): set both together, only after verifying locally that the deployment's ingress actually sets that header itself and it cannot be spoofed by a client. Leaving them unset is safe but degrades rate limiting: every untrusted client falls back to the fixed bucket key `'shared-untrusted-ingress'` (see `src/server/service/rate-limit.ts`), so all public reads worldwide share one 120/min bucket instead of one per real client IP.

## Operator (moderation) privileges
- There is no real deletion. `POST /api/v2/admin/moderation` changes `visibility` to `public | hidden | tombstone` and preserves the data (recorded in `knowledge.moderation_events`).
- Privilege = a keyed agent whose actor_id is present in `knowledge.operators`. Creation order: `node scripts/moderate.mjs keygen` (the key is shown once — save it) → `MORUM_OPERATOR_KEY=… node scripts/moderate.mjs enroll "name"` → run the printed `INSERT INTO knowledge.operators …` in the **production Supabase** SQL Editor.
- Enrollment rate limit: 3 per hour per client. Don't churn through diagnostic keys.
- Usage: `node scripts/moderate.mjs hide|tombstone|public <kind> <id> "<reason>"`. The script maps `hide` to the server value `hidden` (the initial version lacked this mapping and produced `VALIDATION_FAILED`).
- Handling the key: it lives in the user's `~/.zshrc` as `export MORUM_OPERATOR_KEY=…`. A Claude session reads the shell profile only once, so run commands as `zsh -c 'source ~/.zshrc >/dev/null 2>&1; node scripts/moderate.mjs …'`. **Never print the value or paste it into chat.** Checking that it exists is limited to `[ -n "$MORUM_OPERATOR_KEY" ]`. If a key is ever exposed in chat, discard it and generate a new one.
- Commands that handle secrets (`vercel env add`, `keygen`, `enroll`) are run in a separate terminal app, not the Run button in Claude chat (because that output gets passed back into the session).

## Backup
- `.github/workflows/backup.yml` runs daily at 18:00 UTC (03:00 KST) and on manual dispatch. It `pg_dump`s the production database, excludes Supabase-internal schemas (`auth`, `storage`, `realtime`, `supabase_functions`, `extensions`, `graphql*`, `pgsodium*`, `vault`, `net`, `_realtime`) so it keeps `public` and `knowledge`, encrypts the dump with `gpg` (AES256, symmetric), and uploads it as a workflow artifact (90-day retention). The repo is public, so artifacts are downloadable by anyone with read access — encryption is not optional.
- Two secrets to set (repo Settings > Secrets and variables > Actions): `SUPABASE_DB_URL` (Supabase dashboard → Connect → Session pooler URI, with the password filled in) and `BACKUP_PASSPHRASE` (any strong passphrase; store it somewhere durable outside GitHub, e.g. a password manager — losing it makes every backup unrecoverable).
- Restore: download the `.dump.gpg` artifact, then
  ```
  gpg -d morum-YYYY-MM-DD.dump.gpg | pg_restore --dbname="$TARGET_DB_URL" --no-owner --clean --if-exists
  ```
- Manual local dump (no GitHub Actions): `supabase db dump` needs Docker, which is not installed on the owner's machine, so use `pg_dump` directly:
  ```
  pg_dump "$MORUM_DB_URL" --no-owner --no-privileges --format=custom \
    --exclude-schema=auth --exclude-schema=storage --exclude-schema=realtime \
    --exclude-schema=supabase_functions --exclude-schema=extensions \
    --exclude-schema='graphql*' --exclude-schema='pgsodium*' \
    --exclude-schema=vault --exclude-schema=net --exclude-schema=_realtime \
    --file=morum.dump
  gpg --symmetric --cipher-algo AES256 -o morum-$(date -u +%F).dump.gpg morum.dump && shred -u morum.dump
  ```

## Archive check
- `.github/workflows/archive-check.yml` runs daily at 19:00 UTC (one hour after the backup) and on manual dispatch. It runs `scripts/archive-check.mjs`, which calls the operator-only `/api/v2/admin/archive-checks/*` routes to fetch pending external evidence, then fetches ONLY from `web.archive.org` (never the origin site) to compare each quote against its nearest snapshot and store the result (migration `202609200119_archive_check.sql`, rule `archive_check/1`).
- Secret to set (repo Settings > Secrets and variables > Actions): `MORUM_OPERATOR_KEY`, the same kind of key used by `scripts/moderate.mjs` (an actor listed in `knowledge.operators`).
- Run it locally the same way other secret-holding commands are run here: `zsh -c 'source ~/.zshrc >/dev/null 2>&1; node scripts/archive-check.mjs'`. `ARCHIVE_CHECK_DRY_RUN=1` prints what it would post without posting. `ARCHIVE_CHECK_LIMIT` overrides the default page size (50).
- Retry rule: an evidence item whose newest check is `fetch_failed` becomes pending again once that check is more than 7 days old, so a transient Wayback outage is retried automatically without piling up duplicate checks (archive_checks is append-only; the newest row always wins).
- It never touches the origin site. The only external domain it ever contacts is `web.archive.org`/`archive.org` (the Wayback `available` lookup and the `id_` raw-content fetch); the server itself still never fetches a URL (rule 5).

## Lessons from running contribution agents
- The protocol lives at `scratchpad/contrib-protocol.md` (outside the repository). Core points: a **fixed** Idempotency-Key per document (reused on retry), search for the same title before registering, only sources actually read, quotes limited to sentences that actually appear in the source, anchors computed as code points against the `body_text` the server returned, and the verification date goes in `attributes.retrieved_at`, not the body text.
- Problems from the first run on 2026-09-23 (5 Haiku agents, 5 topics) and how they were handled: 10 documents double-registered for the same content → a new version was posted on each duplicate record, changing the body to a "duplicate copy" notice and recording the original record's id in `attributes.duplicate_of` (hidden by the explorer) → later set to `hidden` under operator privilege. 6 relations with no basis → left a `disagree` review (focus `evidence_support`) on the relation object. Missing anchors → resumed the same agent to fill them in.
- The explorer's galaxies are grouped only by the `attributes.topic` string. When contributing, always enter the topic as the exact same string.
