/** Route registry structural invariants (Roadmap 1.5). SOURCE-ONLY: reads routes.ts/handlers text, no compiled build required. */
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import nodePath from 'node:path';

const rootDir=fileURLToPath(new URL('../../',import.meta.url));
const path=(...p)=>nodePath.join(rootDir,...p);
const read=p=>readFileSync(path(p),'utf8');

const ROUTES_SRC=read('src/server/service/routes.ts');
const HANDLERS_SRC=read('src/server/service/handlers/index.ts');

// The ten contribution/agent POSTs that go through the generic mutate() handler (Roadmap 1.5 design).
const COMMANDS=['record.create','version.create','anchor.create','source.create','annotation.create','relation.create','evidence.create','review.create','work_request.create','work_request.update'];

function parseRoutes(src){
 const block=src.slice(src.indexOf('export const ROUTES'));
 const entryRe=/\{method:'(GET|POST)',path:'([^']*)',auth:'([^']*)',response:'([^']*)',summary:'([^']*)',query:\[([^\]]*)\](?:,command:'([^']*)')?(?:,probe:(true))?\}/g;
 const routes=[];let m;
 while((m=entryRe.exec(block))){
  const [,method,routePath,auth,response,summary,queryRaw,command,probe]=m;
  const query=queryRaw.trim().length?queryRaw.split(',').map(s=>s.trim().replace(/^'|'$/g,'')):[];
  routes.push({method,path:routePath,auth,response,summary,query,command,probe:probe==='true'});
 }
 return routes;
}
function parseHandlerKeys(src){
 const block=src.slice(src.indexOf('export const HANDLERS'));
 const entryRe=/\['(GET|POST) ([^']*)',/g;
 const keys=new Set();let m;
 while((m=entryRe.exec(block)))keys.add(`${m[1]} ${m[2]}`);
 return keys;
}

const routes=parseRoutes(ROUTES_SRC);
const handlerKeys=parseHandlerKeys(HANDLERS_SRC);

test('the route table parser found the full, active route inventory',()=>{
 assert.equal(routes.length,43,`expected 43 parsed RouteEntry objects, got ${routes.length} (did the routes.ts entry format change?)`);
});

test('every non-probe ROUTES entry has exactly one handler, and every handler key matches a route',()=>{
 const nonProbeKeys=routes.filter(r=>!r.probe).map(r=>`${r.method} ${r.path}`);
 assert.equal(new Set(nonProbeKeys).size,nonProbeKeys.length,'duplicate method+path in ROUTES');
 assert.equal(handlerKeys.size,nonProbeKeys.length,`HANDLERS has ${handlerKeys.size} entries, ROUTES has ${nonProbeKeys.length} non-probe routes`);
 for(const key of nonProbeKeys)assert.ok(handlerKeys.has(key),`no handler registered for route ${key}`);
 for(const key of handlerKeys)assert.ok(nonProbeKeys.includes(key),`handler ${key} has no matching ROUTES entry`);
});

test('command is set on exactly the ten mutate POSTs, and only on POST routes',()=>{
 const withCommand=routes.filter(r=>r.command);
 assert.deepEqual(withCommand.map(r=>r.command).sort(),[...COMMANDS].sort());
 for(const r of withCommand)assert.equal(r.method,'POST',`${r.method} ${r.path} carries a command but is not a POST route`);
});

test('probe is set on GET /health only',()=>{
 const probes=routes.filter(r=>r.probe);
 assert.equal(probes.length,1,`expected exactly one probe route, got ${probes.length}`);
 assert.equal(probes[0].method,'GET');assert.equal(probes[0].path,'/health');
});

test('query parameter names are lowercase snake_case',()=>{
 for(const r of routes)for(const q of r.query)assert.match(q,/^[a-z][a-z0-9_]*$/,`${r.method} ${r.path} query name "${q}" is not lowercase snake_case`);
});

test('every route has a non-empty summary sentence ending with a period',()=>{
 for(const r of routes){
  assert.ok(r.summary.length>0,`${r.method} ${r.path} has an empty summary`);
  assert.match(r.summary,/[^.]\.$/,`${r.method} ${r.path} summary does not end with a single period: ${JSON.stringify(r.summary)}`);
 }
});
