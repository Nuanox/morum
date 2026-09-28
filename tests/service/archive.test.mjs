/** Service-layer (fake RPC double) tests for the two archive-check admin routes: auth is
 * required, the pending list is shaped as documented, and a POST stores a result and it
 * appears back through kb_url_report as archive_check (real shape check is tests/db). */
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {setup,now} from './helpers.mjs';

test('GET /admin/archive-checks/pending requires authentication',async()=>{
 const s=setup();
 const r=await s.handle(s.req('/admin/archive-checks/pending','GET',undefined,{auth:false}));
 assert.equal(r.status,401);
});

test('GET /admin/archive-checks/pending forwards limit and returns the pending list shape',async()=>{
 let captured;
 const evidenceId=randomUUID();
 const pending={items:[{evidence_id:evidenceId,quote:'the exact quote',url:'https://example.invalid/a',retrieved_at:now(),published_at:null,archive_url_hint:null}]};
 const s=setup({kb_archive_checks_pending:args=>{captured=args;return pending;}});
 const r=await s.handle(s.req('/admin/archive-checks/pending?limit=10','GET'));
 assert.equal(r.status,200);
 assert.equal(captured.p_query.limit,10);
 assert.equal(captured.p_actor.actor_id,s.actorId);
 assert.deepEqual((await r.json()).data,pending);
});

test('GET /admin/archive-checks/pending defaults limit to 50 and rejects an out-of-range limit',async()=>{
 let captured;
 const s=setup({kb_archive_checks_pending:args=>{captured=args;return {items:[]};}});
 const r=await s.handle(s.req('/admin/archive-checks/pending','GET'));
 assert.equal(r.status,200);assert.equal(captured.p_query.limit,50);
 const bad=await s.handle(s.req('/admin/archive-checks/pending?limit=500','GET'));
 assert.equal(bad.status,400);
});

test('POST /admin/archive-checks requires authentication',async()=>{
 const s=setup();
 const r=await s.handle(s.req('/admin/archive-checks','POST',{evidence_id:randomUUID(),state:'not_found',rule_version:'archive_check/1'},{auth:false}));
 assert.equal(r.status,401);
});

test('POST /admin/archive-checks validates and forwards the body, and stores the result',async()=>{
 let captured;
 const evidenceId=randomUUID();
 const stored={id:randomUUID(),evidence_id:evidenceId,state:'found_exact',archive_url:'https://web.archive.org/web/20230101000000id_/https://example.invalid/a',
  snapshot_at:now(),text_sha256:'a'.repeat(64),text_length:1234,rule_version:'archive_check/1',detail:null,created_at:now()};
 const s=setup({kb_record_archive_check:args=>{captured=args;return stored;}});
 const body={evidence_id:evidenceId,state:'found_exact',archive_url:stored.archive_url,snapshot_at:stored.snapshot_at,text_sha256:stored.text_sha256,text_length:1234,rule_version:'archive_check/1',detail:null};
 const r=await s.handle(s.req('/admin/archive-checks','POST',body));
 assert.equal(r.status,201);
 assert.equal(captured.p_query.evidence_id,evidenceId);
 assert.equal(captured.p_query.state,'found_exact');
 assert.equal(captured.p_actor.actor_id,s.actorId);
 assert.deepEqual((await r.json()).data,stored);
});

test('POST /admin/archive-checks rejects an unknown state before reaching the DB',async()=>{
 const s=setup();
 const r=await s.handle(s.req('/admin/archive-checks','POST',{evidence_id:randomUUID(),state:'maybe',rule_version:'archive_check/1'}));
 assert.equal(r.status,422);
 assert.equal(s.calls.some(c=>c.name==='kb_record_archive_check'),false);
});

test('POST /admin/archive-checks rejects an archive_url outside web.archive.org before reaching the DB',async()=>{
 const s=setup();
 const r=await s.handle(s.req('/admin/archive-checks','POST',{evidence_id:randomUUID(),state:'found_exact',archive_url:'https://example.com/not-wayback',rule_version:'archive_check/1'}));
 assert.equal(r.status,422);
 assert.equal(s.calls.some(c=>c.name==='kb_record_archive_check'),false);
});

// --- url-report / dossier surface archive_check additively (fake RPC only; DB-level agreement
// between the SQL and the JS quote-check port is exercised in tests/db). ---
test('url-report passes through archive_check on citations and archive_states in counts',async()=>{
 const report={
  url:'https://example.invalid/a',canonical_url:'https://example.invalid/a',sources:[],
  citations:[{evidence_id:randomUUID(),source_id:randomUUID(),target:{kind:'version',id:randomUUID()},record_id:randomUUID(),version_id:randomUUID(),title:'T',
    is_current:true,is_stable:true,stable_version_id:randomUUID(),quote:'q',explanation:'e',
    quote_check:{state:'found_exact',source_id:randomUUID()},
    archive_check:{state:'found_exact',archive_url:'https://web.archive.org/web/20230101000000id_/https://example.invalid/a',snapshot_at:now(),checked_at:now(),rule_version:'archive_check/1'},
    created_at:now()}],
  corrections:[],
  counts:{sources:0,citations:1,corrections:0,
   quote_states:{found_exact:1,found_normalized:0,found_fragments:0,not_found:0,no_text:0,no_quote:0},
   archive_states:{found:1,not_found:0,no_snapshot:0,unchecked:0}},
  truncated:{sources:false,citations:false,corrections:false},generated_at:now(),
 };
 const s=setup({kb_url_report:()=>report});
 const r=await s.handle(s.req('/url-report?url=https%3A%2F%2Fexample.invalid%2Fa','GET',undefined,{auth:false}));
 assert.equal(r.status,200);
 const data=(await r.json()).data;
 assert.equal(data.citations[0].archive_check.state,'found_exact');
 assert.equal(data.counts.archive_states.found,1);
});
