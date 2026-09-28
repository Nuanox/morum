-- Rollback for 202609200122_lookup_log.sql.
-- Drops public.kb_lookup_metrics, public.kb_record_lookup and knowledge.lookups.
-- kb_url_report/kb_check are untouched by the forward migration (recording happens entirely
-- server-side, non-fatally), so there is nothing to restore for them here.
BEGIN;

DROP FUNCTION IF EXISTS public.kb_lookup_metrics(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.kb_record_lookup(jsonb);
DROP TABLE IF EXISTS knowledge.lookups;

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage17-attention-archive-not-found' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage17-attention-archive-not-found' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
