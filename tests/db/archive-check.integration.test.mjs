/** Actual PostgreSQL only. Stage15 archive_check:
 *  - the JS port (scripts/lib/quote-check.mjs) agrees with knowledge.quote_check on every vector
 *    from tests/unit/quote-check.test.mjs;
 *  - public.kb_archive_checks_pending lists external evidence due for a check, operator-only;
 *  - public.kb_record_archive_check stores an append-only row, operator-only, validating state
 *    and that archive_url (when present) starts with https://web.archive.org/web/;
 *  - kb_url_report and kb_dossier surface archive_check / archive_states additively.
 * See supabase/migrations/202609200119_archive_check.sql and 202609200120_archive-check-dossier.sql. */
import test from 'node:test';import assert from 'node:assert/strict';
import {testDatabaseConfig} from '../../scripts/db-test-config.mjs';
const config=testDatabaseConfig();
if(!config)test('Archive-check PostgreSQL acceptance NOT RUN',{skip:'No acknowledged disposable local PostgreSQL database'},()=>{});
else {
 const {openHarness,record,code}=await import('./stage04-support.mjs');
 const {quoteCheck}=await import('../../scripts/lib/quote-check.mjs');
 const {VECTORS}=await import('../unit/quote-check.test.mjs');
 const anon={kind:'anonymous'};

 test('Stage15 archive_check on real PostgreSQL',async t=>{
  const h=await openHarness(config);t.after(()=>h.close());const {admin,a,raw,rpc,mutate,enroll}=h;

  await t.test('JS quote-check port agrees with knowledge.quote_check on every unit-test vector',async()=>{
   for(const v of VECTORS){
    const sqlState=(await admin.query('select knowledge.quote_check($1,$2) s',[v.quote,v.submitted])).rows[0].s;
    assert.equal(quoteCheck(v.quote,v.submitted),sqlState,`vector "${v.name}" disagrees with the database`);
   }
  });

  async function externalEvidence(quote,url='https://example.org/archive-check-fixture',submitted='irrelevant to archive-check: the submitted excerpt is never used by it'){
   const v=(await mutate(a,'record.create',record('SYNTHETIC archive-check target'),anon)).data.version;
   const src=(await mutate(a,'source.create',{url,title:null,submitted_text:submitted,published_at:null,retrieved_at:'2024-01-01T00:00:00Z',rights_note:null,attributes:{},synthetic_demo:true},anon)).data;
   const ev=(await mutate(a,'evidence.create',{target:{kind:'version',id:v.id},basis:{kind:'external',source_id:src.id,quote,explanation:'SYNTHETIC archive-check fixture'}},anon)).data;
   return {version:v,source:src,evidence:ev};
  }

  const operator=await enroll('SYNTHETIC archive-check operator');
  await admin.query("insert into knowledge.operators(actor_id,granted_by_note) values($1,'SYNTHETIC archive-check fixture only') on conflict do nothing",[operator.actor.actor_id]);
  const nonOperator=await enroll('SYNTHETIC archive-check non-operator');

  await t.test('a fresh external evidence with a quote and a source url is pending',async()=>{
   const {evidence}=await externalEvidence('a pending quote');
   const pending=await raw(a,'kb_archive_checks_pending',{p_actor:operator.actor,p_query:{limit:200}});
   assert(pending.items.some(i=>i.evidence_id===evidence.id),'newly created external evidence should be pending');
  });

  await t.test('non-operator cannot list or record archive checks',async()=>{
   await assert.rejects(raw(a,'kb_archive_checks_pending',{p_actor:nonOperator.actor,p_query:{}}),code('FORBIDDEN'));
   const {evidence}=await externalEvidence('another pending quote');
   await assert.rejects(raw(a,'kb_record_archive_check',{p_actor:nonOperator.actor,p_query:{evidence_id:evidence.id,state:'not_found',rule_version:'archive_check/1'}}),code('FORBIDDEN'));
  });

  await t.test('recording a result removes the item from pending, and it is append-only (a second row is allowed, the newest wins)',async()=>{
   const {evidence}=await externalEvidence('a quote that gets checked');
   const row1=await raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{evidence_id:evidence.id,state:'not_found',rule_version:'archive_check/1'}});
   assert.equal(row1.state,'not_found');
   let pending=await raw(a,'kb_archive_checks_pending',{p_actor:operator.actor,p_query:{limit:200}});
   assert(!pending.items.some(i=>i.evidence_id===evidence.id),'a checked evidence with a non-fetch_failed state should not be pending again');

   const row2=await raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{
    evidence_id:evidence.id,state:'found_exact',
    archive_url:'https://web.archive.org/web/20240101000000id_/https://example.org/archive-check-fixture',
    snapshot_at:'2024-01-01T00:00:00Z',text_sha256:'a'.repeat(64),text_length:42,rule_version:'archive_check/1',detail:null,
   }});
   assert.equal(row2.state,'found_exact');
   assert.notEqual(row2.id,row1.id,'archive_checks is append-only: a second check is a new row');

   const summary=await admin.query('select knowledge.evidence_archive_check(e) j from knowledge.evidence e where e.id=$1',[evidence.id]);
   assert.equal(summary.rows[0].j.state,'found_exact','the newest row wins');
  });

  await t.test('kb_record_archive_check rejects an archive_url outside web.archive.org',async()=>{
   const {evidence}=await externalEvidence('a rejected archive url quote');
   await assert.rejects(raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{
    evidence_id:evidence.id,state:'found_exact',archive_url:'https://example.com/not-wayback',rule_version:'archive_check/1',
   }}));
  });

  await t.test('kb_record_archive_check rejects an unknown state',async()=>{
   const {evidence}=await externalEvidence('a rejected state quote');
   await assert.rejects(raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{evidence_id:evidence.id,state:'maybe',rule_version:'archive_check/1'}}));
  });

  await t.test('kb_url_report surfaces archive_check per citation and archive_states counts',async()=>{
   const url='https://example.org/archive-check-url-report';
   const {evidence}=await externalEvidence('a url-report quote',url);
   await raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{evidence_id:evidence.id,state:'not_found',rule_version:'archive_check/1'}});
   const report=await rpc(a,'kb_url_report',{p_query:{url}});
   const citation=report.citations.find(c=>c.evidence_id===evidence.id);
   assert(citation,'citation should be present in kb_url_report');
   assert.equal(citation.archive_check.state,'not_found');
   assert.equal(report.counts.archive_states.not_found,1);
   assert.equal(report.counts.archive_states.unchecked,0);
  });

  await t.test('kb_url_report counts an evidence with no archive check as unchecked',async()=>{
   const url='https://example.org/archive-check-unchecked';
   await externalEvidence('an unchecked quote',url);
   const report=await rpc(a,'kb_url_report',{p_query:{url}});
   assert.equal(report.counts.archive_states.unchecked,1);
   assert.equal(report.citations[0].archive_check,null);
  });

  await t.test('kb_dossier surfaces archive_check on each evidence item',async()=>{
   const {version,evidence}=await externalEvidence('a dossier quote');
   await raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{evidence_id:evidence.id,state:'found_normalized',rule_version:'archive_check/1'}});
   const dossier=await rpc(a,'kb_dossier',{p_query:{target:{kind:'version',id:version.id}}});
   const item=dossier.evidence.find(e=>e.id===evidence.id);
   assert(item,'evidence should appear in the dossier');
   assert.equal(item.archive_check.state,'found_normalized');
  });

  await t.test('kb_attention (0121): archive_not_found lists evidence whose newest archive check is not_found, with detail fields; found_exact does not list it; a newer found_exact removes it; counts include the key',async()=>{
   const {evidence}=await externalEvidence('an attention archive_not_found quote');
   let seen=await rpc(a,'kb_attention',{p_query:{reasons:['archive_not_found'],limit:50}});
   assert(!seen.items.some(i=>i.target.id===evidence.id),'not checked yet: should not be listed');

   await raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{
    evidence_id:evidence.id,state:'not_found',
    archive_url:'https://web.archive.org/web/20240101000000id_/https://example.org/archive-check-fixture',
    snapshot_at:'2024-01-01T00:00:00Z',rule_version:'archive_check/1',
   }});
   seen=await rpc(a,'kb_attention',{p_query:{reasons:['archive_not_found'],limit:50}});
   const item=seen.items.find(i=>i.target.id===evidence.id);
   assert(item,'not_found archive check should surface under archive_not_found');
   assert.equal(item.detail.archive_state,'not_found');
   assert.equal(item.detail.archive_url,'https://web.archive.org/web/20240101000000id_/https://example.org/archive-check-fixture');
   assert.equal(item.detail.snapshot_at,'2024-01-01T00:00:00.000Z');
   assert.ok(seen.counts.archive_not_found>=1);

   const {evidence:evidence2}=await externalEvidence('an attention found_exact quote');
   await raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{evidence_id:evidence2.id,state:'found_exact',rule_version:'archive_check/1'}});
   seen=await rpc(a,'kb_attention',{p_query:{reasons:['archive_not_found'],limit:50}});
   assert(!seen.items.some(i=>i.target.id===evidence2.id),'found_exact should not be listed under archive_not_found');

   await raw(a,'kb_record_archive_check',{p_actor:operator.actor,p_query:{evidence_id:evidence.id,state:'found_exact',rule_version:'archive_check/1'}});
   seen=await rpc(a,'kb_attention',{p_query:{reasons:['archive_not_found'],limit:50}});
   assert(!seen.items.some(i=>i.target.id===evidence.id),'newest check wins: a newer found_exact removes it from archive_not_found');
  });
 });
}
