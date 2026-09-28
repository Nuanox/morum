-- Stage19 / optional Web Bot Auth signatures (RFC 9421 HTTP Message Signatures, per
-- draft-ietf-webbotauth-httpsig-protocol-00). Additive only: no table/column drop, no truncate,
-- no extension install, no role alteration. Contract stays 2.1.0.
--
-- The server can now optionally verify a Web Bot Auth signature on a write (never required, never
-- rejecting an absent/invalid one -- see docs/design/2026-09-25-hash-identity.md stage 2). This
-- adds an append-only record of what verified, so a reader can see which origin's key signed a
-- given object, without turning that count into a trust score (README rule 5; no score/ranking/
-- filter is ever derived from this table).
--  1. knowledge.signatures is a new, append-only table (immutable via the same
--     knowledge.immutable_row() trigger used by knowledge.archive_checks/lookups). RLS enabled,
--     no grants to anon/authenticated/service_role -- reached only through kb_record_signature
--     below and read back only via knowledge.dto's new `signer` field.
--  2. public.kb_record_signature(p_query jsonb) is a new write RPC, service_role only (same shape
--     as public.kb_record_lookup: no actor envelope, called directly by the server once per
--     object a signed write created; non-fatal on the caller's side by design). Validates and
--     inserts one row.
--  3. knowledge.dto is re-created verbatim (see 202609200102_core_rpc.sql) plus one addition: a
--     `signer` field on every object kind, `{origin,key_thumbprint,created_at}` for the newest
--     signature row on that object, or null. This is the ONLY change to its body.
--  4. kb_health re-created with tag stage19-signatures.
-- Server-side wiring (handlers/mutations.ts, handlers/check.ts calling verifyWebBotAuth and, on a
-- verified signature, kb_record_signature; meta.signature on the response) ships in the same
-- change, outside this migration.
-- Rollback: supabase/rollback/202609200123_signatures_down.sql
BEGIN;

-- === knowledge.signatures ====================================================================
CREATE TABLE knowledge.signatures (
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
 object_kind text NOT NULL CHECK (object_kind IN ('version','anchor','source','evidence','review','relation','annotation','work_request')),
 object_id uuid NOT NULL,
 signer_origin text NOT NULL CHECK (pg_catalog.length(signer_origin)>0 AND pg_catalog.length(signer_origin)<=2048),
 key_thumbprint text NOT NULL CHECK (pg_catalog.length(key_thumbprint)>0 AND pg_catalog.length(key_thumbprint)<=128),
 created integer NOT NULL CHECK (created>0),
 expires integer NOT NULL CHECK (expires>created),
 signature_input text NOT NULL CHECK (pg_catalog.length(signature_input)>0 AND pg_catalog.length(signature_input)<=8192),
 signature text NOT NULL CHECK (pg_catalog.length(signature)>0 AND pg_catalog.length(signature)<=8192)
);
CREATE INDEX signatures_object_idx ON knowledge.signatures (object_kind,object_id,created_at DESC);
ALTER TABLE knowledge.signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge.signatures FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER signatures_immutable BEFORE UPDATE OR DELETE ON knowledge.signatures
 FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();

-- === public.kb_record_signature ==============================================================
CREATE FUNCTION public.kb_record_signature(p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k text;oid uuid;origin text;thumb text;cr integer;ex integer;sin text;sig text;new_id uuid;BEGIN
 PERFORM knowledge.jobject(p_query,ARRAY['object_kind','object_id','signer_origin','key_thumbprint','created','expires','signature_input','signature'],
  ARRAY['object_kind','object_id','signer_origin','key_thumbprint','created','expires','signature_input','signature']);
 k=p_query->>'object_kind';
 PERFORM knowledge.require(k IN ('version','anchor','source','evidence','review','relation','annotation','work_request'));
 oid=knowledge.juuid(p_query->'object_id');
 origin=knowledge.jtext(p_query->'signer_origin',2048);
 thumb=knowledge.jtext(p_query->'key_thumbprint',128);
 cr=knowledge.jint(p_query->'created',1,2147483647);
 ex=knowledge.jint(p_query->'expires',1,2147483647);
 PERFORM knowledge.require(ex>cr,'VALIDATION_FAILED');
 sin=knowledge.jtext(p_query->'signature_input',8192);
 sig=knowledge.jtext(p_query->'signature',8192);
 INSERT INTO knowledge.signatures(object_kind,object_id,signer_origin,key_thumbprint,created,expires,signature_input,signature)
 VALUES(k,oid,origin,thumb,cr,ex,sin,sig) RETURNING id INTO new_id;
 RETURN pg_catalog.jsonb_build_object('id',new_id);
END $$;

-- === knowledge.dto (verbatim from 202609200102_core_rpc.sql, plus the `signer` addition) ========
CREATE OR REPLACE FUNCTION knowledge.dto(kind text,object_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE j jsonb;o jsonb;ref jsonb;k text;cols text[];sig jsonb;sig_kind text:=kind;sig_object_id uuid:=object_id;BEGIN
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
 -- Roadmap: optional Web Bot Auth signatures (stage19-signatures). Newest verified signature for
 -- this exact object, across every object kind; null when never signed. Never used for scoring,
 -- ranking or filtering (README rule 5).
 SELECT pg_catalog.jsonb_build_object('origin',s.signer_origin,'key_thumbprint',s.key_thumbprint,'created_at',knowledge.utc(s.created_at))
  INTO sig FROM knowledge.signatures s WHERE s.object_kind=sig_kind AND s.object_id=sig_object_id ORDER BY s.created_at DESC LIMIT 1;
 o=o||pg_catalog.jsonb_build_object('signer',coalesce(sig,'null'::jsonb));
 SELECT coalesce(pg_catalog.array_agg(key),'{}'::text[]) INTO cols FROM pg_catalog.jsonb_object_keys(o) key WHERE key ~ '^(from|to|target)_(version|anchor|source|relation|annotation|evidence|review)_id$';
 RETURN o-cols;
END $$;

CREATE OR REPLACE FUNCTION public.kb_health() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT pg_catalog.jsonb_build_object('status',CASE WHEN contract_version='2.1.0' AND migration_tag='stage19-signatures' THEN 'ok' ELSE 'degraded' END,'database','reachable','contract_version',contract_version) FROM knowledge.schema_info WHERE singleton
$$;
UPDATE knowledge.schema_info SET migration_tag='stage19-signatures' WHERE singleton;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.kb_record_signature(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.kb_record_signature(jsonb) TO service_role;
COMMIT;
