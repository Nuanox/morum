# Morum Category Archive Design

> Korean original: [docs/ARCHIVE_DESIGN.md](../ARCHIVE_DESIGN.md). Translation of the 2026-09-23 revision; the Korean file is authoritative when they differ.

Written 2026-09-23. Status: adopted, Phase 0 in progress. Phase 1 onward, each phase applies only after approval.

## 1. Goal and Settled Decisions

The current three-level galaxy explorer is good, but it feels like a website and doesn't grow. The goal is not to hold many documents but to raise **the share of frequently cited URLs that have a check record when asked**. Scale comes from the number of URLs for which url-report does not come back empty, not from the amount of text stored. The category archive is the screen where people browse those records, not a storage goal. (Revised 2026-09-28; the earlier sentence was an archive that feels like "the entire internet is stored right here".)

What the user settled on 2026-09-23:

1. **A category is an independent object** and the categories form a hierarchy. One document can belong to several categories, and one category can have several parents (a DAG). Aliases merge differences in notation and language.
2. **The top level is free.** There is no fixed root (KDC, Wikipedia categories). A category with no parent is itself a root.
3. **What's held is knowledge records + web sources.** Agents submit the URL they checked, the quote, and its surrounding context (excerpt cap 8,000 code points). Whole pages are not stored. The server does not fetch the web.
4. **Exploration is one continuous universe.** With no far/mid/near split, continuous zoom alone branches field → sub-field → ... → document. Only the visible region is fetched from the server.

Principles kept: the original text and versions are immutable; classification is only what a contributor **declares** (never inferred from embedding or on-screen proximity); minimal labels; no new runtime dependency, no WebGL added; migrations are additive-only; the `nuanox_` prefix and HMAC strings are immutable.

## 2. Starting Point from the Current State

- Data: 43 records in production, `attributes.topic` as a free-text string across 8 values (one flat layer).
- The home page fetches up to the 200 most recent records into the browser and groups them by topic. Past 200, older records disappear from the universe.
- `knowledge.sources` already has `url`, `title`, `submitted_text` (100,000 chars), `published_at`, `retrieved_at`, `rights_note`, and `attributes`. Web source archiving **extends this table, with no new table**.
- As of 2026-09-23, functions run in `icn1` (Seoul). `/records` takes 0.18-0.54s, `/search` takes 0.65-0.73s.

## 3. Data Model (one additive migration: `202609240101_categories.sql`)

Every new table has the same header as existing objects (`id`, `created_by`, `created_at`, `visibility`) and rows are never edited. To change something, supersede it with a new declaration, or have an operator hide it.

```sql
CREATE TABLE knowledge.categories (
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 explanation text CHECK(explanation IS NULL OR pg_catalog.length(pg_catalog.btrim(explanation)) BETWEEN 1 AND 2000),
 merged_into uuid REFERENCES knowledge.categories(id) ON DELETE RESTRICT,   -- filled only by an operator merge
 attributes jsonb NOT NULL DEFAULT '{}' CHECK(pg_catalog.jsonb_typeof(attributes)='object')
);

CREATE TABLE knowledge.category_labels (          -- display name and aliases. The first label is the canonical name
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 category_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 label text NOT NULL CHECK(pg_catalog.length(pg_catalog.btrim(label)) BETWEEN 1 AND 120),
 lang text CHECK(lang IS NULL OR lang ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
 norm_label text NOT NULL,                         -- lower(NFKC(trim)), filled by a trigger
 UNIQUE(category_id,norm_label)
);

CREATE TABLE knowledge.category_links (           -- DAG edge: parent ⊃ child
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 parent_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 child_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 explanation text NOT NULL CHECK(pg_catalog.length(pg_catalog.btrim(explanation)) BETWEEN 1 AND 2000),
 CHECK(parent_id<>child_id),
 UNIQUE(parent_id,child_id)
);

CREATE TABLE knowledge.classifications (          -- the declaration "this record/source belongs to this category"
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','hidden','tombstone')),
 category_id uuid NOT NULL REFERENCES knowledge.categories(id) ON DELETE RESTRICT,
 record_id uuid REFERENCES knowledge.records(id) ON DELETE RESTRICT,
 source_id uuid REFERENCES knowledge.sources(id) ON DELETE RESTRICT,
 CHECK(pg_catalog.num_nonnulls(record_id,source_id)=1),
 explanation text CHECK(explanation IS NULL OR pg_catalog.length(pg_catalog.btrim(explanation)) BETWEEN 1 AND 2000),
 withdraws_classification_id uuid REFERENCES knowledge.classifications(id) ON DELETE RESTRICT
);

CREATE TABLE knowledge.category_stats (           -- derived values. Can be recomputed at any time
 category_id uuid PRIMARY KEY REFERENCES knowledge.categories(id) ON DELETE CASCADE,
 direct_count integer NOT NULL, child_count integer NOT NULL,
 mass double precision NOT NULL,                   -- see "mass" below
 primary_parent_id uuid REFERENCES knowledge.categories(id),
 layout_seed integer NOT NULL,
 refreshed_at timestamptz NOT NULL
);
```

Decisions and reasons:

- **What gets classified is the record and the source, not the version.** What's visible in the universe is a record's current version, and if issuing a new version forced re-classification every time, classification would disappear.
- **Withdrawing a classification is a new row** (`withdraws_classification_id`), the same approach as the annotation's `supersedes_annotation_id`. The original declaration stays.
- **Cycle prevention**: the `category_links` INSERT trigger searches upward recursively from the child, and rejects with `CATEGORY_CYCLE` if it hits the parent. Depth cap 64.
- **Only an operator can merge**, by filling `merged_into` (a `merge_category` action added to the existing `kb_moderate`). Read functions follow the merge chain with `knowledge.category_canonical(id)`. When a contributor proposes a merge, they leave a review with the same meaning as the existing `same_meaning_as` relation predicate.
- **Mass** = a value used for size calculation. One document's mass of 1 is divided by the number of categories it belongs to, and a category's mass is divided by its number of parent categories as it's passed up. Because total mass still equals the document count even with multiple memberships, **there's no double counting**. Used only for screen size (radius ∝ √mass); for claims like "N documents," only `direct_count` is used.
- **Primary parent**: among several parents, the first public edge connected. In the universe, a category lives inside its primary parent. Inside other parents, it gets only a small echo marker (Section 5).
- **Free top level + anti-fragmentation**: instead of a forced root, (1) look before you create — `GET /categories/lookup` and the skill.md guidance, (2) if a public category with the same `norm_label` already exists, don't create a new one — return a 409 `CATEGORY_EXISTS` with the existing id instead (only when the parent is the same; the same name with a different meaning is allowed under a different parent), (3) operator merging.

Indexes: `category_links(parent_id)`, `category_links(child_id)`, `category_labels(norm_label text_pattern_ops)`, `classifications(category_id, created_at DESC, id)`, `classifications(record_id)`, `classifications(source_id)`, `category_stats(primary_parent_id, mass DESC)`.

**Web-source archiving extension** (same migration, column additions only):

```sql
ALTER TABLE knowledge.sources
 ADD COLUMN canonical_url text,            -- lowercase scheme/host, default port/fragment/tracking params stripped (server-computed)
 ADD COLUMN content_sha256 text CHECK(content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
CREATE INDEX source_canonical_url ON knowledge.sources(canonical_url, retrieved_at DESC) WHERE canonical_url IS NOT NULL;
```

Resubmitting the same URL at a different point in time **is not overwritten — it stacks up as one more snapshot**. The same shape as the Internet Archive's "snapshots of this page over time." Resubmitting the same URL with the same content hash returns the existing id (duplicate prevention).

**Migrating the existing topic field**: no data goes into the migration itself. The operator runs `scripts/migrate-topics.mjs`, which creates a category per topic string (linking different spellings via aliases) and classifies the records. Run with the operator key, so every declaration retains an author.

## 4. API 2.2.0

Contract version 2.1.0 → 2.2.0 (additive only, existing responses unchanged). `public/agent/api-routes.json`, the `ROUTES`-count test (33 → 42), and skill.md all get updated.

| Method | Path | Description |
|---|---|---|
| GET | `/universe?at=<id>\|root&depth=1..2&limit=..` | **The core of the exploration screen.** In one round trip: the target category's children (top K by mass, default 48), and grandchildren too if selected, each node's `{id,label,mass,direct_count,child_count,layout_seed,also_in}` |
| GET | `/categories/lookup?q=&limit=` | Label prefix/exact-match search. Look before you create |
| GET | `/categories/:id` | Labels/aliases, parent list, stats, merge target |
| GET | `/categories/:id/items?kind=record\|source&limit&cursor` | Items directly classified under this category (current-version summary, source summary) |
| GET | `/records/:id/categories` | Categories a record belongs to, and each category's primary path (for jump-to-here after a search) |
| POST | `/categories` | `{label, lang?, parent_ids[0..5], explanation?}` — 409 + existing id if the same name already exists under the same parent |
| POST | `/category-links` | `{parent_id, child_id, explanation}` — 409 if it would create a cycle |
| POST | `/category-labels` | `{category_id, label, lang?}` add an alias |
| POST | `/classifications` | `{target:{kind:'record'\|'source',id}, category_id, explanation?}` or `{withdraws_classification_id, explanation}` |

- Writing classifications/labels/links stays anonymous-allowed as before (30/minute write bucket, per visitor). **Creating a category (`POST /categories`) is limited to keyed agents and operators** (2026-09-23 decision). Keyed agents also get a separate bucket (60/hour) to slow fragmentation.
- Read responses get `Cache-Control: public, s-maxage=60, stale-while-revalidate=600`. Hiding something is reflected within a minute even so. The rest of the existing routes stay `no-store` as before.
- `POST /sources` has the server compute and store `canonical_url` and `content_sha256`, and returns the existing source on a duplicate. `GET /sources?url=` lists one URL's snapshots.
- Guidance to put in skill.md: when contributing, (1) use `lookup` to find an existing category first, (2) only create one under the closest existing parent if none exists, (3) classify each record into 1-3 categories, (4) when archiving something fetched from the web, use `POST /sources` to store the original text together with `retrieved_at`, then classify it.

## 5. Continuous-Universe UI

**Coordinates**: the root universe is a circle of radius R₀. Each category is placed as a circle of radius r = k·√mass inside its primary parent's circle. Children are placed by deterministic circle packing (front-chain packing) in descending mass order, with the starting angle given by `layout_seed`. Same data always means the same position. Even as new categories appear, the big siblings' positions barely move (since packing fills from the front in mass order).

**Multiple membership**: a category has substance only inside its primary parent. Inside other parents, it gets only a small point of light (an echo), and clicking it flies to the real position. No lines are drawn (the no-lines-in-space principle).

**Zoom levels (LOD)** — based on on-screen radius ρ:

| ρ | What's visible |
|---|---|
| < 24px | a single point (brightness ∝ mass) |
| 24-160px | a particle nebula (particle count ∝ log mass, max 400), no label |
| > 160px | fetches `/universe?at=id`, and the child circles branch out inside it. Labels only on hover/focus |
| > 600px and has direct items | the first page of `/categories/:id/items`. Documents and sources become stars. Records and sources are distinguished only by shape (circle/diamond) |

Zoom is continuous, and level transitions fade in and out gradually (200ms, instant if reduced-motion).

**Drawing split**: particles and distant points are one Canvas 2D layer (drawing only, no interaction). What's interactive is a DOM button (category or document) for up to 150 items near the screen. Screen readers and keyboard navigation only see the DOM. Arrow keys = same-layer neighbor, Enter = go in, Esc = up one layer, `/` = search.

**Data fetching**: per-category results are cached in memory (LRU, 500 entries). When zooming stops (120ms), only categories on screen with ρ > 160px that aren't in the cache are requested. At most 4 concurrent requests, with categories under the cursor prefetched. Since only the visible region is fetched, one screen's worth of requests stays small even with millions of documents.

**Input**: the camera currently in `spatial-explorer.tsx` (translate3d on a single world layer), drag inertia, IME handling, and click suppression get split out into `camera.ts` for reuse. Continuous zoom (wheel zooms around the cursor, trackpad pinch, two-finger on mobile) is added on top.

**Opening a document**: the current `ReaderStage` (satellites: history/evidence/relations/reviews) is used as-is, as an overlay on top of the universe. Closing it returns to place.

**Search**: the search pill stays as-is. Picking a result fetches the primary path via `/records/:id/categories` and flies along that path from the root. A record with no classification goes to an "uncategorized" nebula.

**URL**: `/?c=<category_id>&z=<zoom>` + `&doc=<version_id>` when a document is open. Back navigation restores via pushState, as now.

**A small archive**: it's not filled with fake data. Even at 43 items, the structure shows through mass-based sizing and nebula particles. The faint background starlight is decorative, unclickable, and doesn't represent a count (distinguished from data particles by color and size).

**File layout**:

```
src/components/universe/
  universe.tsx          top-level component, URL sync, search/reader wiring
  camera.ts             camera/input/inertia split out of spatial-explorer + continuous zoom
  layout.ts             circle packing, coordinate calculation (pure functions, unit tested)
  lod.ts                ρ calculation, level decisions, which categories to fetch (pure functions)
  starfield.ts           Canvas 2D particle drawing
  nodes.tsx             DOM interaction nodes and keyboard movement
src/lib/universe-data.ts  /universe, /categories calls and caching
```

## 6. Phased Execution Plan

Each phase is one session's worth of work. Implementation is handed to a Haiku/Sonnet agent with instructions specifying file scope and how to verify, while the conductor handles diff review and testing.

| Phase | Content | Approval | Rollback |
|---|---|---|---|
| **0** | Split out `camera.ts` (behavior unchanged), `layout.ts`/`lod.ts` as pure functions + unit tests, build `universe-data.ts` first as an **adapter that mimics using the current data (topic)** so the universe UI can be developed on top of the current API | None | git revert |
| **1** | Migration `202609240101_categories.sql` (tables, triggers, read RPC, stats-refresh function), local DB tests (`tests/db`) | **Apply migration** | Only adds new objects, so a `DROP` script is authored alongside it |
| **2** | Write RPCs and API 2.2.0, `api-routes.json`, service tests, skill.md guidance, `migrate-topics.mjs` | **skill.md + deploy** | Roll back to the previous deploy (data stays) |
| **3** | Switch the universe UI over to `/universe`, replace the home page, search fly-to, reader overlay | Deploy | One line to revert the home page to `SpatialExplorer` |
| **4** | Web-source archiving: `canonical_url`/`content_sha256`, snapshot list, source classification, showing sources in the universe | Deploy | Columns are harmless even if left in place |
| **5** | Scale readiness: periodic stats refresh (pg_cron, 5 minutes), SQL performance fixes found in audit (`is_public` recursion, indexes, snapshot cleanup) | **Migration** | Replace the function with its prior definition |

## 7. Risks and Open Questions

Risks:

- **Fragmentation**: since the top level is free, several similar roots can appear early on. Look-before-create, a 409 for the same name, and operator merging reduce this, but regular operator cleanup is still needed.
- **Spam categories**: creation is limited to keyed agents, countered with a per-hour limit + hiding.
- **Stats lag**: mass is refreshed periodically, so a new classification takes up to 5 minutes to show up in size. Item lists reflect immediately.
- **Performance**: before the Phase 5 SQL fixes, a single universe zoom can show 200-500ms of lag.

Owner decisions:

Decided (2026-09-23): anonymous category creation is not allowed (keyed agents/operators only), background decorative starlight is used, Phase 0 starts.
