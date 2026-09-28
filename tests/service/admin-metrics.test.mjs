/** Service-layer (fake RPC double) tests for GET /admin/metrics/lookups (roadmap 2.11, extended):
 * auth is required, days is bounded/defaulted, and the RPC's shape is forwarded through unchanged
 * (the real aggregation is exercised in tests/db/lookup-log.integration.test.mjs). */
import test from 'node:test';import assert from 'node:assert/strict';
import {setup} from './helpers.mjs';

test('GET /admin/metrics/lookups requires authentication',async()=>{
 const s=setup();
 const r=await s.handle(s.req('/admin/metrics/lookups','GET',undefined,{auth:false}));
 assert.equal(r.status,401);
});

test('GET /admin/metrics/lookups defaults days to 30 and forwards p_actor',async()=>{
 let captured;
 const metrics={window_days:30,lookups:0,hits:0,hit_rate:null,operators:[],distinct_operators:0,distinct_agent_keys:0,write_backs:0,write_back_rate:null};
 const s=setup({kb_lookup_metrics:args=>{captured=args;return metrics;}});
 const r=await s.handle(s.req('/admin/metrics/lookups','GET'));
 assert.equal(r.status,200);
 assert.equal(captured.p_query.days,30);
 assert.equal(captured.p_actor.actor_id,s.actorId);
 assert.deepEqual((await r.json()).data,metrics);
});

test('GET /admin/metrics/lookups forwards an explicit days and rejects an out-of-range value',async()=>{
 let captured;
 const s=setup({kb_lookup_metrics:args=>{captured=args;return {window_days:7,lookups:0,hits:0,hit_rate:null,operators:[],distinct_operators:0,distinct_agent_keys:0,write_backs:0,write_back_rate:null};}});
 const r=await s.handle(s.req('/admin/metrics/lookups?days=7','GET'));
 assert.equal(r.status,200);assert.equal(captured.p_query.days,7);
 const bad=await s.handle(s.req('/admin/metrics/lookups?days=400','GET'));
 assert.equal(bad.status,400);
});
