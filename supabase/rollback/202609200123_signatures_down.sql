-- Rollback for 202609200123_signatures.sql.
-- Drops public.kb_record_signature and knowledge.signatures, and restores knowledge.dto to its
-- 202609200102_core_rpc.sql form (without the `signer` field).
BEGIN;

DROP FUNCTION IF EXISTS public.kb_record_signature(jsonb);
DROP TABLE IF EXISTS knowledge.signatures;

CREATE OR REPLACE FUNCTION knowledge.dto(kind text,object_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE j jsonb;o jsonb;ref jsonb;k text;cols text[];BEGIN
 j=knowledge.raw_object(kind,object_id);PERFORM knowledge.require(j IS NOT NULL,'NOT_FOUND');
 o=j;
 FOREACH k IN ARRAY ARRAY['created_at','updated_at','published_at','retrieved_at'] LOOP
  IF j?k THEN o=pg_catalog.jsonb_set(o,ARRAY[k],coalesce(pg_catalog.to_jsonb(knowledge.utc((j->>k)::timestamptz)),'null'::jsonb));END IF;
 END LOOP;
 IF kind NOT IN ('source','version') THEN o=o-'visibility';END IF;
 CASE kind
 WHEN 'anchor' THEN o=o-ARRAY['start_cp','end_cp','exact','prefix','suffix'];
  o=o||pg_catalog.jsonb_build_object('selector',pg_catalog.jsonb_build_object('unit','unicode_code_point','start',(j->>'start_cp')::integer,'end',(j->>'end_cp')::integer,'exact',j->'exact','prefix',j->'prefix','suffix',j->'suffix'));
 WHEN 'relation' THEN o=o||pg_catalog.jsonb_build_object('from',knowledge.row_ref(j,'from'),'to',knowledge.row_ref(j,'to'));
 WHEN 'review' THEN o=o||pg_catalog.jsonb_build_object('target',knowledge.row_ref(j,'target'));
 WHEN 'evidence' THEN
  IF j->>'kind'='reasoning' THEN ref=pg_catalog.jsonb_build_object('kind','reasoning','explanation',j->'explanation');
  ELSIF j->>'kind'='external' THEN ref=pg_catalog.jsonb_build_object('kind','external','source_id',j->'source_id','quote',j->'quote','explanation',j->'explanation');
  ELSE ref=pg_catalog.jsonb_build_object('kind','internal','source',knowledge.row_ref(j,'source'),'explanation',j->'explanation');END IF;
  o=o-ARRAY['kind','explanation','source_id','source_version_id','source_anchor_id','quote'];o=o||pg_catalog.jsonb_build_object('target',knowledge.row_ref(j,'target'),'basis',ref);
 WHEN 'work_request' THEN
  SELECT coalesce(pg_catalog.jsonb_agg(knowledge.row_ref(pg_catalog.to_jsonb(l),'target') ORDER BY ordinal),'[]'::jsonb) INTO ref FROM knowledge.work_resolution_links l WHERE event_id=(j->>'resolution_event_id')::uuid;
  o=(o-'resolution_event_id')||pg_catalog.jsonb_build_object('target',knowledge.row_ref(j,'target'),'resolution_refs',ref);
 ELSE NULL;END CASE;
 SELECT coalesce(pg_catalog.array_agg(key),'{}'::text[]) INTO cols FROM pg_catalog.jsonb_object_keys(o) key WHERE key ~ '^(from|to|target)_(version|anchor|source|relation|annotation|evidence|review)_id$';
 RETURN o-cols;
END $$;

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage18-lookup-log' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage18-lookup-log' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
