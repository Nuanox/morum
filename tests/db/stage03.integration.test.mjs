/** Actual PostgreSQL + actual Request/Response handler; no DB/HTTP success substitute. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {testDatabaseConfig,assertTestDatabase} from '../../scripts/db-test-config.mjs';
import {latestMigrationTag} from '../../scripts/migrations.mjs';
const config=testDatabaseConfig();
if(!config){test('Stage03 PostgreSQL integration NOT RUN',{skip:'No acknowledged disposable local PostgreSQL; no substitute database'},()=>{});}
else {
 const {Pool}=await import('pg');
 const {AgentAuth}=await import('../../.test-build/server/service/auth.js');
 const {RateLimiter}=await import('../../.test-build/server/service/rate-limit.js');
 const {Embeddings,IndexWorker}=await import('../../.test-build/server/service/embeddings.js');
 const {Retrieval}=await import('../../.test-build/server/service/retrieval.js');
 const {KnowledgeRepository}=await import('../../.test-build/server/db/knowledge-repository.js');
 const {CursorCodec}=await import('../../.test-build/server/db/cursor.js');
 const {createHandler}=await import('../../.test-build/server/service/http.js');
 const {verifyWebBotAuth}=await import('../../.test-build/server/service/web-bot-auth.js');
 const {mapDatabaseError}=await import('../../.test-build/domain/errors.js');
 const {NuanoxClient}=await import('../../examples/nuanox-client.mjs');
 const {protocolFlow}=await import('../../examples/protocol-flow.mjs');
 test('Stage03 real database functional acceptance',async t=>{
  const pool=new Pool({connectionString:config.connectionString,max:4,connectionTimeoutMillis:5000});let dir;
  try{
   const c=await pool.connect();try{await assertTestDatabase(c,config);const r=(await c.query("select migration_tag,contract_version from knowledge.schema_info where singleton")).rows[0];assert.equal(r.migration_tag,await latestMigrationTag());assert.equal(r.contract_version,'2.1.0');}finally{c.release();}
   const db={async call(name,args){assert.match(name,/^kb_[a-z_]+$/);const entries=Object.entries(args);for(const[k]of entries)assert.match(k,/^p_[a-z_]+$/);const c=await pool.connect();try{await c.query('begin');await c.query('set local role service_role');await c.query("set local statement_timeout='15s'");const binds=entries.map(([key],i)=>`${key} => $${i+1}::jsonb`).join(',');const r=await c.query(`select public.${name}(${binds}) as value`,entries.map(([,v])=>JSON.stringify(v)));await c.query('commit');return r.rows[0].value;}catch(e){await c.query('rollback');throw mapDatabaseError(e);}finally{c.release();}}};
   const secret='isolated-test-not-a-deployed-secret-'.repeat(2),cursors=new CursorCodec(secret),rates=new RateLimiter(db,secret),auth=new AgentAuth(db,secret,true);
   const embeddings=new Embeddings({provider:'disabled',budgetApproved:false,dataSharingApproved:false,dailyTokenCap:0,requestTokenCap:0,timeoutMs:100},rates,()=>{throw Error('Provider calls forbidden in this DB suite');});
   const services={db,repo:new KnowledgeRepository(db,cursors),auth,rates,embeddings,retrieval:new Retrieval(db,cursors,embeddings),worker:new IndexWorker(db,embeddings),verifySignature:(request)=>verifyWebBotAuth(request)};
   const handler=createHandler(()=>services),transport=(url,init)=>handler(new Request(url,init));
   dir=await mkdtemp(join(tmpdir(),'nuanox-real-db-'));const a=await NuanoxClient.initialize('http://localhost',join(dir,'a','credential.json'),transport),b=await NuanoxClient.initialize('http://localhost',join(dir,'b','credential.json'),transport);let result;
   await t.test('two ownerless agents write, replay, preserve a revision, attach meaning/evidence/review and query context',async()=>{result=await protocolFlow(a,b,{legacyKeyed:true});assert.notEqual(result.agents[0],result.agents[1]);assert.equal(result.replayed,true);assert.equal(result.replay_version_id,result.root.id);assert.equal(result.oldView.version.body_text,result.root.body_text);assert.equal(result.child.parent_version_id,result.root.id);assert.equal(result.source.submitted_text.includes('\r\n'),true);assert.equal(result.annotation.anchor_id,result.anchor.id);assert.equal(result.evidence.submission_state,'submitted');assert.equal(result.childView.review_summary.effective_reviewers,0);assert.ok(result.context.items.some(x=>x.reason==='correction'));assert.ok(result.search.hits.length);assert.equal(result.search.status.mode,'keyword_only');assert.equal(result.search.status.reason,'disabled');});
   if(!result)return;
   await t.test('ownerless identity is real, not a hidden fake human',async()=>{const r=await pool.query('select a.kind,a.state,g.owner_actor_id from knowledge.actors a join knowledge.agents g on g.actor_id=a.id where a.id=any($1::uuid[])',[result.agents]);assert.equal(r.rowCount,2);for(const row of r.rows)assert.deepEqual(row,{kind:'agent',state:'active',owner_actor_id:null});});
   await t.test('fresh client sees committed content and private review head',async()=>{const reload=await NuanoxClient.initialize(a.origin,a.path,transport);assert.equal((await reload.request(`/versions/${result.child.id}`)).data.version.id,result.child.id);assert.equal((await b.request(`/review-head?target_kind=version&target_id=${result.root.id}&focus=content`,{authenticate:true})).data.review_id,result.review.id);});
   await t.test('raw conditional reads preserve Unicode and enforce visibility before cache',async()=>{const path=`http://localhost/api/v2/versions/${result.root.id}/raw`;const raw=await handler(new Request(path));assert.equal(await raw.text(),result.root.body_text);const tag=raw.headers.get('etag');assert.equal((await handler(new Request(path,{headers:{'if-none-match':tag}}))).status,304);
    await pool.query("insert into knowledge.operators(actor_id,granted_by_note) values($1,'Isolated Stage03 database test only') on conflict do nothing",[result.agents[0]]);
    await a.request('/admin/moderation',{method:'POST',body:{target:{kind:'version',id:result.root.id},visibility:'hidden',reason:'SYNTHETIC visibility regression'}});
    const hidden=await handler(new Request(path,{headers:{'if-none-match':tag}}));assert.notEqual(hidden.status,304);assert.ok(hidden.status>=400);
    await a.request('/admin/moderation',{method:'POST',body:{target:{kind:'version',id:result.root.id},visibility:'public',reason:'Restore synthetic test visibility'}});
   });
   await t.test('ordinary contributor cannot perform operator mutations',async()=>{await assert.rejects(b.request('/admin/maintenance',{method:'POST',body:{}}),e=>e.status===403);});
   await t.test('work-management RPC is executable by service role again since Stage07 anonymous work_request.create',async()=>{const c=await pool.connect();try{await c.query('begin');await c.query('set local role service_role');await c.query("select public.kb_list_work_requests('{}'::jsonb)");}finally{await c.query('rollback');c.release();}});
   await t.test('atomic shared counter allows exactly the capacity under concurrency',async()=>{const bucket='test:'+crypto.randomUUID();const calls=await Promise.all(Array.from({length:8},()=>db.call('kb_rate_limit',{p_query:{bucket,capacity:3,window_seconds:60,cost:1}})));assert.equal(calls.filter(x=>x.allowed).length,3);});
   await t.test('revoked credential cannot write and repeated self-revoke is safe',async()=>{await b.write('/agents/self/key/revoke',{},'revoke');await b.write('/agents/self/key/revoke',{},'revoke');await assert.rejects(b.request('/agents/self',{authenticate:true}),e=>e.code==='KEY_REVOKED');await assert.rejects(b.enroll('SYNTHETIC Stage03 agent B','Independent protocol credential'));});
   await t.test('secrets are absent from persisted receipt and audit JSON',async()=>{const rows=await pool.query("select (select jsonb_agg(to_jsonb(e)) from knowledge.enrollment_receipts e)::text as enroll,(select jsonb_agg(to_jsonb(r)) from knowledge.mutation_receipts r)::text as receipts");const text=JSON.stringify(rows.rows);assert.ok(!text.includes(a.credential));assert.ok(!text.includes(b.credential));});
  }finally{await pool.end();if(dir)await rm(dir,{recursive:true,force:true});}
 });
}
