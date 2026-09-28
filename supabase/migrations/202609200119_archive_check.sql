-- Stage15 / archive check. A background job (scripts/archive-check.mjs)
-- fetches ONLY from web.archive.org and compares a quote against the
-- archived page text with the same rule as knowledge.quote_check. The
-- server itself never fetches a URL: this migration only stores the
-- job's result and exposes it on kb_url_report/kb_dossier. Results are
-- three-way (found / not found in snapshot / no snapshot), never a
-- verdict -- rule 3 (does the source say it / is it adequate / is it
-- true) is unaffected: this only ever answers a variant of question 1,
-- against a third-party copy instead of the agent's own submission.
--
-- Additive only: no table/column drop, no data change, no UPDATE of
-- existing rows. Contract stays 2.1.0.
--  1. knowledge.archive_checks is a new, append-only table (several rows
--     per evidence allowed; the newest wins). RLS enabled, no grants to
--     anon/authenticated/service_role -- reached only through the two
--     functions below and public.kb_record_archive_check.
--  2. knowledge.evidence_archive_check(evidence) is a new function,
--     mirroring knowledge.evidence_quote_check's shape.
--  3. public.kb_url_report (defined 202609200110, last re-created
--     202609200117; this is its latest definition) is re-created verbatim
--     except adding 'archive_check' to each citation and 'archive_states'
--     counts, next to the existing 'quote_check'/'quote_states' fields.
--  4. public.kb_archive_checks_pending(p_actor jsonb,p_query jsonb) is a new
--     operator-only read RPC listing external evidence due for a check.
--  5. public.kb_record_archive_check(p_actor jsonb,p_query jsonb) is a new
--     write RPC, operator-only, following the same two-argument shape as
--     the other operator write RPCs (kb_moderate, kb_suspend_agent):
--     p_actor is the operator's identity envelope, p_query the archive
--     check payload.
--  6. kb_health re-created with tag stage15-archive-check.
-- kb_dossier's own re-creation (adding 'archive_check' to each evidence
-- item) ships separately as 202609200120, generated from
-- supabase/functions/kb_dossier.sql via scripts/new-function-migration.mjs
-- per CONTRIBUTING.md's "Changing a database function".
-- Rollback: supabase/rollback/202609200119_archive_check_down.sql
BEGIN;

-- === knowledge.archive_checks =============================================
CREATE TABLE knowledge.archive_checks (
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 created_by uuid NOT NULL REFERENCES knowledge.actors(id) ON DELETE RESTRICT,
 evidence_id uuid NOT NULL REFERENCES knowledge.evidence(id) ON DELETE RESTRICT,
 state text NOT NULL CHECK (state IN ('found_exact','found_normalized','found_fragments','not_found','no_snapshot','fetch_failed')),
 archive_url text CHECK (archive_url IS NULL OR archive_url ~ '^https://web\.archive\.org/web/'),
 snapshot_at timestamptz,
 text_sha256 text CHECK (text_sha256 IS NULL OR text_sha256 ~ '^[0-9a-f]{64}$'),
 text_length integer CHECK (text_length IS NULL OR text_length>=0),
 rule_version text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(rule_version))>0),
 detail text CHECK (detail IS NULL OR pg_catalog.length(detail)<=500)
);
CREATE INDEX archive_checks_evidence_idx ON knowledge.archive_checks (evidence_id, created_at DESC);
ALTER TABLE knowledge.archive_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge.archive_checks FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER archive_checks_immutable BEFORE UPDATE OR DELETE ON knowledge.archive_checks
 FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();

CREATE FUNCTION knowledge.evidence_archive_check(e knowledge.evidence) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('state',ac.state,'archive_url',ac.archive_url,'snapshot_at',knowledge.utc(ac.snapshot_at),
   'checked_at',knowledge.utc(ac.created_at),'rule_version',ac.rule_version)
 FROM knowledge.archive_checks ac WHERE ac.evidence_id=e.id ORDER BY ac.created_at DESC LIMIT 1
$$;

-- === public.kb_url_report (copy of 202609200117's body; adds
-- archive_check per citation and archive_states counts) ==================
CREATE OR REPLACE FUNCTION public.kb_url_report(p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u text;canon text;scount integer;ccount integer;corrcount integer;sources jsonb;citations jsonb;corrections jsonb;qstates jsonb;astates jsonb;BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(2081801,1);
 PERFORM knowledge.jobject(p_query,ARRAY['url'],ARRAY['url']);
 u=knowledge.jtext(p_query->'url',2048);
 PERFORM knowledge.require(u ~* '^https?://[^[:space:]]+$','VALIDATION_FAILED');
 canon=knowledge.canonical_url(u);
 PERFORM knowledge.require(canon IS NOT NULL,'VALIDATION_FAILED');

 SELECT count(*) INTO scount FROM knowledge.sources s WHERE knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon;
 SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY ca DESC,sid),'[]'::jsonb) INTO sources FROM (
  SELECT pg_catalog.jsonb_build_object('id',s.id,'url',s.url,'title',s.title,'published_at',knowledge.utc(s.published_at),'retrieved_at',knowledge.utc(s.retrieved_at),
    'has_text',coalesce(pg_catalog.length(knowledge.trim_text(s.submitted_text))>0,false),'created_by',s.created_by,'created_at',knowledge.utc(s.created_at),
    'review_summary',knowledge.review_summary('source',s.id)) x,s.created_at ca,s.id sid
  FROM knowledge.sources s WHERE knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon
  ORDER BY s.created_at DESC,s.id LIMIT 20
 ) t;

 SELECT count(*) INTO ccount FROM knowledge.evidence e WHERE e.kind='external' AND knowledge.is_public('evidence',e.id)
  AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon);

 SELECT coalesce(pg_catalog.jsonb_object_agg(state,cnt),'{}'::jsonb) INTO qstates FROM (
  SELECT knowledge.evidence_quote_check(e)->>'state' state,count(*) cnt
  FROM knowledge.evidence e WHERE e.kind='external' AND knowledge.is_public('evidence',e.id)
   AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon)
  GROUP BY 1
 ) g;
 qstates=pg_catalog.jsonb_build_object('found_exact',coalesce((qstates->>'found_exact')::integer,0),'found_normalized',coalesce((qstates->>'found_normalized')::integer,0),
  'found_fragments',coalesce((qstates->>'found_fragments')::integer,0),'not_found',coalesce((qstates->>'not_found')::integer,0),
  'no_text',coalesce((qstates->>'no_text')::integer,0),'no_quote',coalesce((qstates->>'no_quote')::integer,0));

 SELECT coalesce(pg_catalog.jsonb_object_agg(state,cnt),'{}'::jsonb) INTO astates FROM (
  SELECT coalesce(knowledge.evidence_archive_check(e)->>'state','unchecked') state,count(*) cnt
  FROM knowledge.evidence e WHERE e.kind='external' AND knowledge.is_public('evidence',e.id)
   AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon)
  GROUP BY 1
 ) g;
 astates=pg_catalog.jsonb_build_object(
  'found',coalesce((astates->>'found_exact')::integer,0)+coalesce((astates->>'found_normalized')::integer,0)+coalesce((astates->>'found_fragments')::integer,0),
  'not_found',coalesce((astates->>'not_found')::integer,0),
  'no_snapshot',coalesce((astates->>'no_snapshot')::integer,0)+coalesce((astates->>'fetch_failed')::integer,0),
  'unchecked',coalesce((astates->>'unchecked')::integer,0));

 SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY ca DESC),'[]'::jsonb) INTO citations FROM (
  SELECT pg_catalog.jsonb_build_object('evidence_id',e.id,'source_id',e.source_id,'target',knowledge.row_ref(pg_catalog.to_jsonb(e),'target'),
    'record_id',v.record_id,'version_id',v.id,'title',v.title,
    'is_current',CASE WHEN v.id IS NULL THEN NULL ELSE v.id=knowledge.current_version(v.record_id) END,
    'is_stable',CASE WHEN v.id IS NULL THEN NULL ELSE coalesce(v.id=knowledge.stable_version(v.record_id),false) END,
    'stable_version_id',CASE WHEN v.id IS NULL THEN NULL ELSE knowledge.stable_version(v.record_id) END,
    'quote',e.quote,'explanation',e.explanation,'quote_check',knowledge.evidence_quote_check(e),
    'archive_check',knowledge.evidence_archive_check(e),'created_at',knowledge.utc(e.created_at)) x,e.created_at ca
  FROM knowledge.evidence e
  LEFT JOIN knowledge.versions v ON v.id=CASE WHEN e.target_version_id IS NOT NULL THEN e.target_version_id WHEN e.target_anchor_id IS NOT NULL THEN (SELECT a.version_id FROM knowledge.anchors a WHERE a.id=e.target_anchor_id) ELSE NULL END
  WHERE e.kind='external' AND knowledge.is_public('evidence',e.id)
   AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon)
  ORDER BY e.created_at DESC LIMIT 50
 ) t;

 SELECT count(*) INTO corrcount FROM knowledge.relations r WHERE r.predicate='corrects' AND knowledge.is_public('relation',r.id) AND (
   r.to_version_id IN (SELECT CASE WHEN e2.target_version_id IS NOT NULL THEN e2.target_version_id WHEN e2.target_anchor_id IS NOT NULL THEN (SELECT a.version_id FROM knowledge.anchors a WHERE a.id=e2.target_anchor_id) ELSE NULL END
     FROM knowledge.evidence e2 WHERE e2.kind='external' AND knowledge.is_public('evidence',e2.id) AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e2.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon))
   OR r.to_anchor_id IN (SELECT a.id FROM knowledge.anchors a WHERE a.version_id IN (SELECT CASE WHEN e2.target_version_id IS NOT NULL THEN e2.target_version_id WHEN e2.target_anchor_id IS NOT NULL THEN (SELECT a2.version_id FROM knowledge.anchors a2 WHERE a2.id=e2.target_anchor_id) ELSE NULL END
     FROM knowledge.evidence e2 WHERE e2.kind='external' AND knowledge.is_public('evidence',e2.id) AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e2.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon)))
 );
 SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY ca DESC),'[]'::jsonb) INTO corrections FROM (
  SELECT pg_catalog.jsonb_build_object('relation_id',r.id,'correcting',knowledge.row_ref(pg_catalog.to_jsonb(r),'from'),'corrected',knowledge.row_ref(pg_catalog.to_jsonb(r),'to'),
    'explanation',r.explanation,'created_at',knowledge.utc(r.created_at)) x,r.created_at ca
  FROM knowledge.relations r WHERE r.predicate='corrects' AND knowledge.is_public('relation',r.id) AND (
    r.to_version_id IN (SELECT CASE WHEN e2.target_version_id IS NOT NULL THEN e2.target_version_id WHEN e2.target_anchor_id IS NOT NULL THEN (SELECT a.version_id FROM knowledge.anchors a WHERE a.id=e2.target_anchor_id) ELSE NULL END
      FROM knowledge.evidence e2 WHERE e2.kind='external' AND knowledge.is_public('evidence',e2.id) AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e2.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon))
    OR r.to_anchor_id IN (SELECT a.id FROM knowledge.anchors a WHERE a.version_id IN (SELECT CASE WHEN e2.target_version_id IS NOT NULL THEN e2.target_version_id WHEN e2.target_anchor_id IS NOT NULL THEN (SELECT a2.version_id FROM knowledge.anchors a2 WHERE a2.id=e2.target_anchor_id) ELSE NULL END
      FROM knowledge.evidence e2 WHERE e2.kind='external' AND knowledge.is_public('evidence',e2.id) AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=e2.source_id AND knowledge.is_public('source',s.id) AND knowledge.canonical_url(s.url)=canon)))
  )
  ORDER BY r.created_at DESC LIMIT 20
 ) t;

 RETURN pg_catalog.jsonb_build_object('url',p_query->'url','canonical_url',canon,'sources',sources,'citations',citations,'corrections',corrections,
  'counts',pg_catalog.jsonb_build_object('sources',scount,'citations',ccount,'corrections',corrcount,'quote_states',qstates,'archive_states',astates),
  'truncated',pg_catalog.jsonb_build_object('sources',scount>20,'citations',ccount>50,'corrections',corrcount>20),
  'generated_at',knowledge.utc(pg_catalog.clock_timestamp()));
END $$;

-- === public.kb_archive_checks_pending =====================================
CREATE FUNCTION public.kb_archive_checks_pending(p_actor jsonb,p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE aid uuid;lim integer;items jsonb;BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(2081801,1);
 aid=knowledge.authorize_context(knowledge.identity_context(p_actor));
 PERFORM knowledge.require(EXISTS(SELECT 1 FROM knowledge.operators WHERE actor_id=aid),'FORBIDDEN');
 PERFORM knowledge.jobject(p_query,ARRAY['limit'],ARRAY[]::text[]);
 lim=CASE WHEN p_query?'limit' THEN knowledge.jint(p_query->'limit',1,200) ELSE 50 END;
 SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY ca),'[]'::jsonb) INTO items FROM (
  SELECT pg_catalog.jsonb_build_object(
    'evidence_id',e.id,'quote',e.quote,'url',s.url,'retrieved_at',knowledge.utc(s.retrieved_at),
    'published_at',knowledge.utc(s.published_at),'archive_url_hint',s.attributes->>'archive_url'
   ) x,e.created_at ca
  FROM knowledge.evidence e
  JOIN knowledge.sources s ON s.id=e.source_id
  WHERE e.kind='external' AND knowledge.is_public('evidence',e.id) AND knowledge.is_public('source',s.id)
   AND e.quote IS NOT NULL AND pg_catalog.length(knowledge.trim_text(e.quote))>0
   AND s.url IS NOT NULL
   AND (
    knowledge.evidence_archive_check(e) IS NULL
    OR (
     (knowledge.evidence_archive_check(e)->>'state')='fetch_failed'
     AND (knowledge.evidence_archive_check(e)->>'checked_at')::timestamptz < pg_catalog.clock_timestamp()-interval '7 days'
    )
   )
  ORDER BY e.created_at LIMIT lim
 ) t;
 RETURN pg_catalog.jsonb_build_object('items',items);
END $$;

-- === public.kb_record_archive_check =======================================
CREATE FUNCTION public.kb_record_archive_check(p_actor jsonb,p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE aid uuid;i uuid;e knowledge.evidence%ROWTYPE;s knowledge.sources%ROWTYPE;row knowledge.archive_checks%ROWTYPE;BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(2081801,1);
 aid=knowledge.authorize_context(knowledge.identity_context(p_actor));
 PERFORM knowledge.require(EXISTS(SELECT 1 FROM knowledge.operators WHERE actor_id=aid),'FORBIDDEN');
 PERFORM knowledge.jobject(p_query,ARRAY['evidence_id','state','archive_url','snapshot_at','text_sha256','text_length','rule_version','detail'],
  ARRAY['evidence_id','state','rule_version']);
 i=knowledge.juuid(p_query->'evidence_id');
 SELECT * INTO e FROM knowledge.evidence e2 WHERE e2.id=i AND e2.kind='external';
 PERFORM knowledge.require(e.id IS NOT NULL,'NOT_FOUND');
 PERFORM knowledge.require_public('evidence',e.id);
 SELECT * INTO s FROM knowledge.sources WHERE id=e.source_id;
 PERFORM knowledge.require(s.id IS NOT NULL AND s.url IS NOT NULL,'VALIDATION_FAILED');
 PERFORM knowledge.require(p_query->>'state' IN ('found_exact','found_normalized','found_fragments','not_found','no_snapshot','fetch_failed'));
 IF p_query?'archive_url' AND p_query->'archive_url'<>'null'::jsonb THEN
  PERFORM knowledge.require(pg_catalog.left(knowledge.jtext(p_query->'archive_url',2048),28)='https://web.archive.org/web/');
 ELSE PERFORM knowledge.require(NOT(p_query?'archive_url') OR p_query->'archive_url'='null'::jsonb);END IF;
 PERFORM knowledge.jtext(p_query->'rule_version',64);
 IF p_query?'detail' AND p_query->'detail'<>'null'::jsonb THEN PERFORM knowledge.jtext(p_query->'detail',500,0);END IF;
 IF p_query?'text_sha256' AND p_query->'text_sha256'<>'null'::jsonb THEN PERFORM knowledge.jhash(p_query->'text_sha256');END IF;
 IF p_query?'text_length' AND p_query->'text_length'<>'null'::jsonb THEN PERFORM knowledge.jint(p_query->'text_length',0,2147483647);END IF;
 IF p_query?'snapshot_at' AND p_query->'snapshot_at'<>'null'::jsonb THEN PERFORM knowledge.jtext(p_query->'snapshot_at',40);END IF;
 INSERT INTO knowledge.archive_checks(created_by,evidence_id,state,archive_url,snapshot_at,text_sha256,text_length,rule_version,detail)
 VALUES(aid,i,p_query->>'state',
  CASE WHEN p_query?'archive_url' THEN p_query->>'archive_url' ELSE NULL END,
  CASE WHEN p_query?'snapshot_at' THEN (p_query->>'snapshot_at')::timestamptz ELSE NULL END,
  CASE WHEN p_query?'text_sha256' THEN p_query->>'text_sha256' ELSE NULL END,
  CASE WHEN p_query?'text_length' THEN (p_query->>'text_length')::integer ELSE NULL END,
  p_query->>'rule_version',
  CASE WHEN p_query?'detail' THEN p_query->>'detail' ELSE NULL END)
 RETURNING * INTO row;
 RETURN pg_catalog.jsonb_build_object('id',row.id,'evidence_id',row.evidence_id,'state',row.state,'archive_url',row.archive_url,
  'snapshot_at',knowledge.utc(row.snapshot_at),'text_sha256',row.text_sha256,'text_length',row.text_length,
  'rule_version',row.rule_version,'detail',row.detail,'created_at',knowledge.utc(row.created_at));
END $$;

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage15-archive-check' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage15-archive-check' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.kb_url_report(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_url_report(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.kb_record_archive_check(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_record_archive_check(jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.kb_archive_checks_pending(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_archive_checks_pending(jsonb,jsonb) TO service_role;
COMMIT;
