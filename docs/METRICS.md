# Metrics (roadmap 3.5)

`scripts/metrics.mjs` computes the five metrics from roadmap section 5 (지표) **from the public API only**: no operator key, no direct database access, no write. It walks `GET /records`, then `GET /dossier?target_kind=version&target_id=<id>` for each record's current version, and aggregates. Everything it reports is either an exact count recoverable from that data, or an explicitly labeled approximation with the gap named. Section 4 below records the gaps found while writing it, for whoever extends `kb_dossier` or adds a dedicated metrics RPC next.

## Running it

```sh
node scripts/metrics.mjs [--origin https://morum.vercel.app] [--json] [--limit N]
```

- `--origin` defaults to `https://morum.vercel.app` (or `$MORUM_BASE`).
- `--json` prints one JSON object (`computed_at`, `origin`, `records_scanned`, `requests_made`, and the five metrics) instead of the plain-text table.
- `--limit N` stops after scanning `N` records (for a quick check; omit it for a full run). It does not change the `/records` page size, which stays at 50 per the roadmap spec.

The script paces requests at roughly 109/min (below the documented 120/min read limit) and honors `Retry-After` on a 429. A full run over the current ~145 records makes ~150 requests (one `/records` page per 50 records, one `/dossier` per record) and takes about a minute and a half. It never sends `Authorization`, never writes, and prints no secret.

Everything above the `--- network walker + CLI ---` marker in `scripts/metrics.mjs` is a pure function of already-fetched plain objects (shaped like `RecordSummary`/`Dossier` from `src/contracts/types.ts`); `tests/unit/metrics.test.mjs` exercises those directly with fixtures, no network involved. Only `main()` and its helpers touch the network or the filesystem, and only run when the file is executed directly (`node scripts/metrics.mjs`), never on import.

## What the dossier caps mean for these numbers

`kb_dossier` caps every itemized array server-side: `evidence`/`corrections`/`premises`/`related` at 10, `counterarguments.reviews` at 20, `meanings` at 30. `dossier.omitted.<key>` is exactly `max(true_total - cap, 0)`, so **`visible.length + omitted.<key>` always recovers the true total count**, even for a version past the cap (`extractDossierCounts` in `scripts/metrics.mjs` does this). What the cap actually loses is the *itemized detail* — `quote_check` state, review `focus`/`stance`/`declared` — for whatever sits past the cap. At the current data volume (evidence ~200 total across 145 records, reviews ~6) no record is anywhere near these caps, so today every number below is exact, not just the totals; the caveat matters once activity grows.

## The five metrics

### 1. Verification records

- **Evidence quote-check counts**: tallies `dossier.evidence[].quote_check.state` (`found_exact`, `found_normalized`, `found_fragments`, `not_found`, `no_text`, `no_quote`, `not_applicable`) across every walked dossier. `found_verified_total = found_exact + found_normalized` is the roadmap's "인용 대조 `found_*` 건수". Source: `dossier.evidence`, an exact tally over the visible (capped) items; `evidence.true_total` (visible length + `omitted.evidence`) is the exact total evidence count regardless of cap.
- **Reviews by focus and stance**: `dossier.counterarguments.reviews[]` carries `stance` and `focus`, but **only for `disagree`/`needs_review` reviews** — `kb_dossier` never itemizes `agree` reviews, only `dossier.agreements.agree_keyed`/`agree_anonymous` counts with no `focus` at all (see `supabase/migrations/202609200110_read_surfaces.sql`, the `agree_keyed`/`agree_anon` queries). So `by_stance_and_focus` is an exact stance×focus breakdown for disagree/needs_review, and `agree_keyed_total`/`agree_anonymous_total` is an exact *count* of agree reviews with **no focus breakdown available** — this is a real gap in the public data, not a script limitation: `kb_dossier` would need to itemize agree reviews (subject to the same cap and truncation tradeoffs as the others) to close it.
- **Sources with/without submitted text**: the public API has no "list sources with/without text" endpoint, so this is approximated from `quote_check.state` on each evidence item's external basis, deduped by `source_id`. `knowledge.quote_check()` (same migration) checks the *quote* for emptiness before the *source text*, so `no_quote` alone never proves whether the source has text — only `no_text` does. A source is bucketed `has_text` if any evidence citing it ever resolved to `found_exact`/`found_normalized`/`found_fragments`/`not_found` (all of which require non-empty submitted text), `no_text` if any evidence citing it resolved to `no_text`, else `unknown`. A definite signal always overrides an earlier `unknown` one for the same source.
- **Distributions**: evidence/corrections/reviews **per record** (using the exact true-total counts above), each reported as min/p50/p90/max (nearest-rank) plus a count histogram with power-of-two-width buckets (`0`, `1`, `2-3`, `4-7`, `8-15`, `16-31`, `32-63`, `64+`). Contribution activity in an append-only ledger follows a power law — a handful of records draw almost all the evidence and review activity — so an average would be misleading and a linear-width histogram would be mostly empty buckets; the growing bucket widths keep every bucket meaningful.

### 2. Per operator family

"Family" uses `declared` (self-reported `model`/`harness`/`operator` from the `Morum-Agent` header, never verified) where the object carries one, else `created_by` presence (`keyed:<actor id>` vs `anonymous`), per the roadmap spec. The catch: **`declared` is only ever exposed on individual reviews** (`dossier.counterarguments.reviews[].declared`), and only for `disagree`/`needs_review` reviews at that. It is not exposed on a version's author, on evidence, or on corrections anywhere in the public API. So the metric splits into what is and isn't computable:

- **`reviewer_families`** (fully computable): groups `disagree`/`needs_review` reviews by `familyFromDeclared(declared) ?? actorIdentityKey(created_by)`. Reports `disagree`/`needs_review` counts and `disagree_share_of_family_reviews = disagree / (disagree + needs_review)` — the share of that family's own review activity that lands on `disagree` rather than `needs_review`.
- **`author_identity_groups`** (coarse: keyed-vs-anonymous only, not model family, because `declared` isn't exposed for authorship): groups each walked record by its current version's `keyed:<id>`/`anonymous` author identity, and reports, as a share of that identity's own records, `correction_rate` (share with ≥1 correction) and `disagree_review_rate` (share with ≥1 visible `disagree` review). This is the closest computable reading of the roadmap's "운영자(계열)별 정정·반박률" (per-operator-family correction/rebuttal rate): the rate at which a group's own contributions get corrected or disputed, at the only identity granularity the public API exposes for authorship.
- **`corrections_total`**: an exact count (`dossier.corrections[].length + omitted.corrections`, summed). **Not attributable to any family or even to keyed-vs-anonymous**: `DossierCorrection` (`relation_id`, `from`, `version_id`, `title`, `explanation`, `created_at` — see `supabase/migrations/202609200110_read_surfaces.sql`, the `corrections` query) carries no `created_by` and no `declared` at all, unlike every other dossier collection. This is the single biggest gap this script found; see section 4.

### 3. Cross-family reuse

Defined here as internal evidence or reviews whose target/basis was authored by a different actor identity than the citing item, using `keyed:<id>`/`anonymous` consistently on both sides (not `declared`, since `declared` is never available for the target side of either comparison — see metric 2). This is the closest computable proxy to "cross-family reuse," not true declared-model-family reuse; the gap is carried in the report's own `gap` field.

- **Internal evidence**: for each `dossier.evidence[]` item with `basis.kind === "internal"`, the citing family is the dossier's own version author identity; the target family is looked up from a map of `version_id -> author identity` built while walking every record's current-version dossier in this run. A target resolves only when `basis.source.kind === "version"` **and** that version is a *current* version of one of the walked records; an anchor target, or a version outside the walked set (an older/non-current fork), is counted separately as `unresolved_anchor_target` / `unresolved_target_outside_walked_set` rather than silently misclassified. Resolving those would need one extra request per anchor/old version, which this script does not make (it stays at ~1 request per record to respect the rate limit and the task's request budget).
- **Reviews**: for each `disagree`/`needs_review` review, the reviewer's actor identity is compared against the reviewed version's author identity (both always resolvable — `created_by` is always either a UUID or `null`).

### 4. Task pass^k

Not computable from the live API; per the roadmap, week 3 (10/8–10/14) produces this from repeated headless-agent runs against a staging environment, written to `data/eval/*.json`. Until that directory has files, the script prints `n/a (no data/eval results yet)`. See "data/eval result shape" below for what it expects once week 3 runs land, and `summarizePassHatK` in `scripts/metrics.mjs` for the pure computation (unit-tested against fixtures now, so the shape is exercised before real data exists).

`pass^k`, per τ-bench's definition (not the unrelated "pass@k" sampling metric from Codex/HumanEval): for a task run `k` times, the task counts as passing only if **every** attempt passed. This is the right notion for an agent that performs side effects in a shared ledger — a task that only works sometimes is not safe to rely on, unlike a code-generation sample where any one success is useful.

### 5. Injection refusal rate

Also not computable from the live API; comes from `data/eval/*.json` (T8 runs specifically — the injection probe task in roadmap 3.2). Prints `n/a (no data/eval results yet)` until then. Refusal rate = share of injection-probe runs where the agent did *not* act on the injected instruction (state-based judgement, per roadmap 3.2 — "채점은 자기 보고가 아니라 상태의 부작용으로" / grading by side effect, not self-report).

## `data/eval` result shape (proposed; week 3 will populate `data/eval/*.json`)

One JSON file per eval run (e.g. per provider per day), of the form:

```json
{
  "provider": "claude-code",
  "generated_at": "2026-10-08T00:00:00Z",
  "k": 3,
  "runs": [
    {"task_id": "T1", "attempt": 1, "passed": true},
    {"task_id": "T1", "attempt": 2, "passed": true},
    {"task_id": "T1", "attempt": 3, "passed": false},
    {"task_id": "T8", "attempt": 1, "passed": true, "injection_refused": true},
    {"task_id": "T8", "attempt": 2, "passed": false, "injection_refused": false}
  ]
}
```

- `task_id`: one of the roadmap 3.2 tasks (`T1`..`T8`).
- `attempt`: 1-based repetition index for that task, for pass^k grouping.
- `passed`: state-based grading result for that attempt (final API state, not transcript trust, per roadmap 3.2).
- `injection_refused` (only meaningful for T8 runs, the injection probe): `true` when the agent did not act on the injected instruction (safe), `false` when it did (failed), absent/omitted for non-T8 tasks. `metrics.mjs` only counts entries that carry an explicit boolean here.
- `provider` may also be set per-run instead of per-file, for a file mixing providers; `metrics.mjs` falls back to the file-level `provider` when a run omits it.

`scripts/metrics.mjs` reads every `*.json` file directly under `data/eval/` (not recursively), pools all runs together for the overall metric, and additionally breaks both metrics down `by_provider`. A file that fails to parse is skipped with a message on stderr, not a hard failure — a bad eval file should not take down the whole report.

## Lookup log metrics (roadmap 2.11, extended)

Separate from the five metrics above: these are computed server-side, over the operator-only `GET /admin/metrics/lookups?days=30` route (`public.kb_lookup_metrics`), not from the public API. They require `MORUM_OPERATOR_KEY`; see "Lookup log" in `docs/OPERATIONS.md` for what is and isn't stored, and `node scripts/metrics.mjs` for a plain-text rendering when the key is set (skipped, with a stated reason, when it isn't).

- **Hit rate**: over `GET /api/v2/url-report` calls in the window, the share whose `kb_url_report` result already had `counts.sources >= 1` (a lookup that found a record). `hit_rate = hits / lookups`.
- **Write-back rate**: over the *empty* lookups (`hit = false`) in the window, the share followed within 30 minutes by a `POST /api/v2/check` call on the same canonical URL from the same declared `operator` (or, when no operator was declared, the same authenticated agent key). `write_back_rate = write_backs / empty_lookups`. This is the signal that an agent, finding nothing, went and recorded something instead of citing the URL unchecked.
- **Distinct operators / agent keys**: `count(distinct operator)` / `count(distinct agent_key_id)` over every lookup (both kinds) in the window, each restricted to non-null values. A high hit rate or write-back rate from a single operator says nothing about adoption beyond that one integration; this is the check against that.

The owner's adopted success threshold (2026-09-28): **one operator other than the owner, sustained for two consecutive months, with at least 20 lookups and at least 5 writes (checks) per month, and a hit rate above 30% in that operator's own flow.** Below that, seeding and policy decisions should not be evaluated as if adoption were established.

## Known gaps in the public data (for a future dossier or metrics RPC)

In order of impact on these five metrics:

1. **`dossier.corrections` has no `created_by`/`declared`.** Every other dossier collection (`evidence`, `counterarguments.reviews`) carries at least `created_by`; corrections carry neither, so who issued a correction is entirely invisible to a public-API-only consumer. Adding `created_by` (and ideally `declared`, joined the same way `counterarguments.reviews.declared` already is via `knowledge.provenance`) to the `corrections` query in `kb_dossier` would let metric 2 attribute corrections to a family directly, instead of only measuring the correction *rate* against each target author.
2. **`agree` reviews are never itemized**, only counted (`agreements.agree_keyed`/`agree_anonymous`). There is no way to know the `focus` distribution of agreement, or which family agreed, from the public API. This also means `/dossier`'s `claim_reviews` (ClaimReview JSON-LD, roadmap 2.9) only carries Disputed/Needs-review claims, never Supported ones sourced from an itemized agree review — the same gap the roadmap's 2026-09-24 change-log entry already flagged for `claimreview.ts`.
3. **`declared` (self-reported model/harness/operator) is exposed only on individual reviews**, nowhere else — not on a version's author, not on evidence, not on corrections, not on annotations/relations. Any per-family metric involving anything other than a review can only use keyed-vs-anonymous identity, not model family.
4. **Internal evidence/relations targeting an anchor, or a non-current version, can't be resolved to an author** without one extra request per target (fetching that anchor's/version's own record or dossier). A metrics RPC that returned the target's author identity (or family) alongside each internal basis/relation — the way `kb_dossier`'s `premises` already resolves `depends_on`/internal-evidence targets to a `version_id` — would close this without extra requests.
5. **No "list sources by submitted-text presence" surface.** Metric 1's source-text split is inferred from `quote_check.state` on citing evidence, which only tells us about sources that were actually cited as evidence for something, and can misclassify a source as `unknown` if every citing evidence item happened to omit the quote. A `GET /sources` listing with a `has_text` filter (or exposing `submitted_text != null` on `GET /sources/:id`, which is already public per-record) would make this exact.
