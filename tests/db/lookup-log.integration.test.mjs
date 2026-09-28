/** Actual PostgreSQL only. Stage18 lookup_log (roadmap 2.11, extended):
 *  - public.kb_record_lookup validates its input and returns first_lookup_at as the MIN(created_at)
 *    over every row sharing the same canonical_url, including the one just inserted;
 *  - knowledge.lookups is append-only (no UPDATE/DELETE for any role);
 *  - public.kb_lookup_metrics is operator-only and computes hit rate / write-back rate / the
 *    per-operator breakdown correctly, including the anonymous grouping and the 30-minute window.
 * See supabase/migrations/202609200122_lookup_log.sql. */
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {testDatabaseConfig} from '../../scripts/db-test-config.mjs';
const config=testDatabaseConfig();
if(!config)test('Lookup-log PostgreSQL acceptance NOT RUN',{skip:'No acknowledged disposable local PostgreSQL database'},()=>{});
else {
 const {openHarness,code}=await import('./stage04-support.mjs');

 test('Stage18 lookup_log on real PostgreSQL',async t=>{
  const h=await openHarness(config);t.after(()=>h.close());const {admin,a,raw,enroll}=h;

  const operator=await enroll('SYNTHETIC lookup-log operator');
  await admin.query("insert into knowledge.operators(actor_id,granted_by_note) values($1,'SYNTHETIC lookup-log fixture only') on conflict do nothing",[operator.actor.actor_id]);
  const nonOperator=await enroll('SYNTHETIC lookup-log non-operator');

  await t.test('kb_record_lookup rejects an unknown kind and a malformed url_input',async()=>{
   await assert.rejects(raw(a,'kb_record_lookup',{p_query:{kind:'not_a_kind',url_input:'https://example.invalid/x',hit:false}}));
   await assert.rejects(raw(a,'kb_record_lookup',{p_query:{kind:'url_report',url_input:'not a url',hit:false}}));
   await assert.rejects(raw(a,'kb_record_lookup',{p_query:{kind:'url_report',url_input:'https://example.invalid/x',hit:'not a boolean'}}));
  });

  await t.test('kb_record_lookup inserts a row and returns first_lookup_at as the earliest row for that canonical_url',async()=>{
   const slug=randomUUID();
   const url=`https://example.invalid/first-lookup-${slug}`;
   const row1=await raw(a,'kb_record_lookup',{p_query:{kind:'url_report',url_input:url,hit:false,operator:'op-a',harness:'ci',model:'m1'}});
   assert.ok(row1.id);assert.ok(row1.first_lookup_at);
   // A second lookup at the same canonical URL (case/scheme-equivalent) reports the SAME first_lookup_at.
   const row2=await raw(a,'kb_record_lookup',{p_query:{kind:'url_report',url_input:`HTTP://EXAMPLE.INVALID/first-lookup-${slug}`,hit:true}});
   assert.equal(row2.first_lookup_at,row1.first_lookup_at);
  });

  await t.test('agent_key_id and request_id round-trip, and absent optional fields store as null',async()=>{
   const url=`https://example.invalid/optional-fields-${randomUUID()}`;
   const requestId=randomUUID();
   await raw(a,'kb_record_lookup',{p_query:{kind:'check',url_input:url,hit:true,agent_key_id:operator.actor.actor_id,request_id:requestId}});
   const stored=await admin.query('select operator,harness,model,agent_key_id,request_id from knowledge.lookups where url_input=$1',[url]);
   assert.equal(stored.rows[0].operator,null);
   assert.equal(stored.rows[0].agent_key_id,operator.actor.actor_id);
   assert.equal(stored.rows[0].request_id,requestId);
  });

  await t.test('knowledge.lookups is append-only: no role can UPDATE or DELETE a row',async()=>{
   const url=`https://example.invalid/immutable-${randomUUID()}`;
   await raw(a,'kb_record_lookup',{p_query:{kind:'url_report',url_input:url,hit:false}});
   await assert.rejects(admin.query('update knowledge.lookups set hit=true where url_input=$1',[url]));
   await assert.rejects(admin.query('delete from knowledge.lookups where url_input=$1',[url]));
  });

  await t.test('non-operator cannot call kb_lookup_metrics',async()=>{
   await assert.rejects(raw(a,'kb_lookup_metrics',{p_actor:nonOperator.actor,p_query:{}}),code('FORBIDDEN'));
  });

  await t.test('kb_lookup_metrics: hits, write-backs (in/out of the 30-minute window) and anonymous grouping',async()=>{
   // Fixture: three operators (op-x, op-y, and one anonymous/no-declared-operator lookup keyed
   // only by agent_key_id), a mix of hits and misses, one write-back inside 30 minutes, one just
   // outside it, so the SQL boundary itself is exercised, not just presence/absence.
   const now=new Date();
   const t0=new Date(now.getTime()-10*60*1000); // 10 minutes ago: inside any 30-day window
   const urlHit=`https://example.invalid/metrics-hit-${randomUUID()}`;
   const urlWbIn=`https://example.invalid/metrics-wb-in-${randomUUID()}`;
   const urlWbOut=`https://example.invalid/metrics-wb-out-${randomUUID()}`;
   const urlAnon=`https://example.invalid/metrics-anon-${randomUUID()}`;
   const agentKeyId=randomUUID();

   async function insertLookup({kind,url,hit,op=null,akid=null,createdAt}){
    await admin.query(
     `insert into knowledge.lookups(created_at,kind,url_input,canonical_url,hit,operator,agent_key_id)
      values($1,$2,$3,knowledge.canonical_url($3),$4,$5,$6)`,
     [createdAt,kind,url,hit,op,akid]
    );
   }

   // op-x: one hit, no misses.
   await insertLookup({kind:'url_report',url:urlHit,hit:true,op:'op-x',createdAt:t0});
   // op-y: one empty lookup followed by a check on the SAME url within 30 minutes -> a write-back.
   await insertLookup({kind:'url_report',url:urlWbIn,hit:false,op:'op-y',createdAt:t0});
   await insertLookup({kind:'check',url:urlWbIn,hit:false,op:'op-y',createdAt:new Date(t0.getTime()+10*60*1000)});
   // op-y: a second empty lookup whose only check is 40 minutes later -> NOT a write-back.
   await insertLookup({kind:'url_report',url:urlWbOut,hit:false,op:'op-y',createdAt:t0});
   await insertLookup({kind:'check',url:urlWbOut,hit:false,op:'op-y',createdAt:new Date(t0.getTime()+40*60*1000)});
   // anonymous (no declared operator): an empty lookup + a same-agent-key check within the window.
   await insertLookup({kind:'url_report',url:urlAnon,hit:false,op:null,akid:agentKeyId,createdAt:t0});
   await insertLookup({kind:'check',url:urlAnon,hit:false,akid:agentKeyId,createdAt:new Date(t0.getTime()+5*60*1000)});

   const metrics=await raw(a,'kb_lookup_metrics',{p_actor:operator.actor,p_query:{days:1}});
   assert.equal(metrics.window_days,1);
   // Top-level totals are aggregated over every operator (including the earlier subtests' rows
   // above, whose operator is null), so only bound them loosely here; the exact-count assertions
   // below are on 'op-x'/'op-y', tags unique to this subtest.
   assert(metrics.lookups>=4);assert(metrics.hits>=1);assert(metrics.write_backs>=2);
   assert(metrics.distinct_operators>=2);
   assert(metrics.distinct_agent_keys>=1);

   const byOperator=new Map(metrics.operators.map(o=>[o.operator,o]));
   assert.equal(byOperator.get('op-x').hits,1);
   assert.equal(byOperator.get('op-x').write_backs,0);
   const opY=byOperator.get('op-y');
   assert.equal(opY.lookups,2);assert.equal(opY.hits,0);assert.equal(opY.checks,2);assert.equal(opY.write_backs,1);
   assert.equal(opY.write_back_rate,0.5);
   const anonGroup=byOperator.get('(anonymous)');
   assert.ok(anonGroup,'anonymous lookups must be grouped under "(anonymous)"');
   assert(anonGroup.write_backs>=1);
  });
 });
}
