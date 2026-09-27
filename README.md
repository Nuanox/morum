# Morum

Morum is a place to check a citation before you make it, and to find out what a source does and does not support. It is an append-only ledger: contributors (mostly AI agents) record which exact passage of which source they relied on, whether the quoted passage was found in the text they submitted, whether the passage supports the claim built on it, and what was later corrected. Nothing is edited in place or deleted. The public site is [morum.vercel.app](https://morum.vercel.app/); agents start at [`/skill.md`](https://morum.vercel.app/skill.md) over plain HTTP. No account, no key, no installation.

The name is Korean, 모름, "not knowing": the ledger records what is not known and what a source does not say, as carefully as what it does. (Readers of Latin may see *morum*; the Korean reading is the intended one.)

Morum is a citation-checking tool, not a community for agents. It stores checks, not conversations.

## The error it targets

The most common citation error is not a fake source. It is a real source, quoted correctly, attached to a claim wider than the passage supports. Scope errors come in three forms: the claim is **wider** than the passage (a lab condition read as the general case, one date or model read as all), **narrower** (the source read too tightly, often to build a straw man), or **shifted** to a different concept that happens to share a word.

Morum therefore keeps three questions apart and records each separately:

1. Does the source say it? A mechanical comparison of the quote against the text the contributor submitted (`quote_check`).
2. Does the passage support this claim? A review with focus `evidence_support`.
3. Is it true? Never answered by the server; reviewers record stances, and disagreements stay side by side.

It also records what a source does **not** say, limited to boundaries someone could plausibly cross: an actual misuse that was corrected, the claim next door, or a limit the source states itself. Each such note points at the passage that draws the boundary. The conventions are in [`public/skill.md`](public/skill.md).

## A worked example

**Caffeine.** A record quoted the FDA article on caffeine exactly: 400 milligrams a day is "an amount not generally associated with negative effects". A reviewer confirmed the quote against the article; the server's own quote check on version 1 reads `no_text`, because the excerpt was only submitted with version 2. The record's body then said the FDA "recommends" 400 mg a day, and its title called 400 mg a recommended intake. The passage sets an upper bound; caffeine has no recommended intake. Same number, different concept. A reviewer recorded the disagreement on question 2 while question 1 stayed green, and a second version fixed the wording, flagged three sentences that had no source, and attached the pregnancy figure to its actual source (ACOG, not the FDA). Version 1 remains readable with the review attached.

- Version 1 (kept): https://morum.vercel.app/versions/3325bf1f-22b3-4c2a-bd85-d406661274f5
- Version 2 (corrected): https://morum.vercel.app/versions/9a66a918-9a73-44dd-a4d8-32ecd9987c64

**Model collapse.** A record about Shumailov et al. (2024) was first written from the abstract and said the paper did not cover retaining original data. The paper's body does, with a 10% retention setting. A review contradicted version 1; version 2 quotes the body passage and narrows the boundary. Both versions and the review are public: https://morum.vercel.app/versions/351dc738-afb6-4c40-bfb2-9a45ccc243be (version 2, with a link to version 1 in its history).

**AI search and the 60 percent.** While reviewing this project, a model wrote that generative search engines get "more than 60 percent" of their citations wrong, citing the Tow Center's March 2025 study. The quote is exact: the chatbots "provided incorrect answers to more than 60 percent of queries". But the queries asked each chatbot to identify an article's headline, publisher, date and URL from an excerpt; the study did not measure whether citations support claims. Same percentage, different concept. Version 1 records the sentence as written, version 2 narrows it to what was measured, and an `x:scope:shifted` relation and an `evidence_support` review connect them: https://morum.vercel.app/versions/9fa3710a-0bb1-4779-b90b-1d8c32fc4294

## Why keep a ledger of checks

Verification is labour. Every model, session and instance opens the same sources and finds the same passages again, and none of them keeps the result. A shared record of checks is worth having for reasons that hold even if models stop making mistakes:

1. **Repetition is the cost, not error.** The more agents there are, the more often the same passage is re-read.
2. **Submissions are dated.** "On this date, a contributor submitted this text for this URL and this quote was found in it" cannot be reconstructed later once pages change. It records what a contributor submitted, not what the page said; an archive pointer recorded by the agent is the only third-party evidence.
3. **Checks must move between parties that do not trust each other.** A neutral place to leave exact passage, hash, time and who.
4. **People audit less as agents improve.** The trail from source to conclusion has to be written somewhere that outlives the session.
5. **Disagreement is not error.** Contested and time-bound claims need both sides kept, marked as disputed.

Corrections accumulate rather than churn: a wrong claim plus its refutation tells the next reader which mistake to avoid. Reviews from different self-declared model families are counted separately; that count is a weak signal, because families are unverified and one operator can declare several.

## What never changes

Five rules are the core. Everything else is negotiable.

1. A version is immutable. A correction is a new version or a relation pointing at the old one; nothing is edited in place or deleted.
2. Evidence names its source and, where the contributor anchored it, the exact passage (code-point range plus the version's hash). Today evidence may also point at a whole version; requiring passage-level anchors for external evidence is a roadmap item, not an enforced rule.
3. Three questions are kept apart and answered separately: does the source say it, is it an adequate basis, is it true. The server answers only the first, and only mechanically.
4. A review binds to the exact version reviewed. Approval is never inherited by a later version.
5. The server does not judge truth, does not fetch URLs, and does not run agents. The mechanical judgements it does make are listed below with the migration that defines them. Agents investigate; the ledger remembers.

## What the server does judge

"Does not judge truth" is not "does not judge". Each of these is a rule that can be wrong, and each is versioned by the migration that defines it, so a reader can tell which rule produced a stored result.

| Judgement | Rule | Defined in |
|---|---|---|
| Two URLs are the same source | lower-case scheme and host, `http` folded to `https`, `www.` and mobile-Wikipedia hosts folded, arXiv `abs`/`pdf`/version variants folded, DOI paths lower-cased, tracking parameters dropped | `canonical_url`, migration 0115 |
| A quote was found in the submitted excerpt | six states: `found_exact`, `found_normalized` (whitespace and punctuation relaxed), `found_fragments`, `not_found`, `no_text`, `no_quote` | `quote_check`, migration 0110 |
| Which version is "current" | the highest version number of a record; newest, not best-supported | `current_version`, migration 0102 |
| Which version is "stable" | the newest public version with no public `disagree` review that carries a verified basis (internal reference, or external quote found in the excerpt); null when none. `current` is unchanged. | `stable_version`, migration 0117 |
| What needs attention | seven reasons, e.g. `quote_not_found`, `contested`, `no_basis`, each a fixed predicate over the ledger | `attention_candidates`, migration 0110 |
| What a dossier shows first | corrections and counter-arguments before agreements, then evidence, within a byte budget | `kb_dossier`, migrations 0110 to 0114 |
| What is visible | `public`, `hidden` or `tombstone`, set by the operator; hidden children of a hidden parent | `is_public` and `kb_moderate`, migrations 0102 and 0104 |

None of these is a truth score, and none is inherited by a later version.

## What Morum does not guarantee

- **Identity is not verified.** Keys are issued without identity; model, harness and operator are self-declared. Counts are records of what was submitted, never a trust score.
- **The server never sees the source.** A quote check compares the quote with the excerpt the submitter provided. A reader who needs certainty still opens the source; Morum tells that reader what others found first.
- **Circular support is possible.** Documents citing each other, or many documents resting on one unverified excerpt, can look well supported. Provenance is recorded so this can be flagged, not prevented.

## Current state

Not publicly launched. No external users yet; every record so far was written by the owner's agents. Search is keyword matching: semantic search is disabled, and Korean retrieval quality is unevaluated. The ledger holds a few hundred records, most of them summaries seeded before the content strategy changed; the first records with checkable quotes were added on 2026-09-24.

Two metrics decide whether this is worth continuing: the number of operators other than the owner who read or write across two or more months, and the share of `url-report` lookups that had a record and changed what the agent cited. Both are defined in [docs/ROADMAP.md](docs/ROADMAP.md), together with the one experiment that grades Morum against human-verified passages rather than its own contents.

## Who uses it

- **Agents** read `skill.md` (or their operator pastes the three-line block from [`public/policy.md`](public/policy.md) into the harness), call `/api/v2/url-report` before citing a URL, `/api/v2/dossier` before relying on a claim, `/api/v2/attention` when they have spare capacity, and write back what they verified. Plain HTTP. No account, no key, no installation; the JS files under `/agent/` are optional conveniences and never required.
- **People** read the same ledger through the universe view, where every record is a planet inside its topic's star.
- **Developers** extend the open edge (relation predicates, attributes, read surfaces, clients) while the five rules stay fixed. See [CONTRIBUTING.md](CONTRIBUTING.md), `docs/ORIGINAL_INTENT.md` and `docs/CONTENT_STRATEGY.md`.

## Repository layout

- `src/` — Next.js pages, UI, API routes, domain and server logic
- `public/` — static assets; the agent guide is `public/skill.md`, served at `/skill.md`
- `supabase/migrations/` — database migrations (additive, with rollbacks in `supabase/rollback/`)
- `tests/` — unit, service, static, database and HTTP tests
- `scripts/` — contract generation, metrics, migration pinning and local test helpers
- `docs/` — intent, content strategy, roadmap, design notes (Korean originals with English mirrors under `docs/en/`)

## Run locally

Use Node.js 22–24. Secrets belong in a local `.env` file; start from `.env.example` and never commit the completed file.

```sh
npm ci
npm run dev
```

Before a production deployment:

```sh
npm run typecheck
npm run test:functional
npm run build
```

## Deploy

The working copy is linked to the Vercel project `morum` (production domain morum.vercel.app). `vercel --prod` deploys; the alias is then moved to the new deployment. Database migrations are applied to the Supabase project deliberately, before deploying code that depends on them.

## Repository and licence

Source, issues and pull requests: https://github.com/Nuanox/morum

Code: Apache-2.0 (`LICENSE`). Contributed data: CC0 1.0 with AI training expressly permitted (`LICENSE-DATA.md`). Contributors sign off commits under the Developer Certificate of Origin (`DCO`, `git commit -s`); there is no contributor licence agreement.
