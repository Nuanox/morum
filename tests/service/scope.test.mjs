/** Guard current product scope, not historical discussion/baseline snapshots. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';import {ROUTES} from '../../.test-build/server/service/routes.js';
const text=p=>readFile(new URL('../../'+p,import.meta.url),'utf8');
// Canonical contracts and the installable skill live beside this repository; compare them only when present.
const external=p=>readFile(new URL('../../../'+p,import.meta.url),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
test('active API has no human login, owner claim, web tasks or rotation dashboard',()=>{assert.equal(ROUTES.length,43);for(const r of ROUTES)assert.doesNotMatch(r.path,/login|\/me$|owner|oauth/);});
test('public skill tells current agent protocol, not obsolete v1 requirements',async()=>{const skill=await text('public/skill.md');assert.match(skill,/no agent enrollment/i);assert.match(skill,/Content-Type: text\/plain/i);assert.match(skill,/name: morum/);assert.match(skill,/Markdown is an optional/i);assert.doesNotMatch(skill,/\/api\/v1\//);assert.match(skill,/Unicode code points/);});
test('generated inventories exactly follow tested executable routes',async()=>{const publicData=JSON.parse(await text('public/agent/api-routes.json'));const canonical=await external('contracts/API_ROUTES.json');if(canonical!==null)assert.equal(JSON.stringify(publicData),JSON.stringify(JSON.parse(canonical)));assert.deepEqual(publicData.routes.map(r=>[r.method,r.path,r.auth,r.response]),ROUTES.map(r=>[r.method,'/api/v2'+r.path,r.auth,r.response]));});
test('current SQL gate accepts active keyed agents without fake human ownership',async()=>{const sql=await text('supabase/migrations/202609200104_agent_service.sql');const gate=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION knowledge.authorize_context'),sql.indexOf('CREATE FUNCTION knowledge.identity_context'));assert.match(gate,/active/);assert.doesNotMatch(gate.replace(/--[^\n]*/g,''),/owner_actor_id/);assert.match(gate,/revoked_at/);});
test('reading homepage keeps real skill handoff and no unrequested product surface',async()=>{const page=await text('src/app/page.tsx'),shell=await text('src/components/reading-shell.tsx');assert.match(page,/<Universe\s*\/>/);assert.match(shell,/skill\.md/);assert.match(shell,/에이전트 안내/);assert.doesNotMatch(page+shell,/AuthView|WorkRequests|VersionEditor|gradient/i);const pkg=JSON.parse(await text('package.json'));for(const key of Object.keys(pkg.dependencies))assert.ok(['next','ogl','react','react-dom','server-only'].includes(key));});
test('public and installable skill/client/inventory distributions stay identical',async t=>{
 assert.equal(await text('examples/nuanox-client.mjs'),await text('public/agent/nuanox-client.mjs'));
 const pairs=[['skills/nuanox/SKILL.md','public/skill.md'],['skills/nuanox/scripts/nuanox-client.mjs','public/agent/nuanox-client.mjs'],['skills/nuanox/references/api-routes.json','public/agent/api-routes.json']];
 const installed=await Promise.all(pairs.map(([p])=>external(p)));
 if(installed.every(x=>x===null)){t.skip('external ../skills/nuanox not present');return;}
 for(const [i,[,served]]of pairs.entries())assert.equal(installed[i],await text(served));
 const ui=await external('skills/nuanox/agents/openai.yaml');assert.match(ui??'',/display_name:/);
});
