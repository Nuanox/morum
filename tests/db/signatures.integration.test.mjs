/** Actual PostgreSQL only. Stage19 signatures (optional Web Bot Auth verification):
 *  - public.kb_record_signature validates its input (object_kind enum, expires>created) and
 *    inserts one row;
 *  - knowledge.signatures is append-only (no UPDATE/DELETE for any role);
 *  - knowledge.dto's new `signer` field (read back through public.kb_get_source here) is null
 *    until a signature is recorded, then reflects the NEWEST recorded signature for that object.
 * See supabase/migrations/202609200123_signatures.sql. */
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {testDatabaseConfig} from '../../scripts/db-test-config.mjs';
const config=testDatabaseConfig();
if(!config)test('Signatures PostgreSQL acceptance NOT RUN',{skip:'No acknowledged disposable local PostgreSQL database'},()=>{});
else {
 const {openHarness,code,record}=await import('./stage04-support.mjs');

 function sigQuery(kind,id,overrides={}){
  return {object_kind:kind,object_id:id,signer_origin:'https://writer.example',key_thumbprint:randomUUID().replace(/-/g,''),
   created:1700000000,expires:1700000300,signature_input:'sig1=("@authority");created=1700000000;keyid="x";alg="ed25519";expires=1700000300;tag="web-bot-auth"',
   signature:'YmFzZTY0LXNpZ25hdHVyZS1ieXRlcw==',...overrides};
 }

 test('Stage19 signatures on real PostgreSQL',async t=>{
  const h=await openHarness(config);t.after(()=>h.close());const {admin,a,raw,mutate}=h;const anon={kind:'anonymous'};

  const source=(await mutate(a,'source.create',{url:'https://source.example/sig-test',title:null,submitted_text:'A source used only for signature tests.',published_at:null,retrieved_at:null,rights_note:null,attributes:{},synthetic_demo:true},anon)).data;

  await t.test('kb_record_signature rejects an unknown object_kind',async()=>{
   await assert.rejects(raw(a,'kb_record_signature',{p_query:sigQuery('not_a_kind',source.id)}));
  });

  await t.test('kb_record_signature rejects expires<=created',async()=>{
   await assert.rejects(raw(a,'kb_record_signature',{p_query:sigQuery('source',source.id,{created:1700000300,expires:1700000300})}),code('VALIDATION_FAILED'));
  });

  await t.test('signer is null before any signature is recorded',async()=>{
   const dto=await raw(a,'kb_get_source',{p_query:{id:source.id}});
   assert.equal(dto.signer,null);
  });

  await t.test('a recorded signature appears as signer on the object DTO',async()=>{
   const query=sigQuery('source',source.id,{signer_origin:'https://first.example'});
   const inserted=await raw(a,'kb_record_signature',{p_query:query});
   assert.ok(inserted.id);
   const dto=await raw(a,'kb_get_source',{p_query:{id:source.id}});
   assert.equal(dto.signer.origin,'https://first.example');
   assert.equal(dto.signer.key_thumbprint,query.key_thumbprint);
   assert.ok(dto.signer.created_at);
  });

  await t.test('a second, later signature becomes the newest and wins',async()=>{
   // created_at is the row's own insert timestamp (server-assigned), not the signed `created`
   // param, so a later INSERT is unambiguously "newest" regardless of the signed window's values.
   const later=sigQuery('source',source.id,{signer_origin:'https://second.example'});
   await raw(a,'kb_record_signature',{p_query:later});
   const dto=await raw(a,'kb_get_source',{p_query:{id:source.id}});
   assert.equal(dto.signer.origin,'https://second.example');
  });

  await t.test('a different object kind (version) also gets a signer',async()=>{
   const v=(await mutate(a,'record.create',record(),anon)).data.version;
   await raw(a,'kb_record_signature',{p_query:sigQuery('version',v.id,{signer_origin:'https://version-signer.example'})});
   const view=await raw(a,'kb_get_version',{p_query:{id:v.id}});
   assert.equal(view.version.signer.origin,'https://version-signer.example');
  });

  await t.test('knowledge.signatures is append-only: no role can UPDATE or DELETE a row',async()=>{
   const row=await admin.query('select id from knowledge.signatures limit 1');
   await assert.rejects(admin.query('update knowledge.signatures set signer_origin=$1 where id=$2',['https://evil.example',row.rows[0].id]));
   await assert.rejects(admin.query('delete from knowledge.signatures where id=$1',[row.rows[0].id]));
  });

  await t.test('no role but service_role can call kb_record_signature',async()=>{
   const grants=await admin.query("select grantee,privilege_type from information_schema.role_routine_grants where routine_name='kb_record_signature'");
   const grantees=grants.rows.map(r=>r.grantee);
   assert.ok(grantees.includes('service_role'));
   assert.ok(!grantees.includes('PUBLIC'));assert.ok(!grantees.includes('anon'));assert.ok(!grantees.includes('authenticated'));
  });
 });
}
