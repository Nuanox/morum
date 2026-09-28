-- Rollback for 202609200119_archive_check.sql.
-- Drops public.kb_record_archive_check, knowledge.evidence_archive_check
-- and knowledge.archive_checks, and restores the previous (202609200117)
-- body of public.kb_url_report, without archive_check/archive_states.
BEGIN;

DROP FUNCTION IF EXISTS public.kb_record_archive_check(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.kb_archive_checks_pending(jsonb,jsonb);

CREATE OR REPLACE FUNCTION public.kb_url_report(p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u text;canon text;scount integer;ccount integer;corrcount integer;sources jsonb;citations jsonb;corrections jsonb;qstates jsonb;BEGIN
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

 SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY ca DESC),'[]'::jsonb) INTO citations FROM (
  SELECT pg_catalog.jsonb_build_object('evidence_id',e.id,'source_id',e.source_id,'target',knowledge.row_ref(pg_catalog.to_jsonb(e),'target'),
    'record_id',v.record_id,'version_id',v.id,'title',v.title,
    'is_current',CASE WHEN v.id IS NULL THEN NULL ELSE v.id=knowledge.current_version(v.record_id) END,
    'is_stable',CASE WHEN v.id IS NULL THEN NULL ELSE coalesce(v.id=knowledge.stable_version(v.record_id),false) END,
    'stable_version_id',CASE WHEN v.id IS NULL THEN NULL ELSE knowledge.stable_version(v.record_id) END,
    'quote',e.quote,'explanation',e.explanation,'quote_check',knowledge.evidence_quote_check(e),'created_at',knowledge.utc(e.created_at)) x,e.created_at ca
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
  'counts',pg_catalog.jsonb_build_object('sources',scount,'citations',ccount,'corrections',corrcount,'quote_states',qstates),
  'truncated',pg_catalog.jsonb_build_object('sources',scount>20,'citations',ccount>50,'corrections',corrcount>20),
  'generated_at',knowledge.utc(pg_catalog.clock_timestamp()));
END $$;

DROP FUNCTION IF EXISTS knowledge.evidence_archive_check(knowledge.evidence);
DROP TABLE IF EXISTS knowledge.archive_checks;

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage14-stable-version-dossier' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage14-stable-version-dossier' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.kb_url_report(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_url_report(jsonb) TO service_role;
COMMIT;
