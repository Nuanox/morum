import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {setup,now,expires} from './helpers.mjs';
import {parseDeclaredAgent} from '../../.test-build/server/service/transport.js';
import {renderDossierText} from '../../.test-build/server/service/dossier-text.js';

const id=randomUUID();
const emptyPage=()=>({items:[],snapshot_id:randomUUID(),scan_index:0,has_more:false,snapshot_at:now(),snapshot_expires_at:expires(),truncated:false});

// --- /url-report ---
test('url-report requires url',async()=>{const s=setup();const r=await s.handle(s.req('/url-report','GET',undefined,{auth:false}));assert.equal(r.status,400);});
test('url-report rejects non-http url',async()=>{const s=setup();const r=await s.handle(s.req('/url-report?url=ftp%3A%2F%2Fx','GET',undefined,{auth:false}));const v=await r.json();assert.equal(r.status,400);assert.equal(v.error.code,'VALIDATION_FAILED');});
test('url-report passes url through to kb_url_report',async()=>{
 let captured;
 const report={url:'https://example.invalid/a',canonical_url:null,sources:[],citations:[],corrections:[],counts:{sources:0,citations:0,corrections:0,quote_states:{found_exact:0,found_normalized:0,found_fragments:0,not_found:0,no_text:0,no_quote:0}},truncated:{sources:false,citations:false,corrections:false},generated_at:now()};
 const s=setup({kb_url_report:args=>{captured=args;return report;}});
 const r=await s.handle(s.req('/url-report?url=https%3A%2F%2Fexample.invalid%2Fa','GET',undefined,{auth:false}));
 assert.equal(r.status,200);assert.equal(captured.p_query.url,'https://example.invalid/a');
 // Roadmap 2.11 (extended): first_lookup_at/check_guide are additive; kb_record_lookup isn't
 // stubbed here, so recording fails non-fatally and first_lookup_at stays null.
 assert.deepEqual((await r.json()).data,{...report,first_lookup_at:null,check_guide:'/skill.md#check-before-you-cite-read-before-you-write'});
});

test('url-report records a lookup (hit/miss) and returns first_lookup_at from kb_record_lookup',async()=>{
 const report={url:'https://example.invalid/b',canonical_url:'https://example.invalid/b',sources:[],citations:[],corrections:[],counts:{sources:1,citations:0,corrections:0,quote_states:{found_exact:0,found_normalized:0,found_fragments:0,not_found:0,no_text:0,no_quote:0}},truncated:{sources:false,citations:false,corrections:false},generated_at:now()};
 let captured;
 const s=setup({
  kb_url_report:()=>report,
  kb_record_lookup:args=>{captured=args;return {id:'11111111-1111-1111-1111-111111111111',first_lookup_at:'2026-01-01T00:00:00Z'};},
 });
 const r=await s.handle(s.req('/url-report?url=https%3A%2F%2Fexample.invalid%2Fb','GET',undefined,{auth:false,headers:{'morum-agent':'operator=test-op'}}));
 assert.equal(r.status,200);
 const data=(await r.json()).data;
 assert.equal(data.first_lookup_at,'2026-01-01T00:00:00Z');
 assert.equal(data.check_guide,'/skill.md#check-before-you-cite-read-before-you-write');
 assert.equal(captured.p_query.kind,'url_report');
 assert.equal(captured.p_query.url_input,'https://example.invalid/b');
 assert.equal(captured.p_query.hit,true); // counts.sources>=1
 assert.equal(captured.p_query.operator,'test-op');
 assert.equal(captured.p_query.agent_key_id,null); // unauthenticated GET
});

// --- /dossier ---
function fakeDossier(overrides={}){
 return {
  version:{id,record_id:randomUUID(),version_no:3,title:'A long title',is_current:true,current_version_id:id,version_count:3,parent_version_id:null,created_at:now(),created_by:null,attributes:{},synthetic_demo:false,body_sha256:'a'.repeat(64),body_text:'x'.repeat(5000)},
  corrections:[],
  counterarguments:{reviews:[],contradicts:[],groups:{keyed_actors:0,anonymous_reviews:0,declared_model_families:0}},
  agreements:{agree_keyed:0,agree_anonymous:0,reviews:[],truncated:false},
  evidence:[],
  premises:[],
  meanings:[],
  related:[{relation_id:randomUUID(),predicate:'related_to',direction:'out',other:{kind:'version',id:randomUUID()},title:'R1',explanation:'e1',created_at:now()},
            {relation_id:randomUUID(),predicate:'related_to',direction:'out',other:{kind:'version',id:randomUUID()},title:'R2',explanation:'e2',created_at:now()},
            {relation_id:randomUUID(),predicate:'related_to',direction:'out',other:{kind:'version',id:randomUUID()},title:'R3',explanation:'e3',created_at:now()}],
  omitted:{corrections:0,counterarguments:0,contradicts:0,evidence:0,premises:0,meanings:0,related:0},
  blind:false,
  generated_at:now(),
  ...overrides,
 };
}
test('dossier json passes blind through and returns data',async()=>{
 let captured;const dossier=fakeDossier();
 const s=setup({kb_dossier:args=>{captured=args;return dossier;}});
 const r=await s.handle(s.req(`/dossier?target_kind=version&target_id=${id}&blind=true`,'GET',undefined,{auth:false}));
 assert.equal(r.status,200);assert.equal(captured.p_query.blind,true);assert.equal(captured.p_query.target.kind,'version');
 // claim_reviews (roadmap 2.9) is additive: same RPC data plus that one extra field.
 assert.deepEqual((await r.json()).data,{...dossier,claim_reviews:[]});
});
test('dossier text renders header, data envelopes, omitted section and truncated body',async()=>{
 const dossier=fakeDossier();
 const s=setup({kb_dossier:()=>dossier});
 const r=await s.handle(s.req(`/dossier?target_kind=version&target_id=${id}&format=text&budget=1200`,'GET',undefined,{auth:false}));
 assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'text/plain; charset=utf-8');
 const text=await r.text();
 assert(text.startsWith('MORUM DOSSIER v1'));
 assert(text.includes('<<<DATA'));
 assert(text.includes('[OMITTED]'));
 assert(text.includes('related'));
 assert(text.includes('[…truncated'));
});
test('dossier text reports blind counterarguments line',async()=>{
 const dossier=fakeDossier({blind:true,counterarguments:{reviews:[],contradicts:[],groups:{keyed_actors:2,anonymous_reviews:1,declared_model_families:1}}});
 const s=setup({kb_dossier:()=>dossier});
 const r=await s.handle(s.req(`/dossier?target_kind=version&target_id=${id}&format=text`,'GET',undefined,{auth:false}));
 const text=await r.text();
 assert(text.includes('[COUNTERARGUMENTS hidden by blind=true | keyed 2 · anonymous 1]'));
});
test('dossier rejects non-version target_kind',async()=>{const s=setup();const r=await s.handle(s.req(`/dossier?target_kind=source&target_id=${id}`,'GET',undefined,{auth:false}));assert.equal(r.status,422);});

// --- /dossier claim_reviews (roadmap 2.9) ---
// This harness always builds requests against http://localhost (see req() in helpers.mjs), which
// is not a *.vercel.app host, so the origin is expected to pass through unchanged here; the
// canonical-origin collapse for a *.vercel.app preview host is unit-tested directly in
// tests/unit/claimreview.test.mjs (publicOrigin), against the request's real origin/hostname.
test('dossier json includes claim_reviews built from counterargument reviews; text format is unchanged',async()=>{
 const reviewId=randomUUID();
 const dossier=fakeDossier({counterarguments:{
  reviews:[{id:reviewId,stance:'disagree',focus:'content',on:{kind:'version',id},created_by:randomUUID(),created_at:now(),declared:null,explanation:'Synthetic disagreement'}],
  contradicts:[],groups:{keyed_actors:1,anonymous_reviews:0,declared_model_families:0},
 }});
 const s=setup({kb_dossier:()=>dossier});
 const jsonRes=await s.handle(s.req(`/dossier?target_kind=version&target_id=${id}`,'GET',undefined,{auth:false}));
 assert.equal(jsonRes.status,200);
 const body=await jsonRes.json();
 assert.equal(body.data.claim_reviews.length,1);
 assert.equal(body.data.claim_reviews[0].url,`http://localhost/versions/${id}#review-${reviewId}`);
 assert.equal(body.data.claim_reviews[0].reviewRating.alternateName,'Disputed');
 assert.doesNotMatch(JSON.stringify(body.data.claim_reviews),/ratingValue/);
 // Every other field from the RPC is passed through unchanged alongside the additive field.
 for(const key of Object.keys(dossier))assert.deepEqual(body.data[key],dossier[key]);

 const textRes=await s.handle(s.req(`/dossier?target_kind=version&target_id=${id}&format=text`,'GET',undefined,{auth:false}));
 const text=await textRes.text();
 assert.doesNotMatch(text,/claim_reviews|ClaimReview/);
});
test('dossier json claim_reviews author is anonymous when the review has no created_by',async()=>{
 const reviewId=randomUUID();
 const dossier=fakeDossier({counterarguments:{
  reviews:[{id:reviewId,stance:'needs_review',focus:'evidence_support',on:{kind:'version',id},created_by:null,created_at:now(),declared:null,explanation:'Synthetic'}],
  contradicts:[],groups:{keyed_actors:0,anonymous_reviews:1,declared_model_families:0},
 }});
 const s=setup({kb_dossier:()=>dossier});
 const r=await s.handle(s.req(`/dossier?target_kind=version&target_id=${id}`,'GET',undefined,{auth:false}));
 const body=await r.json();
 assert.equal(body.data.claim_reviews[0].author.name,'Morum anonymous reviewer');
 assert.equal(body.data.claim_reviews[0].reviewRating.alternateName,'Needs review');
});
test('dossier json includes a Supported claim_review from agreements.reviews, with anchor exact as claimReviewed',async()=>{
 const reviewId=randomUUID();
 const dossier=fakeDossier({agreements:{agree_keyed:1,agree_anonymous:0,reviews:[
  {id:reviewId,stance:'agree',focus:'content',on:{kind:'anchor',id:randomUUID(),exact:'the anchored claim text',start:10,end:34},created_by:randomUUID(),created_at:now(),declared:null,explanation:'Synthetic agreement'},
 ],truncated:false}});
 const s=setup({kb_dossier:()=>dossier});
 const r=await s.handle(s.req(`/dossier?target_kind=version&target_id=${id}`,'GET',undefined,{auth:false}));
 assert.equal(r.status,200);
 const body=await r.json();
 assert.equal(body.data.claim_reviews.length,1);
 assert.equal(body.data.claim_reviews[0].url,`http://localhost/versions/${id}#review-${reviewId}`);
 assert.equal(body.data.claim_reviews[0].reviewRating.alternateName,'Supported');
 assert.equal(body.data.claim_reviews[0].claimReviewed,'the anchored claim text');
 assert.deepEqual(body.data.agreements.reviews,dossier.agreements.reviews);
 assert.equal(body.data.agreements.truncated,false);
});

// --- /attention ---
test('attention validates reasons',async()=>{const s=setup();const r=await s.handle(s.req('/attention?reasons=bogus','GET',undefined,{auth:false}));assert.equal(r.status,422);});
test('attention rejects out-of-range limit',async()=>{const s=setup();const r=await s.handle(s.req('/attention?limit=999','GET',undefined,{auth:false}));assert.equal(r.status,400);});
test('attention forwards limit and seed',async()=>{
 let captured;const list={items:[],counts:{},generated_at:now()};
 const s=setup({kb_attention:args=>{captured=args;return list;}});
 const r=await s.handle(s.req('/attention?limit=5&seed=abc123','GET',undefined,{auth:false}));
 assert.equal(r.status,200);assert.equal(captured.p_query.limit,5);assert.equal(captured.p_query.seed,'abc123');
});
test('attention defaults limit to 20',async()=>{
 let captured;const s=setup({kb_attention:args=>{captured=args;return {items:[],counts:{},generated_at:now()};}});
 const r=await s.handle(s.req('/attention','GET',undefined,{auth:false}));
 assert.equal(r.status,200);assert.equal(captured.p_query.limit,20);
});

// --- /work-requests ---
test('GET /work-requests uses kb_list_work_requests',async()=>{
 let called=false;const s=setup({kb_list_work_requests:()=>{called=true;return emptyPage();}});
 const r=await s.handle(s.req('/work-requests','GET',undefined,{auth:false}));assert.equal(r.status,200);assert(called);
});
test('anonymous POST /work-requests reaches kb_create_work_request as anonymous',async()=>{
 let captured;const s=setup({kb_create_work_request:args=>{captured=args;return {data:{id,title:'t',description:'d',target:null,suggested_query:null,status:'open',revision:1,created_by:id,assigned_to:null,created_at:now(),updated_at:now(),resolution_refs:[]},replayed:false};}});
 const body={title:'Need help',description:'SYNTHETIC description',target:null,suggested_query:null};
 const r=await s.handle(s.req('/work-requests','POST',body,{auth:false,headers:{'idempotency-key':randomUUID()}}));
 assert.equal(r.status,201);assert.equal(captured.p_context.actor.kind,'anonymous');
});
test('anonymous POST /work-requests/:id is rejected without reaching the DB',async()=>{
 const s=setup();
 const r=await s.handle(s.req(`/work-requests/${id}`,'POST',{expected_revision:1,action:'claim',reason:'r',resolution_refs:[]},{auth:false,headers:{'idempotency-key':randomUUID()}}));
 assert.equal(r.status,401);assert(!s.calls.some(c=>c.name==='kb_update_work_request'));
});
test('keyed POST /work-requests/:id calls kb_update_work_request with path id in p_command',async()=>{
 let captured;const s=setup({kb_update_work_request:args=>{captured=args;return {data:{id,title:'t',description:'d',target:null,suggested_query:null,status:'in_progress',revision:2,created_by:id,assigned_to:id,created_at:now(),updated_at:now(),resolution_refs:[]},replayed:false};}});
 const body={expected_revision:1,action:'claim',reason:'SYNTHETIC claim',resolution_refs:[]};
 const r=await s.handle(s.req(`/work-requests/${id}`,'POST',body,{headers:{'idempotency-key':randomUUID()}}));
 assert.equal(r.status,201);assert.equal(captured.p_command.work_request_id,id);
});

// --- Morum-Agent header ---
test('Morum-Agent header is parsed into p_context.agent on POST /records',async()=>{
 let captured;const s=setup({kb_create_record:args=>{captured=args;return {data:{version:{id}},replayed:false};}});
 const body={body_text:'SYNTHETIC body text for header test'};
 const r=await s.handle(s.req('/records','POST',body,{auth:false,headers:{'idempotency-key':randomUUID(),'morum-agent':'model="claude-x"; harness="cli"'}}));
 assert.equal(r.status,201);assert.deepEqual(captured.p_context.agent,{model:'claude-x',harness:'cli'});
});
test('malformed Morum-Agent header is ignored entirely',async()=>{
 let captured;const s=setup({kb_create_record:args=>{captured=args;return {data:{version:{id}},replayed:false};}});
 const body={body_text:'SYNTHETIC body text for malformed header'};
 const r=await s.handle(s.req('/records','POST',body,{auth:false,headers:{'idempotency-key':randomUUID(),'morum-agent':'not-a-valid-header;;;'}}));
 assert.equal(r.status,201);assert.equal(captured.p_context.agent,undefined);
});
test('absent Morum-Agent header means no agent key at all',async()=>{
 let captured;const s=setup({kb_create_record:args=>{captured=args;return {data:{version:{id}},replayed:false};}});
 const body={body_text:'SYNTHETIC body text for absent header'};
 const r=await s.handle(s.req('/records','POST',body,{auth:false,headers:{'idempotency-key':randomUUID()}}));
 assert.equal(r.status,201);assert(!Object.hasOwn(captured.p_context,'agent'));
});
test('request_hash is identical with and without the header',async()=>{
 const hashes=[];
 const s=setup({kb_create_record:args=>{hashes.push(args.p_context.request_hash);return {data:{version:{id}},replayed:false};}});
 const body={body_text:'SYNTHETIC body text for hash stability'};
 await s.handle(s.req('/records','POST',body,{auth:false,headers:{'idempotency-key':randomUUID()}}));
 await s.handle(s.req('/records','POST',body,{auth:false,headers:{'idempotency-key':randomUUID(),'morum-agent':'model="x"'}}));
 assert.equal(hashes[0],hashes[1]);
});

// --- parseDeclaredAgent unit tests ---
test('parseDeclaredAgent: null/empty -> undefined',()=>{assert.equal(parseDeclaredAgent(null),undefined);assert.equal(parseDeclaredAgent(''),undefined);assert.equal(parseDeclaredAgent('   '),undefined);});
test('parseDeclaredAgent: subset of fields, comma separated, unquoted',()=>{assert.deepEqual(parseDeclaredAgent('model=gpt, operator=acme'),{model:'gpt',operator:'acme'});});
test('parseDeclaredAgent: too-long value is rejected wholesale',()=>{assert.equal(parseDeclaredAgent(`model="${'x'.repeat(81)}"`),undefined);});
test('parseDeclaredAgent: unknown field rejected wholesale',()=>{assert.equal(parseDeclaredAgent('model="a"; bogus="b"'),undefined);});
test('parseDeclaredAgent: control characters rejected wholesale',()=>{assert.equal(parseDeclaredAgent('model="a\nb"'),undefined);});

// --- renderDossierText unit tests ---
test('renderDossierText: empty sections print [OMITTED] none and no dropped-line headers',()=>{
 const d=fakeDossier({related:[],corrections:[],evidence:[],premises:[],meanings:[]});
 const text=renderDossierText(d,6000);
 assert(text.includes('[OMITTED] none'));
 assert(text.includes('[CORRECTIONS 0]'));
});
test('renderDossierText: exactly-at-budget does not crash and stays deterministic',()=>{
 const d=fakeDossier();
 const a=renderDossierText(d,1000);const b=renderDossierText(d,1000);
 assert.equal(a,b);
});
