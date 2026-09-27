/** Actual PostgreSQL only. Stage13 stable_version: a second, mechanical
 * version selector alongside current_version. A public review blocks a
 * version only when it disagrees AND carries a verified basis (an internal
 * reference, or an external quote actually found in the excerpt). Agree
 * reviews, reasoning bases and unverifiable external bases never block.
 * See supabase/migrations/202609200117_stable_version.sql. */
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {testDatabaseConfig} from '../../scripts/db-test-config.mjs';
const config=testDatabaseConfig();
if(!config)test('Stable-version PostgreSQL acceptance NOT RUN',{skip:'No acknowledged disposable local PostgreSQL database'},()=>{});
else {
 const {openHarness,record,edit,ref}=await import('./stage04-support.mjs');
 const {canonicalSelector}=await import('../../.test-build/domain/text.js');
 const anon={kind:'anonymous'};

 test('Stage13 stable_version on real PostgreSQL',async t=>{
  const h=await openHarness(config);t.after(()=>h.close());const {admin,a,raw,rpc,mutate}=h;

  async function stableOf(recordId){return (await admin.query('select knowledge.stable_version($1) v',[recordId])).rows[0].v;}
  async function currentOf(recordId){return (await admin.query('select knowledge.current_version($1) v',[recordId])).rows[0].v;}
  function disagree(target,explanation='SYNTHETIC disagreement'){return {target,stance:'disagree',focus:'content',explanation,previous_review_id:null,basis:[]};}
  function agree(target,explanation='SYNTHETIC agreement'){return {target,stance:'agree',focus:'content',explanation,previous_review_id:null,basis:[]};}
  async function verifiedExternal(reviewId,found){
   const src=(await mutate(a,'source.create',{url:null,title:null,submitted_text:found?'the exact quoted passage is right here.':'Nothing like the quote is present here.',published_at:null,retrieved_at:null,rights_note:null,attributes:{},synthetic_demo:true},anon)).data;
   return (await mutate(a,'evidence.create',{target:ref('review',reviewId),basis:{kind:'external',source_id:src.id,quote:'the exact quoted passage',explanation:'SYNTHETIC verification'}},anon)).data;
  }
  async function reasoningBasis(reviewId){
   return (await mutate(a,'evidence.create',{target:ref('review',reviewId),basis:{kind:'reasoning',explanation:'SYNTHETIC reasoning only, never a verified basis'}},anon)).data;
  }
  async function internalBasis(reviewId,sourceVersionId){
   return (await mutate(a,'evidence.create',{target:ref('review',reviewId),basis:{kind:'internal',source:ref('version',sourceVersionId),explanation:'SYNTHETIC internal basis'}},anon)).data;
  }

  await t.test('no reviews: stable equals current',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC stable-version v1 body'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC stable-version v2 body'),anon)).data.version;
   assert.equal(await currentOf(v1.record_id),v2.id);
   assert.equal(await stableOf(v1.record_id),v2.id);
   const view=await rpc(a,'kb_get_version',{p_query:{id:v2.id}});
   assert.equal(view.is_current,true);assert.equal(view.is_stable,true);assert.equal(view.stable_version_id,v2.id);
  });

  await t.test('disagree WITHOUT any evidence never blocks',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC no-basis v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC no-basis v2'),anon)).data.version;
   await mutate(a,'review.create',disagree(ref('version',v2.id)),anon);
   assert.equal(await stableOf(v1.record_id),v2.id);
  });

  await t.test('disagree with a reasoning basis never blocks',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC reasoning-basis v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC reasoning-basis v2'),anon)).data.version;
   const rv=(await mutate(a,'review.create',disagree(ref('version',v2.id)),anon)).data;
   await reasoningBasis(rv.id);
   assert.equal(await stableOf(v1.record_id),v2.id);
  });

  await t.test('disagree with an external basis whose quote is NOT found never blocks',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC not-found-basis v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC not-found-basis v2'),anon)).data.version;
   const rv=(await mutate(a,'review.create',disagree(ref('version',v2.id)),anon)).data;
   const ev=await verifiedExternal(rv.id,false);
   assert.equal((await admin.query('select (knowledge.evidence_quote_check(e)->>\'state\') s from knowledge.evidence e where e.id=$1',[ev.id])).rows[0].s,'not_found');
   assert.equal(await stableOf(v1.record_id),v2.id);
  });

  await t.test('disagree with a verified external basis blocks v2; stable falls back to v1; version_view/url-report/dossier agree',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC verified-basis v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC verified-basis v2'),anon)).data.version;

   // A citation evidence targeting v1 directly, so kb_url_report has something to report on this record.
   const citeSrc=(await mutate(a,'source.create',{url:'https://example.org/stable-version-citation',title:'S',submitted_text:'v1 is cited here directly.',published_at:null,retrieved_at:null,rights_note:null,attributes:{},synthetic_demo:true},anon)).data;
   await mutate(a,'evidence.create',{target:ref('version',v1.id),basis:{kind:'external',source_id:citeSrc.id,quote:'cited here directly',explanation:'SYNTHETIC citation'}},anon);

   const rv=(await mutate(a,'review.create',disagree(ref('version',v2.id)),anon)).data;
   await verifiedExternal(rv.id,true);

   assert.equal(await stableOf(v1.record_id),v1.id);
   assert.equal(await currentOf(v1.record_id),v2.id);

   const view1=await rpc(a,'kb_get_version',{p_query:{id:v1.id}});
   assert.equal(view1.is_stable,true);assert.equal(view1.stable_version_id,v1.id);
   const view2=await rpc(a,'kb_get_version',{p_query:{id:v2.id}});
   assert.equal(view2.is_stable,false);assert.equal(view2.stable_version_id,v1.id);assert.equal(view2.is_current,true);

   const report=await rpc(a,'kb_url_report',{p_query:{url:'https://example.org/stable-version-citation'}});
   const cite=report.citations.find(c=>c.version_id===v1.id);
   assert.ok(cite);assert.equal(cite.is_stable,true);assert.equal(cite.stable_version_id,v1.id);

   const dossier=await rpc(a,'kb_dossier',{p_query:{target:ref('version',v2.id)}});
   assert.equal(dossier.version.is_stable,false);assert.equal(dossier.version.stable_version_id,v1.id);
   const dossier1=await rpc(a,'kb_dossier',{p_query:{target:ref('version',v1.id)}});
   assert.equal(dossier1.version.is_stable,true);assert.equal(dossier1.version.stable_version_id,v1.id);
  });

  await t.test('also blocking v1 leaves no stable version at all; null everywhere',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC all-blocked v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC all-blocked v2'),anon)).data.version;
   const rv2=(await mutate(a,'review.create',disagree(ref('version',v2.id)),anon)).data;
   await verifiedExternal(rv2.id,true);
   const rv1=(await mutate(a,'review.create',disagree(ref('version',v1.id),'SYNTHETIC v1 disagreement'),anon)).data;
   await verifiedExternal(rv1.id,true);

   assert.equal(await stableOf(v1.record_id),null);

   const view1=await rpc(a,'kb_get_version',{p_query:{id:v1.id}});
   assert.equal(view1.is_stable,false);assert.equal(view1.stable_version_id,null);
   const dossier=await rpc(a,'kb_dossier',{p_query:{target:ref('version',v2.id)}});
   assert.equal(dossier.version.is_stable,false);assert.equal(dossier.version.stable_version_id,null);
  });

  await t.test('a later version resolves stability by outranking the blocked ones',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC v3-recovers v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC v3-recovers v2'),anon)).data.version;
   const rv2=(await mutate(a,'review.create',disagree(ref('version',v2.id)),anon)).data;
   await verifiedExternal(rv2.id,true);
   const rv1=(await mutate(a,'review.create',disagree(ref('version',v1.id),'SYNTHETIC v1 disagreement'),anon)).data;
   await verifiedExternal(rv1.id,true);
   assert.equal(await stableOf(v1.record_id),null);

   const v3=(await mutate(a,'version.create',edit(v2,'SYNTHETIC v3-recovers v3'),anon)).data.version;
   assert.equal(await stableOf(v1.record_id),v3.id);
   assert.equal(await currentOf(v1.record_id),v3.id);
  });

  await t.test('hiding the blocking review via moderation recovers stability',async()=>{
   const agentA=await h.enroll('SYNTHETIC stable-version moderator');
   await admin.query("insert into knowledge.operators(actor_id,granted_by_note) values($1,'SYNTHETIC stable-version fixture only') on conflict do nothing",[agentA.actor.actor_id]);

   const v1=(await mutate(a,'record.create',record('SYNTHETIC moderation-recovery v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC moderation-recovery v2'),anon)).data.version;
   const rv=(await mutate(a,'review.create',disagree(ref('version',v2.id)),anon)).data;
   await verifiedExternal(rv.id,true);
   assert.equal(await stableOf(v1.record_id),v1.id);

   await raw(a,'kb_moderate',{p_actor:agentA.actor,p_query:{target:ref('review',rv.id),visibility:'hidden',reason:'SYNTHETIC hide the blocking review'}});
   assert.equal(await stableOf(v1.record_id),v2.id);

   await raw(a,'kb_moderate',{p_actor:agentA.actor,p_query:{target:ref('review',rv.id),visibility:'public',reason:'SYNTHETIC restore for test hygiene'}});
   assert.equal(await stableOf(v1.record_id),v1.id);
  });

  await t.test('a verified disagree targeting a public anchor of v2 blocks v2',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC anchor-target v1 has an anchorable word here'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC anchor-target v2 has an anchorable word here'),anon)).data.version;
   const start=v2.body_text.indexOf('anchorable'),selector=canonicalSelector(v2.body_text,start,start+'anchorable'.length);
   const anchor=(await mutate(a,'anchor.create',{version_id:v2.id,body_sha256:v2.body_sha256,selector},anon)).data;
   const rv=(await mutate(a,'review.create',disagree(ref('anchor',anchor.id),'SYNTHETIC anchor disagreement'),anon)).data;
   await verifiedExternal(rv.id,true);
   assert.equal(await stableOf(v1.record_id),v1.id);
  });

  await t.test('agree reviews never matter, even with a verified basis',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC agree-never v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC agree-never v2'),anon)).data.version;
   const rv=(await mutate(a,'review.create',agree(ref('version',v2.id)),anon)).data;
   await verifiedExternal(rv.id,true);
   assert.equal(await stableOf(v1.record_id),v2.id);
  });

  await t.test('an internal verified basis also blocks',async()=>{
   const v1=(await mutate(a,'record.create',record('SYNTHETIC internal-basis v1'),anon)).data.version;
   const v2=(await mutate(a,'version.create',edit(v1,'SYNTHETIC internal-basis v2'),anon)).data.version;
   const other=(await mutate(a,'record.create',record('SYNTHETIC internal-basis premise'),anon)).data.version;
   const rv=(await mutate(a,'review.create',disagree(ref('version',v2.id)),anon)).data;
   await internalBasis(rv.id,other.id);
   assert.equal(await stableOf(v1.record_id),v1.id);
  });
 });
}
