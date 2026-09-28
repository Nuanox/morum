-- Stage18 / lookup log (roadmap 2.11, extended). Additive only: no table/column drop, no
-- truncate, no extension install, no role alteration. Contract stays 2.1.0.
--
-- Today the server records nothing about GET /api/v2/url-report calls, so none of the adoption
-- metrics (hit rate, write-back rate, distinct operators) can be measured. This adds an
-- append-only log of lookups (url_report reads and the checks that may follow them) and two
-- RPCs to write and summarize it. It also lets an empty url-report answer "not known since
-- <date>" instead of nothing, via kb_record_lookup's first_lookup_at.
--  1. knowledge.lookups is a new, append-only table (immutable via the same knowledge.immutable_row()
--     trigger used by knowledge.archive_checks). RLS enabled, no grants to anon/authenticated/
--     service_role -- reached only through the two functions below.
--  2. public.kb_record_lookup(p_query jsonb) is a new write RPC, service_role only (mirrors
--     public.kb_rate_limit's shape: no actor envelope, called directly by the server on every
--     url-report/check request, non-fatal on the caller's side by design). Validates and inserts
--     one row; returns {id, first_lookup_at} where first_lookup_at is MIN(created_at) over every
--     row sharing this canonical_url, including the one just inserted.
--  3. public.kb_lookup_metrics(p_actor jsonb,p_query jsonb) is a new operator-only read RPC
--     (same guard as public.kb_archive_checks_pending), returning the aggregate hit-rate,
--     write-back-rate and per-operator breakdown defined in docs/METRICS.md.
--  4. kb_health re-created with tag stage18-lookup-log.
-- Server-side wiring (kb_url_report/kb_check handlers calling kb_record_lookup, the new
-- GET /admin/metrics/lookups route) ships in the same change, outside this migration.
-- Rollback: supabase/rollback/202609200122_lookup_log_down.sql
BEGIN;

-- === knowledge.lookups ======================================================================
CREATE TABLE knowledge.lookups (
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 kind text NOT NULL CHECK (kind IN ('url_report','check')),
 url_input text NOT NULL CHECK (pg_catalog.length(url_input)>0 AND pg_catalog.length(url_input)<=2048),
 canonical_url text NOT NULL,
 hit boolean NOT NULL,
 -- Self-reported provenance only (Morum-Agent header), same as knowledge.audit_events/versions.attributes
 -- elsewhere -- never certified. NULL when the header was absent or malformed.
 operator text CHECK (operator IS NULL OR pg_catalog.length(operator) BETWEEN 1 AND 120),
 harness text CHECK (harness IS NULL OR pg_catalog.length(harness) BETWEEN 1 AND 120),
 model text CHECK (model IS NULL OR pg_catalog.length(model) BETWEEN 1 AND 120),
 -- The authenticated agent's id when the request carried a key (Authorization: Bearer nuanox_...),
 -- else NULL. No client IP, no user-agent string, no other header is ever stored here.
 agent_key_id uuid,
 request_id uuid
);
CREATE INDEX lookups_canonical_url_idx ON knowledge.lookups (canonical_url,created_at);
CREATE INDEX lookups_operator_idx ON knowledge.lookups (operator,created_at);
ALTER TABLE knowledge.lookups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge.lookups FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER lookups_immutable BEFORE UPDATE OR DELETE ON knowledge.lookups
 FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();

-- === public.kb_record_lookup ================================================================
CREATE FUNCTION public.kb_record_lookup(p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k text;u text;canon text;h boolean;op text;ha text;mo text;akid uuid;rid uuid;new_id uuid;first_at timestamptz;BEGIN
 PERFORM knowledge.jobject(p_query,ARRAY['kind','url_input','hit','operator','harness','model','agent_key_id','request_id'],ARRAY['kind','url_input','hit']);
 k=p_query->>'kind';PERFORM knowledge.require(k IN ('url_report','check'));
 u=knowledge.jtext(p_query->'url_input',2048);
 PERFORM knowledge.require(pg_catalog.jsonb_typeof(p_query->'hit')='boolean');h=(p_query->>'hit')::boolean;
 canon=knowledge.canonical_url(u);PERFORM knowledge.require(canon IS NOT NULL,'VALIDATION_FAILED');
 op=CASE WHEN p_query?'operator' AND p_query->'operator'<>'null'::jsonb THEN knowledge.jtext(p_query->'operator',120) ELSE NULL END;
 ha=CASE WHEN p_query?'harness' AND p_query->'harness'<>'null'::jsonb THEN knowledge.jtext(p_query->'harness',120) ELSE NULL END;
 mo=CASE WHEN p_query?'model' AND p_query->'model'<>'null'::jsonb THEN knowledge.jtext(p_query->'model',120) ELSE NULL END;
 akid=CASE WHEN p_query?'agent_key_id' AND p_query->'agent_key_id'<>'null'::jsonb THEN knowledge.juuid(p_query->'agent_key_id') ELSE NULL END;
 rid=CASE WHEN p_query?'request_id' AND p_query->'request_id'<>'null'::jsonb THEN knowledge.juuid(p_query->'request_id') ELSE NULL END;
 INSERT INTO knowledge.lookups(kind,url_input,canonical_url,hit,operator,harness,model,agent_key_id,request_id)
 VALUES(k,u,canon,h,op,ha,mo,akid,rid) RETURNING id INTO new_id;
 SELECT min(created_at) INTO first_at FROM knowledge.lookups WHERE canonical_url=canon;
 RETURN pg_catalog.jsonb_build_object('id',new_id,'first_lookup_at',knowledge.utc(first_at));
END $$;

-- === public.kb_lookup_metrics ================================================================
CREATE FUNCTION public.kb_lookup_metrics(p_actor jsonb,p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE aid uuid;days integer;since timestamptz;total integer;hits integer;wb integer;emptylk integer;ops jsonb;dops integer;dkeys integer;BEGIN
 aid=knowledge.authorize_context(knowledge.identity_context(p_actor));
 PERFORM knowledge.require(EXISTS(SELECT 1 FROM knowledge.operators WHERE actor_id=aid),'FORBIDDEN');
 PERFORM knowledge.jobject(p_query,ARRAY['days'],ARRAY[]::text[]);
 days=CASE WHEN p_query?'days' THEN knowledge.jint(p_query->'days',1,365) ELSE 30 END;
 since=pg_catalog.clock_timestamp()-((days::text)||' days')::interval;

 SELECT count(*),count(*) FILTER (WHERE hit) INTO total,hits FROM knowledge.lookups WHERE kind='url_report' AND created_at>=since;
 SELECT count(*) INTO emptylk FROM knowledge.lookups WHERE kind='url_report' AND created_at>=since AND NOT hit;

 -- write_back: an empty (hit=false) url_report row followed within 30 minutes by a check row on
 -- the same canonical_url, matched by the same declared operator, or (when operator is null on
 -- the lookup) the same authenticated agent_key_id.
 SELECT count(*) INTO wb FROM knowledge.lookups lo
 WHERE lo.kind='url_report' AND NOT lo.hit AND lo.created_at>=since
  AND EXISTS(
   SELECT 1 FROM knowledge.lookups c WHERE c.kind='check' AND c.canonical_url=lo.canonical_url
    AND c.created_at>lo.created_at AND c.created_at<=lo.created_at+interval '30 minutes'
    AND ((lo.operator IS NOT NULL AND c.operator=lo.operator) OR (lo.operator IS NULL AND lo.agent_key_id IS NOT NULL AND c.agent_key_id=lo.agent_key_id))
  );

 SELECT coalesce(pg_catalog.jsonb_agg(x ORDER BY x->>'operator'),'[]'::jsonb) INTO ops FROM (
  SELECT pg_catalog.jsonb_build_object(
   'operator',coalesce(g.operator,'(anonymous)'),
   'lookups',g.lookups,'hits',g.hits,
   'hit_rate',CASE WHEN g.lookups>0 THEN pg_catalog.round(g.hits::numeric/g.lookups,4) ELSE NULL END,
   'checks',g.checks,'write_backs',g.write_backs,
   'write_back_rate',CASE WHEN g.empty_lookups>0 THEN pg_catalog.round(g.write_backs::numeric/g.empty_lookups,4) ELSE NULL END
  ) x
  FROM (
   SELECT lo.operator,
    count(*) FILTER (WHERE lo.kind='url_report') lookups,
    count(*) FILTER (WHERE lo.kind='url_report' AND lo.hit) hits,
    count(*) FILTER (WHERE lo.kind='url_report' AND NOT lo.hit) empty_lookups,
    count(*) FILTER (WHERE lo.kind='check') checks,
    count(*) FILTER (WHERE lo.kind='url_report' AND NOT lo.hit AND EXISTS(
      SELECT 1 FROM knowledge.lookups c WHERE c.kind='check' AND c.canonical_url=lo.canonical_url
       AND c.created_at>lo.created_at AND c.created_at<=lo.created_at+interval '30 minutes'
       AND ((lo.operator IS NOT NULL AND c.operator=lo.operator) OR (lo.operator IS NULL AND lo.agent_key_id IS NOT NULL AND c.agent_key_id=lo.agent_key_id))
    )) write_backs
   FROM knowledge.lookups lo WHERE lo.created_at>=since
   GROUP BY lo.operator
  ) g
 ) t;

 SELECT count(DISTINCT operator) INTO dops FROM knowledge.lookups WHERE created_at>=since AND operator IS NOT NULL;
 SELECT count(DISTINCT agent_key_id) INTO dkeys FROM knowledge.lookups WHERE created_at>=since AND agent_key_id IS NOT NULL;

 RETURN pg_catalog.jsonb_build_object(
  'window_days',days,'lookups',total,'hits',hits,
  'hit_rate',CASE WHEN total>0 THEN pg_catalog.round(hits::numeric/total,4) ELSE NULL END,
  'operators',ops,'distinct_operators',dops,'distinct_agent_keys',dkeys,
  'write_backs',wb,'write_back_rate',CASE WHEN emptylk>0 THEN pg_catalog.round(wb::numeric/emptylk,4) ELSE NULL END
 );
END $$;

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage18-lookup-log' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage18-lookup-log' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.kb_record_lookup(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_record_lookup(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.kb_lookup_metrics(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_lookup_metrics(jsonb,jsonb) TO service_role;
COMMIT;
