-- Stage17 / attention: archive_not_found. Additive only: no table/column
-- drop, no truncate, no extension install, no role alteration. Contract
-- stays 2.1.0.
-- A daily job (scripts/archive-check.mjs, see 202609200119_archive_check.sql)
-- compares external evidence quotes against a Wayback snapshot and stores
-- the newest result per evidence via knowledge.evidence_archive_check(e).
-- Evidence whose newest archive check state is 'not_found' had no attention
-- reason to surface it. This adds one: 'archive_not_found', same priority
-- tier as 'quote_not_found', right after it. Both knowledge.attention_candidates
-- and public.kb_attention (both last defined verbatim in 202609200110_read_surfaces.sql,
-- neither touched since) are re-created here verbatim plus this addition.
-- kb_health re-created with tag stage17-attention-archive-not-found.
-- Rollback: supabase/rollback/202609200121_attention_archive_not_found_down.sql
BEGIN;

CREATE OR REPLACE FUNCTION knowledge.attention_candidates() RETURNS TABLE(reason text,priority integer,target_kind text,target_id uuid,record_id uuid,version_id uuid,title text,snippet text,since timestamptz,detail jsonb)
LANGUAGE sql STABLE SET search_path='' AS $$
 WITH cur AS (
  SELECT v.* FROM knowledge.versions v WHERE knowledge.is_public('version',v.id) AND v.id=knowledge.current_version(v.record_id) AND NOT v.synthetic_demo
 )
 SELECT 'quote_not_found',0,'evidence',e.id,NULL::uuid,NULL::uuid,NULL::text,pg_catalog.left(coalesce(e.explanation,''),200),e.created_at,
  pg_catalog.jsonb_build_object('quote_state','not_found')
 FROM knowledge.evidence e WHERE e.kind='external' AND knowledge.is_public('evidence',e.id) AND (knowledge.evidence_quote_check(e)->>'state')='not_found'
 UNION ALL
 SELECT 'archive_not_found',0,'evidence',e.id,NULL::uuid,NULL::uuid,NULL::text,pg_catalog.left(coalesce(e.explanation,''),200),e.created_at,
  pg_catalog.jsonb_build_object('archive_state','not_found','archive_url',ac.archive_url,'snapshot_at',knowledge.utc(ac.snapshot_at))
 FROM knowledge.evidence e
 JOIN knowledge.archive_checks ac ON ac.evidence_id=e.id AND ac.created_at=(SELECT max(ac2.created_at) FROM knowledge.archive_checks ac2 WHERE ac2.evidence_id=e.id)
 WHERE e.kind='external' AND knowledge.is_public('evidence',e.id) AND ac.state='not_found'
 UNION ALL
 SELECT 'contested',1,'version',v.id,v.record_id,v.id,v.title,pg_catalog.left(coalesce(v.body_text,''),200),v.created_at,
  pg_catalog.jsonb_build_object('disagree_count',(SELECT count(*) FROM knowledge.reviews rv WHERE rv.stance='disagree' AND knowledge.is_public('review',rv.id) AND (
    rv.id IN (SELECT h.review_id FROM knowledge.review_heads h WHERE (h.target_kind='version' AND h.target_id=v.id) OR (h.target_kind='anchor' AND h.target_id IN (SELECT a.id FROM knowledge.anchors a WHERE a.version_id=v.id)))
    OR (rv.created_by IS NULL AND (rv.target_version_id=v.id OR rv.target_anchor_id IN (SELECT a.id FROM knowledge.anchors a WHERE a.version_id=v.id))))))
 FROM cur v
 WHERE EXISTS(SELECT 1 FROM knowledge.reviews rv WHERE rv.stance='disagree' AND knowledge.is_public('review',rv.id) AND (
    rv.id IN (SELECT h.review_id FROM knowledge.review_heads h WHERE (h.target_kind='version' AND h.target_id=v.id) OR (h.target_kind='anchor' AND h.target_id IN (SELECT a.id FROM knowledge.anchors a WHERE a.version_id=v.id)))
    OR (rv.created_by IS NULL AND (rv.target_version_id=v.id OR rv.target_anchor_id IN (SELECT a.id FROM knowledge.anchors a WHERE a.version_id=v.id)))))
 AND NOT EXISTS(SELECT 1 FROM knowledge.relations rc WHERE rc.predicate='corrects' AND knowledge.is_public('relation',rc.id) AND rc.to_version_id=v.id)
 UNION ALL
 SELECT 'no_basis',2,'relation',r.id,NULL::uuid,NULL::uuid,NULL::text,pg_catalog.left(coalesce(r.explanation,''),200),r.created_at,'{}'::jsonb
 FROM knowledge.relations r WHERE knowledge.is_public('relation',r.id) AND NOT EXISTS(SELECT 1 FROM knowledge.evidence e WHERE e.target_relation_id=r.id AND knowledge.is_public('evidence',e.id))
 UNION ALL
 SELECT 'no_basis',2,'version',v.id,v.record_id,v.id,v.title,pg_catalog.left(coalesce(v.body_text,''),200),v.created_at,'{}'::jsonb
 FROM cur v WHERE v.version_no>1 AND NOT EXISTS(SELECT 1 FROM knowledge.evidence e WHERE e.target_version_id=v.id AND knowledge.is_public('evidence',e.id))
 UNION ALL
 SELECT 'requested',3,'work_request',wr.id,NULL::uuid,NULL::uuid,wr.title,pg_catalog.left(coalesce(wr.description,''),200),wr.created_at,pg_catalog.jsonb_build_object('status',wr.status)
 FROM knowledge.work_requests wr WHERE wr.status='open' AND wr.visibility='public'
 UNION ALL
 SELECT 'quote_unverifiable',4,'evidence',e.id,NULL::uuid,NULL::uuid,NULL::text,pg_catalog.left(coalesce(e.explanation,''),200),e.created_at,pg_catalog.jsonb_build_object('quote_state','no_text')
 FROM knowledge.evidence e WHERE e.kind='external' AND knowledge.is_public('evidence',e.id) AND (knowledge.evidence_quote_check(e)->>'state')='no_text'
 UNION ALL
 SELECT 'unreviewed',5,'version',v.id,v.record_id,v.id,v.title,pg_catalog.left(coalesce(v.body_text,''),200),v.created_at,'{}'::jsonb
 FROM cur v WHERE v.created_at<pg_catalog.clock_timestamp()-interval '1 hour'
  AND NOT EXISTS(SELECT 1 FROM knowledge.reviews rv WHERE knowledge.is_public('review',rv.id) AND (rv.target_version_id=v.id OR rv.target_anchor_id IN (SELECT a.id FROM knowledge.anchors a WHERE a.version_id=v.id)))
 UNION ALL
 SELECT 'uncategorized',6,'version',v.id,v.record_id,v.id,v.title,pg_catalog.left(coalesce(v.body_text,''),200),v.created_at,'{}'::jsonb
 FROM cur v WHERE NOT (v.attributes ? 'topic' AND pg_catalog.jsonb_typeof(v.attributes->'topic')='string')
$$;

CREATE OR REPLACE FUNCTION public.kb_attention(p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE lim integer;reasons text[];seed text;items jsonb;counts jsonb;BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(2081801,1);
 PERFORM knowledge.jobject(p_query,ARRAY['limit','reasons','seed'],ARRAY[]::text[]);
 lim=CASE WHEN p_query?'limit' THEN knowledge.jint(p_query->'limit',1,50) ELSE 20 END;
 IF p_query?'reasons' THEN
  PERFORM knowledge.require(pg_catalog.jsonb_typeof(p_query->'reasons')='array');
  SELECT coalesce(pg_catalog.array_agg(value#>>'{}'),'{}'::text[]) INTO reasons FROM pg_catalog.jsonb_array_elements(p_query->'reasons');
  PERFORM knowledge.require(reasons <@ ARRAY['quote_not_found','archive_not_found','contested','no_basis','requested','quote_unverifiable','unreviewed','uncategorized']::text[]);
 ELSE reasons=ARRAY['quote_not_found','archive_not_found','contested','no_basis','requested','quote_unverifiable','unreviewed','uncategorized'];END IF;
 seed=CASE WHEN p_query?'seed' THEN knowledge.jtext(p_query->'seed',64,0) ELSE '' END;

 SELECT coalesce(pg_catalog.jsonb_object_agg(reason,cnt),'{}'::jsonb) INTO counts FROM (
  SELECT reason,count(*) cnt FROM knowledge.attention_candidates() WHERE reason=ANY(reasons) GROUP BY reason
 ) g;
 counts=pg_catalog.jsonb_build_object('quote_not_found',coalesce((counts->>'quote_not_found')::integer,0),'archive_not_found',coalesce((counts->>'archive_not_found')::integer,0),'contested',coalesce((counts->>'contested')::integer,0),
  'no_basis',coalesce((counts->>'no_basis')::integer,0),'requested',coalesce((counts->>'requested')::integer,0),
  'quote_unverifiable',coalesce((counts->>'quote_unverifiable')::integer,0),'unreviewed',coalesce((counts->>'unreviewed')::integer,0),
  'uncategorized',coalesce((counts->>'uncategorized')::integer,0));

 SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY pri,rk),'[]'::jsonb) INTO items FROM (
  SELECT pg_catalog.jsonb_build_object('reason',c.reason,'priority',c.priority,'target',pg_catalog.jsonb_build_object('kind',c.target_kind,'id',c.target_id),
    'record_id',c.record_id,'version_id',c.version_id,'title',c.title,'snippet',c.snippet,'since',knowledge.utc(c.since),'detail',c.detail) x,
    c.priority pri,pg_catalog.md5(c.target_id::text||seed) rk
  FROM knowledge.attention_candidates() c WHERE c.reason=ANY(reasons)
  ORDER BY c.priority,pg_catalog.md5(c.target_id::text||seed) LIMIT lim
 ) t;
 RETURN pg_catalog.jsonb_build_object('items',items,'counts',counts,'generated_at',knowledge.utc(pg_catalog.clock_timestamp()));
END $$;

REVOKE ALL ON FUNCTION public.kb_attention(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_attention(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage17-attention-archive-not-found' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage17-attention-archive-not-found' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
