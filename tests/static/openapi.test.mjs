/** SOURCE-ONLY: regenerates public/openapi.json in memory from routes.ts/validation.ts/types.ts
 * (scripts/lib/openapi.mjs), no compiled build required. Roadmap 1.6. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import nodePath from 'node:path';
import {parseRoutes,parseMutationShapes,parseCheckFields,parseContractVersion,buildOpenApi,stableStringify} from '../../scripts/lib/openapi.mjs';

const rootDir=fileURLToPath(new URL('../../',import.meta.url));
const path=(...p)=>nodePath.join(rootDir,...p);
const read=p=>readFileSync(path(p),'utf8');

const routesSrc=read('src/server/service/routes.ts');
const validationSrc=read('src/domain/validation.ts');
const typesSrc=read('src/contracts/types.ts');

const routes=parseRoutes(routesSrc);
const shape=parseMutationShapes(validationSrc);
const checkFields=parseCheckFields(validationSrc);
const contractVersion=parseContractVersion(typesSrc);

test('the parser found the full, active route inventory',()=>{
 assert.equal(routes.length,44,`expected 44 parsed RouteEntry objects, got ${routes.length}`);
});

const generated=buildOpenApi({routes,shape,checkFields,contractVersion});
const generatedText=stableStringify(generated);
const committedText=read('public/openapi.json');

test('public/openapi.json parses as JSON and declares OpenAPI 3.1.0',()=>{
 const doc=JSON.parse(committedText);
 assert.equal(doc.openapi,'3.1.0');
 assert.equal(typeof doc.info?.title,'string');
 assert.equal(doc.info.version,contractVersion);
 assert.ok(Array.isArray(doc.servers)&&doc.servers.some(s=>s.url==='/api/v2'));
 assert.equal(typeof doc.paths,'object');
 assert.equal(typeof doc.components?.schemas,'object');
});

test('the committed public/openapi.json matches what the registry regenerates',()=>{
 assert.equal(committedText,generatedText,'public/openapi.json is stale; run `npm run contracts:generate`');
});

test('every registry route appears in the document exactly once',()=>{
 const doc=JSON.parse(committedText);
 for(const r of routes){
  const p='/api/v2'+r.path.replace(/:([a-z_]+)/g,(_,name)=>`{${name}}`);
  const item=doc.paths[p];
  assert.ok(item,`missing path item for ${r.method} ${r.path}`);
  const op=item[r.method.toLowerCase()];
  assert.ok(op,`missing operation ${r.method} ${p}`);
 }
 let opCount=0;
 for(const item of Object.values(doc.paths))opCount+=Object.keys(item).length;
 assert.equal(opCount,routes.length,'operation count does not match route count (duplicate or missing entry)');
});

test('every operation has a 4XX and 5XX error response referencing the Error schema',()=>{
 const doc=JSON.parse(committedText);
 for(const item of Object.values(doc.paths)){
  for(const op of Object.values(item)){
   for(const code of ['4XX','5XX']){
    assert.equal(op.responses[code]?.content?.['application/json']?.schema?.$ref,'#/components/schemas/Error');
   }
  }
 }
});

test('command and /check request bodies are closed objects (additionalProperties:false)',()=>{
 const doc=JSON.parse(committedText);
 for(const r of routes){
  if(!r.command&&r.path!=='/check')continue;
  const p='/api/v2'+r.path.replace(/:([a-z_]+)/g,(_,name)=>`{${name}}`);
  const schema=doc.paths[p][r.method.toLowerCase()].requestBody.content['application/json'].schema;
  assert.equal(schema.additionalProperties,false);
 }
});
