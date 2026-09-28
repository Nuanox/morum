#!/usr/bin/env node
// Roadmap 3.5: read-only metrics report computed from the PUBLIC API only (no keys, no database
// access, no writes). Walks GET /records, then GET /dossier?target_kind=version&target_id=<id> for
// each record's current version, and aggregates the five roadmap metrics from that JSON alone.
//
// Everything below `--- pure aggregation ---` is a pure function: it only reads plain objects shaped
// like the documented API responses (see src/contracts/types.ts: RecordSummary, Dossier, DeclaredAgent,
// QuoteCheck) and returns plain objects/numbers. tests/unit/metrics.test.mjs exercises these directly
// with fixtures, no network involved. Everything above that line (the HTTP walker and CLI) only runs
// when this file is executed as the main module.
//
//   node scripts/metrics.mjs [--origin https://morum.vercel.app] [--json] [--limit N]
//
// See docs/METRICS.md for what each metric means and which parts are approximations, and why.

import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const CONTRACT_VERSION = '2.1.0';
const DEFAULT_ORIGIN = 'https://morum.vercel.app';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ============================================================================================
// --- pure aggregation --- (no network, no fs; exported for tests/unit/metrics.test.mjs)
// ============================================================================================

/**
 * Nearest-rank min/p50/p90/max over a list of per-record counts. `count` is how many values went in.
 * Returns nulls when the input is empty so callers don't have to special-case "no data yet".
 */
export function quantiles(values) {
  const xs = (values ?? []).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return {count: 0, min: null, p50: null, p90: null, max: null};
  const rank = p => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))];
  return {count: xs.length, min: xs[0], p50: rank(50), p90: rank(90), max: xs[xs.length - 1]};
}

const HISTOGRAM_EDGES = [0, 1, 2, 4, 8, 16, 32, 64];
const HISTOGRAM_LABELS = ['0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];

/** Power-of-two-width count histogram: activity in an append-only knowledge base follows a power law
 *  (a handful of records draw most of the evidence/reviews), so a linear-width histogram is mostly
 *  empty buckets. Growing bucket widths keep every bucket meaningful. */
export function powerLawHistogram(values) {
  const counts = new Array(HISTOGRAM_LABELS.length).fill(0);
  for (const raw of values ?? []) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) continue;
    let idx = HISTOGRAM_LABELS.length - 1;
    for (let i = 0; i < HISTOGRAM_EDGES.length; i++) {
      const lo = HISTOGRAM_EDGES[i];
      const hi = i + 1 < HISTOGRAM_EDGES.length ? HISTOGRAM_EDGES[i + 1] - 1 : Infinity;
      if (v >= lo && v <= hi) { idx = i; break; }
    }
    counts[idx] += 1;
  }
  return HISTOGRAM_LABELS.map((range, i) => ({range, count: counts[i]}));
}

/** DeclaredAgent -> a stable string key, or null when nothing was declared. Self-reported, never verified. */
export function familyFromDeclared(declared) {
  if (!declared || typeof declared !== 'object') return null;
  const parts = [];
  if (declared.model) parts.push(`model=${declared.model}`);
  if (declared.harness) parts.push(`harness=${declared.harness}`);
  if (declared.operator) parts.push(`operator=${declared.operator}`);
  return parts.length ? parts.join(';') : null;
}

/** Coarsest identity available everywhere in the public API: a keyed actor id, or "anonymous". */
export function actorIdentityKey(createdBy) {
  return createdBy ? `keyed:${createdBy}` : 'anonymous';
}

/** Richest family key available for a review: declared model/harness/operator when present
 *  (only ever present on dossier.counterarguments.reviews), else keyed/anonymous. */
export function reviewerFamilyKey(review) {
  return familyFromDeclared(review?.declared) ?? actorIdentityKey(review?.created_by ?? null);
}

const DEFINITE_TEXT_STATES = new Set(['found_exact', 'found_normalized', 'found_fragments', 'not_found']);

/** knowledge.quote_check() checks quote-emptiness before text-emptiness (see the SQL migration), so
 *  "no_quote" alone never proves the source lacks submitted_text -- only "no_text" does. */
export function classifySourceTextSignal(state) {
  if (state === 'no_text') return 'no_text';
  if (DEFINITE_TEXT_STATES.has(state)) return 'has_text';
  return 'unknown'; // no_quote (quote empty, checked first) or not_applicable (not external evidence)
}

/** A dossier's arrays are capped server-side (evidence/corrections/premises/related <=10,
 *  counterarguments.reviews <=20, meanings <=30); `omitted.<key>` is exactly total-cap when the cap
 *  bound, 0 otherwise, so `visible.length + omitted.<key>` recovers the true total count even though
 *  the itemized detail (quote_check state, focus, stance, declared) is only available for the visible
 *  slice. See docs/METRICS.md for which per-metric numbers are exact totals vs capped-sample breakdowns. */
export function extractDossierCounts(dossier) {
  const o = dossier?.omitted ?? {};
  const evidence = dossier?.evidence ?? [];
  const corrections = dossier?.corrections ?? [];
  const reviews = dossier?.counterarguments?.reviews ?? [];
  const contradicts = dossier?.counterarguments?.contradicts ?? [];
  const related = dossier?.related ?? [];
  const premises = dossier?.premises ?? [];
  return {
    version_id: dossier?.version?.id ?? null,
    record_id: dossier?.version?.record_id ?? null,
    created_by: dossier?.version?.created_by ?? null,
    evidence_visible: evidence,
    evidence_total: evidence.length + (o.evidence ?? 0),
    corrections_visible: corrections,
    corrections_total: corrections.length + (o.corrections ?? 0),
    reviews_visible: reviews, // disagree/needs_review only; agree reviews are never itemized
    reviews_total: reviews.length + (o.counterarguments ?? 0),
    contradicts_total: contradicts.length + (o.contradicts ?? 0),
    agree_keyed: dossier?.agreements?.agree_keyed ?? 0,
    agree_anonymous: dossier?.agreements?.agree_anonymous ?? 0,
    related_total: related.length + (o.related ?? 0),
    premises_total: premises.length + (o.premises ?? 0),
  };
}

/** Roadmap metric 1: verification records. */
export function computeVerificationMetrics(dossiers) {
  const quoteCounts = {found_exact: 0, found_normalized: 0, found_fragments: 0, not_found: 0, no_text: 0, no_quote: 0, not_applicable: 0};
  const reviewCounts = {}; // "<stance>|<focus>" -> count; disagree/needs_review only (see reviews_total below)
  let agreeKeyedTotal = 0, agreeAnonymousTotal = 0;
  let recordsWithEvidenceCapped = 0, recordsWithReviewsCapped = 0;
  const sourceSignal = new Map(); // source_id -> 'has_text' | 'no_text' | 'unknown'
  const evidencePerRecord = [], correctionsPerRecord = [], reviewsPerRecord = [];

  for (const dossier of dossiers) {
    const c = extractDossierCounts(dossier);
    evidencePerRecord.push(c.evidence_total);
    correctionsPerRecord.push(c.corrections_total);
    reviewsPerRecord.push(c.reviews_total + c.agree_keyed + c.agree_anonymous);
    if ((dossier?.omitted?.evidence ?? 0) > 0) recordsWithEvidenceCapped += 1;
    if ((dossier?.omitted?.counterarguments ?? 0) > 0) recordsWithReviewsCapped += 1;

    for (const e of c.evidence_visible) {
      const state = e?.quote_check?.state;
      if (Object.hasOwn(quoteCounts, state)) quoteCounts[state] += 1;
      if (e?.basis?.kind === 'external' && e.basis.source_id) {
        const signal = classifySourceTextSignal(state);
        const previous = sourceSignal.get(e.basis.source_id);
        // A definite signal (has_text / no_text) always wins over a merely unknown one from another evidence item.
        if (signal !== 'unknown' || previous === undefined) sourceSignal.set(e.basis.source_id, signal);
      }
    }
    for (const r of c.reviews_visible) {
      const key = `${r.stance}|${r.focus}`;
      reviewCounts[key] = (reviewCounts[key] ?? 0) + 1;
    }
    agreeKeyedTotal += c.agree_keyed;
    agreeAnonymousTotal += c.agree_anonymous;
  }

  let sourcesHasText = 0, sourcesNoText = 0, sourcesUnknown = 0;
  for (const signal of sourceSignal.values()) {
    if (signal === 'has_text') sourcesHasText += 1;
    else if (signal === 'no_text') sourcesNoText += 1;
    else sourcesUnknown += 1;
  }

  return {
    evidence: {
      ...quoteCounts,
      found_verified_total: quoteCounts.found_exact + quoteCounts.found_normalized,
      visible_total: dossiers.reduce((n, d) => n + (d?.evidence?.length ?? 0), 0),
      true_total: evidencePerRecord.reduce((a, b) => a + b, 0),
      records_with_evidence_list_capped: recordsWithEvidenceCapped,
    },
    reviews: {
      // Exact for disagree/needs_review (itemized in the dossier); agree is a per-record aggregate
      // count only (kb_dossier never itemizes agree reviews), so it has no focus breakdown -- see docs/METRICS.md.
      by_stance_and_focus: reviewCounts,
      agree_keyed_total: agreeKeyedTotal,
      agree_anonymous_total: agreeAnonymousTotal,
      agree_focus_breakdown_available: false,
      records_with_review_list_capped: recordsWithReviewsCapped,
    },
    sources_by_submitted_text: {
      // Approximation: derived from evidence quote_check states, not a direct source listing (the
      // public API has no "list sources with/without text" endpoint). Distinct by source_id.
      distinct_sources_seen: sourceSignal.size,
      has_text_approx: sourcesHasText,
      no_text_approx: sourcesNoText,
      unknown_approx: sourcesUnknown,
    },
    distributions: {
      evidence_per_record: quantiles(evidencePerRecord),
      evidence_per_record_histogram: powerLawHistogram(evidencePerRecord),
      corrections_per_record: quantiles(correctionsPerRecord),
      corrections_per_record_histogram: powerLawHistogram(correctionsPerRecord),
      reviews_per_record: quantiles(reviewsPerRecord),
      reviews_per_record_histogram: powerLawHistogram(reviewsPerRecord),
    },
  };
}

/** Roadmap metric 2: per operator family -- corrections and disagree reviews, as counts and as a
 *  share of that family's contributions. See docs/METRICS.md for why corrections cannot be attributed
 *  to a family at all from the public API. */
export function computeFamilyMetrics(dossiers) {
  const reviewerStats = new Map(); // declared-or-keyed family -> {disagree, needs_review}
  const authorStats = new Map(); // actor-identity (keyed:<id> | anonymous) -> {records, corrected, disputed}
  let correctionsTotal = 0, disagreeReviewsTotal = 0, needsReviewReviewsTotal = 0;

  for (const dossier of dossiers) {
    const c = extractDossierCounts(dossier);
    correctionsTotal += c.corrections_total;

    const authorKey = actorIdentityKey(c.created_by);
    if (!authorStats.has(authorKey)) authorStats.set(authorKey, {records: 0, corrected: 0, disputed: 0});
    const author = authorStats.get(authorKey);
    author.records += 1;
    if (c.corrections_total > 0) author.corrected += 1;
    if (c.reviews_visible.some(r => r.stance === 'disagree')) author.disputed += 1;

    for (const r of c.reviews_visible) {
      const family = reviewerFamilyKey(r);
      if (!reviewerStats.has(family)) reviewerStats.set(family, {disagree: 0, needs_review: 0});
      const stats = reviewerStats.get(family);
      if (r.stance === 'disagree') { stats.disagree += 1; disagreeReviewsTotal += 1; }
      else if (r.stance === 'needs_review') { stats.needs_review += 1; needsReviewReviewsTotal += 1; }
    }
  }

  const reviewer_families = [...reviewerStats.entries()]
    .map(([family, s]) => ({
      family, disagree: s.disagree, needs_review: s.needs_review,
      disagree_share_of_family_reviews: (s.disagree + s.needs_review) > 0 ? s.disagree / (s.disagree + s.needs_review) : null,
    }))
    .sort((a, b) => (b.disagree + b.needs_review) - (a.disagree + a.needs_review));

  const author_identity_groups = [...authorStats.entries()]
    .map(([identity, s]) => ({
      identity, records: s.records,
      correction_rate: s.records > 0 ? s.corrected / s.records : null,
      disagree_review_rate: s.records > 0 ? s.disputed / s.records : null,
    }))
    .sort((a, b) => b.records - a.records);

  return {
    corrections_total: correctionsTotal,
    corrections_attribution_gap: 'dossier.corrections has no created_by or declared field in the public API (unlike counterarguments.reviews), so which family issued a correction is not computable from public data; only the correction RATE against each target author is (author_identity_groups.correction_rate).',
    disagree_reviews_total: disagreeReviewsTotal,
    needs_review_reviews_total: needsReviewReviewsTotal,
    reviewer_families, // who disagreed/needs-reviewed, grouped by declared family where declared, else keyed/anonymous
    author_identity_groups, // whose contributions got corrected/disputed, grouped by keyed-vs-anonymous only (declared is never exposed for authorship)
  };
}

/** Roadmap metric 3: cross-family reuse. "Family" here can only be actor identity (keyed:<id> vs
 *  anonymous), not a declared model family, because the public dossier never exposes `declared` for a
 *  version's author or for evidence -- only for disagree/needs_review reviews (see docs/METRICS.md). */
export function computeCrossFamilyReuse(dossiers) {
  const authorByVersion = new Map();
  for (const dossier of dossiers) {
    if (dossier?.version?.id) authorByVersion.set(dossier.version.id, actorIdentityKey(dossier.version.created_by));
  }

  let internalTotal = 0, internalCross = 0, internalSame = 0, internalUnresolvedVersion = 0, internalUnresolvedAnchor = 0;
  let reviewTotal = 0, reviewCross = 0, reviewSame = 0;

  for (const dossier of dossiers) {
    const citingFamily = actorIdentityKey(dossier?.version?.created_by ?? null);
    for (const e of dossier?.evidence ?? []) {
      if (e?.basis?.kind !== 'internal') continue;
      internalTotal += 1;
      const source = e.basis.source;
      if (!source) { internalUnresolvedVersion += 1; continue; }
      if (source.kind === 'version') {
        const targetFamily = authorByVersion.get(source.id);
        if (targetFamily === undefined) internalUnresolvedVersion += 1;
        else if (targetFamily !== citingFamily) internalCross += 1;
        else internalSame += 1;
      } else {
        // Anchor targets: resolving the anchor's owning version's author would need one extra
        // request per anchor, which this script does not make (it stays within ~1 request/record).
        internalUnresolvedAnchor += 1;
      }
    }
    for (const r of dossier?.counterarguments?.reviews ?? []) {
      reviewTotal += 1;
      const reviewerFamily = actorIdentityKey(r?.created_by ?? null);
      if (reviewerFamily !== citingFamily) reviewCross += 1;
      else reviewSame += 1;
    }
  }

  const resolvedInternal = internalCross + internalSame;
  return {
    internal_evidence: {
      total: internalTotal,
      cross_family: internalCross,
      same_family: internalSame,
      unresolved_target_outside_walked_set: internalUnresolvedVersion,
      unresolved_anchor_target: internalUnresolvedAnchor,
      cross_family_share_of_resolved: resolvedInternal > 0 ? internalCross / resolvedInternal : null,
    },
    disagree_and_needs_review_reviews: {
      total: reviewTotal,
      cross_family: reviewCross,
      same_family: reviewSame,
      cross_family_share: reviewTotal > 0 ? reviewCross / reviewTotal : null,
    },
    gap: 'Family = actor identity (keyed:<id> vs anonymous), not a declared model family: the public API never exposes a declared model/harness/operator for a version author, an evidence item, or a correction -- only for individual disagree/needs_review reviews. Internal evidence whose basis targets an anchor, or a version outside the walked /records set (an older/non-current version), cannot be resolved to an author with the requests this script makes (~1 request per record).',
  };
}

/** Roadmap metrics 4-5 input shape: see docs/METRICS.md "data/eval result shape". Pure: takes already
 *  parsed JSON documents, no fs access. */
export function summarizePassHatK(runs) {
  const byTask = new Map();
  for (const r of runs ?? []) {
    if (!r || typeof r.task_id !== 'string' || typeof r.passed !== 'boolean') continue;
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push(r.passed);
  }
  const per_task = [...byTask.entries()]
    .map(([task_id, results]) => ({
      task_id, attempts: results.length, passed: results.filter(Boolean).length,
      all_passed: results.length > 0 && results.every(Boolean),
    }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
  const evaluated = per_task.filter(t => t.attempts > 0);
  return {
    per_task,
    tasks_evaluated: evaluated.length,
    // pass^k (tau-bench sense): share of tasks for which EVERY recorded attempt passed, not "at least one".
    pass_hat_k_rate: evaluated.length > 0 ? evaluated.filter(t => t.all_passed).length / evaluated.length : null,
  };
}

export function summarizeInjectionRefusal(runs) {
  const probes = (runs ?? []).filter(r => r && typeof r.injection_refused === 'boolean');
  const refused = probes.filter(r => r.injection_refused === true).length;
  return {probes: probes.length, refused, refusal_rate: probes.length > 0 ? refused / probes.length : null};
}

/** Combines every parsed data/eval/*.json document (see loadEvalDocs) into pooled and per-provider metrics. */
export function computeEvalMetrics(evalDocs) {
  const docs = evalDocs ?? [];
  if (docs.length === 0) return null;
  const allRuns = docs.flatMap(doc => (doc?.runs ?? []).map(r => ({...r, provider: r?.provider ?? doc?.provider ?? null})));
  const overall = {pass_hat_k: summarizePassHatK(allRuns), injection_refusal: summarizeInjectionRefusal(allRuns)};
  const providers = [...new Set(allRuns.map(r => r.provider).filter(Boolean))].sort();
  const by_provider = providers.map(provider => {
    const runs = allRuns.filter(r => r.provider === provider);
    return {provider, pass_hat_k: summarizePassHatK(runs), injection_refusal: summarizeInjectionRefusal(runs)};
  });
  return {files: docs.length, overall, by_provider};
}

/** Assembles the full report from already-fetched dossiers (and already-parsed eval docs). Pure. */
export function buildReport({origin, records_scanned, requests_made, dossiers, evalDocs}) {
  const evalMetrics = computeEvalMetrics(evalDocs ?? []);
  return {
    computed_at: new Date().toISOString(),
    origin,
    records_scanned,
    requests_made,
    metric_1_verification_records: computeVerificationMetrics(dossiers),
    metric_2_operator_family: computeFamilyMetrics(dossiers),
    metric_3_cross_family_reuse: computeCrossFamilyReuse(dossiers),
    metric_4_task_pass_hat_k: evalMetrics ? evalMetrics.overall.pass_hat_k : 'n/a (no data/eval results yet)',
    metric_5_injection_refusal_rate: evalMetrics ? evalMetrics.overall.injection_refusal : 'n/a (no data/eval results yet)',
    metric_4_5_by_provider: evalMetrics ? evalMetrics.by_provider : [],
  };
}

const fmtPct = x => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const fmtNum = x => (x === null || x === undefined ? 'n/a' : String(x));
const rule = (title) => `\n${title}\n${'-'.repeat(title.length)}`;

/** Plain-text table rendering of buildReport()'s output. Pure (string in objects, string out). */
export function formatReport(report) {
  const lines = [];
  lines.push('MORUM METRICS (roadmap 3.5) -- read-only, public API only');
  lines.push(`origin: ${report.origin}    computed_at: ${report.computed_at}`);
  lines.push(`records_scanned: ${report.records_scanned}    requests_made: ${report.requests_made}`);

  const v = report.metric_1_verification_records;
  lines.push(rule('1. Verification records'));
  lines.push(`evidence quote_check: found_exact=${v.evidence.found_exact} found_normalized=${v.evidence.found_normalized} (verified total=${v.evidence.found_verified_total}) found_fragments=${v.evidence.found_fragments} not_found=${v.evidence.not_found} no_text=${v.evidence.no_text} no_quote=${v.evidence.no_quote} not_applicable=${v.evidence.not_applicable}`);
  lines.push(`evidence visible/true totals: ${v.evidence.visible_total}/${v.evidence.true_total} (capped in dossier for ${v.evidence.records_with_evidence_list_capped} record(s))`);
  const focusRows = Object.entries(v.reviews.by_stance_and_focus).sort();
  lines.push(`reviews by stance|focus (disagree/needs_review only, itemized): ${focusRows.length ? focusRows.map(([k, n]) => `${k}=${n}`).join(', ') : '(none)'}`);
  lines.push(`agree reviews: keyed=${v.reviews.agree_keyed_total} anonymous=${v.reviews.agree_anonymous_total} (no focus breakdown available)`);
  lines.push(`sources by submitted text (approx, by distinct source_id in evidence): has_text=${v.sources_by_submitted_text.has_text_approx} no_text=${v.sources_by_submitted_text.no_text_approx} unknown=${v.sources_by_submitted_text.unknown_approx} (distinct seen=${v.sources_by_submitted_text.distinct_sources_seen})`);
  for (const [label, key] of [['evidence/record', 'evidence_per_record'], ['corrections/record', 'corrections_per_record'], ['reviews/record', 'reviews_per_record']]) {
    const q = v.distributions[key], h = v.distributions[`${key}_histogram`];
    lines.push(`${label}: min=${fmtNum(q.min)} p50=${fmtNum(q.p50)} p90=${fmtNum(q.p90)} max=${fmtNum(q.max)} (n=${q.count})  histogram[${h.map(b => `${b.range}:${b.count}`).join(' ')}]`);
  }

  const f = report.metric_2_operator_family;
  lines.push(rule('2. Per operator family'));
  lines.push(`corrections_total=${f.corrections_total} (${f.corrections_attribution_gap})`);
  lines.push(`disagree_reviews_total=${f.disagree_reviews_total} needs_review_reviews_total=${f.needs_review_reviews_total}`);
  lines.push('reviewer family (declared model/harness/operator, else keyed/anonymous): disagree / needs_review / disagree share');
  for (const r of f.reviewer_families) lines.push(`  ${r.family}: ${r.disagree} / ${r.needs_review} / ${fmtPct(r.disagree_share_of_family_reviews)}`);
  if (f.reviewer_families.length === 0) lines.push('  (none)');
  lines.push('author identity (keyed:<id> vs anonymous only -- declared is never exposed for authorship): records / correction rate / disagree-review rate');
  for (const a of f.author_identity_groups) lines.push(`  ${a.identity}: ${a.records} / ${fmtPct(a.correction_rate)} / ${fmtPct(a.disagree_review_rate)}`);
  if (f.author_identity_groups.length === 0) lines.push('  (none)');

  const r3 = report.metric_3_cross_family_reuse;
  lines.push(rule('3. Cross-family reuse'));
  lines.push(`internal evidence: total=${r3.internal_evidence.total} cross_family=${r3.internal_evidence.cross_family} same_family=${r3.internal_evidence.same_family} unresolved(version)=${r3.internal_evidence.unresolved_target_outside_walked_set} unresolved(anchor)=${r3.internal_evidence.unresolved_anchor_target} cross_share_of_resolved=${fmtPct(r3.internal_evidence.cross_family_share_of_resolved)}`);
  lines.push(`reviews (disagree/needs_review): total=${r3.disagree_and_needs_review_reviews.total} cross_family=${r3.disagree_and_needs_review_reviews.cross_family} same_family=${r3.disagree_and_needs_review_reviews.same_family} cross_share=${fmtPct(r3.disagree_and_needs_review_reviews.cross_family_share)}`);
  lines.push(`gap: ${r3.gap}`);

  lines.push(rule('4. Task pass^k'));
  if (typeof report.metric_4_task_pass_hat_k === 'string') lines.push(report.metric_4_task_pass_hat_k);
  else lines.push(`tasks_evaluated=${report.metric_4_task_pass_hat_k.tasks_evaluated} pass_hat_k_rate=${fmtPct(report.metric_4_task_pass_hat_k.pass_hat_k_rate)}`);

  lines.push(rule('5. Injection refusal rate (T8)'));
  if (typeof report.metric_5_injection_refusal_rate === 'string') lines.push(report.metric_5_injection_refusal_rate);
  else lines.push(`probes=${report.metric_5_injection_refusal_rate.probes} refused=${report.metric_5_injection_refusal_rate.refused} refusal_rate=${fmtPct(report.metric_5_injection_refusal_rate.refusal_rate)}`);

  if (report.metric_4_5_by_provider?.length) {
    lines.push(rule('4/5 by provider'));
    for (const p of report.metric_4_5_by_provider) {
      lines.push(`  ${p.provider}: pass_hat_k=${fmtPct(p.pass_hat_k.pass_hat_k_rate)} (${p.pass_hat_k.tasks_evaluated} tasks)  injection_refusal=${fmtPct(p.injection_refusal.refusal_rate)} (${p.injection_refusal.probes} probes)`);
    }
  }

  return lines.join('\n');
}

// ============================================================================================
// --- network walker + CLI --- (only runs when this file is executed as main)
// ============================================================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  let origin = process.env.MORUM_BASE || DEFAULT_ORIGIN;
  let json = false;
  let limit = Infinity;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--origin') origin = argv[++i];
    else if (arg.startsWith('--origin=')) origin = arg.slice('--origin='.length);
    else if (arg === '--json') json = true;
    else if (arg === '--limit') limit = Number(argv[++i]);
    else if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/metrics.mjs [--origin https://morum.vercel.app] [--json] [--limit N]');
      process.exit(0);
    }
  }
  origin = origin.replace(/\/+$/, '');
  if (!Number.isFinite(limit) || limit <= 0) limit = Infinity;
  return {origin, json, limit};
}

/** GET only; never sends a body. Sends Authorization only when `authToken` is given (the
 *  operator-only lookup-metrics call below); every other call in this script stays keyless.
 *  Honors 429 Retry-After. */
async function apiGet(origin, path, state, authToken) {
  const url = `${origin}/api/v2${path}`;
  for (let attempt = 0; ; attempt += 1) {
    state.requests_made += 1;
    let response;
    try {
      const headers = {accept: 'application/json', 'x-contract-version': CONTRACT_VERSION};
      if (authToken) headers.authorization = `Bearer ${authToken}`;
      response = await fetch(url, {headers, signal: AbortSignal.timeout(20000)});
    } catch (error) {
      if (attempt >= 5) throw new Error(`transport failed for ${path}: ${error.message}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (response.status === 429) {
      if (attempt >= 8) throw new Error(`rate limited repeatedly on ${path}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5) + 1) * 1000);
      continue;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !Object.hasOwn(payload, 'data')) {
      throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(payload?.error ?? payload).slice(0, 500)}`);
    }
    return payload.data;
  }
}

/** Paces GET requests so 145 records + 145 dossiers stays comfortably under the documented
 *  120 reads/min per client, in addition to honoring 429 Retry-After on top. */
async function pacedGet(origin, path, state) {
  const waitMs = state.paceMs - (Date.now() - state.lastRequestAt);
  if (waitMs > 0) await sleep(waitMs);
  state.lastRequestAt = Date.now();
  return apiGet(origin, path, state);
}

async function walkRecords(origin, limit, state) {
  const items = [];
  let cursor = null;
  while (items.length < limit) {
    const qs = new URLSearchParams({limit: '50', ...(cursor ? {cursor} : {})});
    const page = await pacedGet(origin, `/records?${qs}`, state);
    for (const item of page.items ?? []) {
      items.push(item);
      if (items.length >= limit) break;
    }
    cursor = page.page?.next_cursor ?? null;
    if (!cursor) break;
  }
  return items;
}

async function fetchDossiers(origin, records, state, onProgress) {
  const dossiers = [];
  for (const record of records) {
    const versionId = record?.current?.id;
    if (!versionId) continue;
    const qs = new URLSearchParams({target_kind: 'version', target_id: versionId});
    dossiers.push(await pacedGet(origin, `/dossier?${qs}`, state));
    onProgress?.(dossiers.length, records.length);
  }
  return dossiers;
}

async function loadEvalDocs(dir) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const files = names.filter(n => n.endsWith('.json')).sort();
  const docs = [];
  for (const name of files) {
    try { docs.push(JSON.parse(await readFile(join(dir, name), 'utf8'))); }
    catch (error) { console.error(`skipping data/eval/${name}: ${error.message}`); }
  }
  return docs;
}

/** Roadmap 2.11 (extended): operator-only adoption metrics over the lookup log (see
 *  docs/METRICS.md "Lookup log metrics" and docs/OPERATIONS.md "Lookup log"). Only called
 *  when MORUM_OPERATOR_KEY is set in the environment; the key itself is read, sent as a bearer
 *  credential, and never printed or logged. Returns null (never throws) on any failure, so a bad
 *  or revoked key degrades this one section instead of failing the whole report. */
async function fetchLookupMetrics(origin, state, operatorKey) {
  if (!operatorKey) return {skipped: 'operator key not set: lookup metrics skipped'};
  try {
    return await apiGet(origin, '/admin/metrics/lookups?days=30', state, operatorKey);
  } catch (error) {
    return {skipped: `lookup metrics request failed: ${error.message}`};
  }
}

/** Pure rendering of fetchLookupMetrics's result; used by both text and JSON output. */
export function formatLookupMetrics(m) {
  if (!m || m.skipped) return m?.skipped ?? 'operator key not set: lookup metrics skipped';
  const lines = [`window_days=${m.window_days} lookups=${m.lookups} hits=${m.hits} hit_rate=${fmtPct(m.hit_rate)} write_backs=${m.write_backs} write_back_rate=${fmtPct(m.write_back_rate)}`];
  lines.push(`distinct_operators=${m.distinct_operators} distinct_agent_keys=${m.distinct_agent_keys}`);
  for (const o of m.operators ?? []) lines.push(`  ${o.operator}: lookups=${o.lookups} hits=${o.hits} hit_rate=${fmtPct(o.hit_rate)} checks=${o.checks} write_backs=${o.write_backs} write_back_rate=${fmtPct(o.write_back_rate)}`);
  return lines.join('\n');
}

async function main() {
  const {origin, json, limit} = parseArgs(process.argv.slice(2));
  const state = {requests_made: 0, lastRequestAt: 0, paceMs: 550}; // ~109 req/min, under the 120/min read limit
  const log = (...args) => process.stderr.write(`${args.join(' ')}\n`);

  log(`morum metrics: ${origin}  limit=${limit === Infinity ? 'none' : limit}`);
  const records = await walkRecords(origin, limit, state);
  log(`records: ${records.length}. fetching dossiers...`);
  const dossiers = await fetchDossiers(origin, records, state, (done, total) => {
    if (done % 10 === 0 || done === total) log(`  dossier ${done}/${total}`);
  });
  const evalDocs = await loadEvalDocs(join(ROOT, 'data', 'eval'));
  const lookupMetrics = await fetchLookupMetrics(origin, state, process.env.MORUM_OPERATOR_KEY);

  const report = buildReport({origin, records_scanned: records.length, requests_made: state.requests_made, dossiers, evalDocs});
  report.lookup_metrics = lookupMetrics;
  if (!json) {
    process.stdout.write(formatReport(report) + '\n' + rule('Lookup log metrics (operator-only, roadmap 2.11)') + '\n' + formatLookupMetrics(lookupMetrics) + '\n');
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
