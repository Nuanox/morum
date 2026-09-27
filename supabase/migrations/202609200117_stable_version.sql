-- Stage13 / stable_version. A second, mechanical, publicly defined version
-- selector alongside knowledge.current_version. It is NOT a truth judgement:
-- it is a state condition, like Wikipedia's "stable revision" concept. It
-- never replaces `current`, which keeps picking the highest version_no.
--
-- Definition: a public review R blocks a version V when all of:
--  1. R is public and R.stance='disagree'.
--  2. R targets V directly, or targets a public anchor of V.
--  3. R has at least one verified basis: a public evidence row E with
--     E.target_review_id=R.id and either
--       - E.kind='internal' (knowledge.is_public('evidence',E.id) already
--         requires E's own internal source_version_id/source_anchor_id to
--         be public), or
--       - E.kind='external' and knowledge.evidence_quote_check(E)->>'state'
--         is one of found_exact, found_normalized, found_fragments.
--     E.kind='reasoning' never counts; an external evidence whose quote
--     check is not_found/no_text/no_quote never counts.
-- A version is stable when it is public and no review blocks it.
-- knowledge.stable_version(record) returns the stable public version with
-- the highest version_no of that public record; NULL when none. Same
-- visibility conditions as current_version.
--
-- Votes are deliberately not counted (agents can be cloned): only a
-- verified disagree review blocks stability. Resolution is only (a) a
-- newer version, or (b) the operator hiding the blocking review via
-- moderation. No new write paths.
--
-- Additive only: no table/column drop, no data change, no UPDATE of
-- existing rows. Contract stays 2.1.0.
--  1. knowledge.stable_version(uuid) is a new function.
--  2. knowledge.version_view (defined 202609200102, last re-created
--     202609200106; this is its latest definition) is re-created verbatim
--     except adding 'is_stable' / 'stable_version_id' next to the existing
--     'is_current' / 'current_version_id' fields.
--  3. public.kb_url_report (defined 202609200110, latest definition) is
--     re-created verbatim except adding the same two fields to each
--     citation, next to its existing 'is_current' field.
--  4. kb_health re-created with tag stage13-stable-version.
-- Rollback: supabase/rollback/202609200117_stable_version_down.sql
BEGIN;

-- === knowledge.stable_version ============================================
CREATE FUNCTION knowledge.stable_version(record uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT v.id FROM knowledge.versions v JOIN knowledge.records r ON v.record_id=r.id
 WHERE r.id=record AND r.visibility='public' AND v.visibility='public'
  AND NOT EXISTS (
   SELECT 1 FROM knowledge.reviews rv
   WHERE rv.stance='disagree' AND knowledge.is_public('review',rv.id)
    AND (rv.target_version_id=v.id OR rv.target_anchor_id IN (
     SELECT a.id FROM knowledge.anchors a WHERE a.version_id=v.id AND knowledge.is_public('anchor',a.id)
    ))
    AND EXISTS (
     SELECT 1 FROM knowledge.evidence e
     WHERE e.target_review_id=rv.id AND knowledge.is_public('evidence',e.id)
      AND (
       e.kind='internal'
       OR (e.kind='external' AND (knowledge.evidence_quote_check(e)->>'state') IN ('found_exact','found_normalized','found_fragments'))
      )
    )
  )
 ORDER BY v.version_no DESC LIMIT 1
$$;

-- === knowledge.version_view (copy of 202609200106's body; adds is_stable /
-- stable_version_id next to is_current / current_version_id) ============
CREATE OR REPLACE FUNCTION knowledge.version_view(version uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE v knowledge.versions%ROWTYPE;a jsonb;c uuid;sv uuid;corrections jsonb;ac bigint;rc bigint;vc bigint;cut boolean=false; BEGIN
 PERFORM knowledge.require_public('version',version);SELECT * INTO v FROM knowledge.versions WHERE id=version;c=knowledge.current_version(v.record_id);sv=knowledge.stable_version(v.record_id);
 SELECT pg_catalog.jsonb_build_object('id',id,'kind',kind,'display_name',display_name,'self_description',self_description,'state',state) INTO a FROM knowledge.actors WHERE id=v.created_by;
 SELECT coalesce(pg_catalog.jsonb_agg(knowledge.row_ref(pg_catalog.to_jsonb(r),'from') ORDER BY created_at,id),'[]'::jsonb) INTO corrections FROM (SELECT r.* FROM knowledge.relations r
 WHERE predicate='corrects' AND (to_version_id=version OR to_anchor_id IN(SELECT id FROM knowledge.anchors WHERE version_id=version)) AND knowledge.is_public('relation',id) ORDER BY created_at,id LIMIT 51) r;
 cut=pg_catalog.jsonb_array_length(corrections)>50;IF cut THEN corrections=corrections-50;END IF;
 SELECT count(*) INTO ac FROM knowledge.annotations an JOIN knowledge.anchors aa ON an.anchor_id=aa.id WHERE aa.version_id=version AND knowledge.is_public('annotation',an.id);
 SELECT count(*) INTO rc FROM knowledge.relations r WHERE (r.from_version_id=version OR r.to_version_id=version OR r.from_anchor_id IN(SELECT id FROM knowledge.anchors WHERE version_id=version) OR r.to_anchor_id IN(SELECT id FROM knowledge.anchors WHERE version_id=version)) AND knowledge.is_public('relation',r.id);
 SELECT count(*) INTO vc FROM knowledge.reviews r WHERE target_version_id=version AND knowledge.is_public('review',id);
 RETURN pg_catalog.jsonb_build_object('version',knowledge.dto('version',version),'author',a,'is_current',c=version,'current_version_id',c,'is_stable',coalesce(sv=version,false),'stable_version_id',sv,'basis',knowledge.evidence_for('version',version),'basis_truncated',knowledge.evidence_count('version',version)>10,'corrections_truncated',cut,'review_summary',knowledge.review_summary('version',version),'correction_refs',corrections,'related_counts',pg_catalog.jsonb_build_object('annotations',ac,'relations',rc,'reviews',vc),'links',pg_catalog.jsonb_build_object('record','/api/v2/records/'||v.record_id,'version','/api/v2/versions/'||v.id,'history','/api/v2/records/'||v.record_id||'/versions','raw','/api/v2/versions/'||v.id||'/raw'));
END $$;

-- === public.kb_url_report (copy of 202609200110's body; adds is_stable /
-- stable_version_id to each citation, next to its existing is_current) ===
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

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage13-stable-version' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage13-stable-version' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.kb_url_report(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_url_report(jsonb) TO service_role;
COMMIT;
