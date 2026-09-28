/** POST /reviews and POST /check with a real Web Bot Auth (RFC 9421) signature, verified through
 * an injected fetchDirectory (no network). Mirrors the shape of check.test.mjs's RPC doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign as cryptoSign} from 'node:crypto';
import {setup} from './helpers.mjs';
import {tryParseDictionary,signatureBase,jwkThumbprint} from '../../.test-build/server/service/web-bot-auth.js';

const SIGNER_ORIGIN='https://writer.example';

/** Signs a request the same way a real Web Bot Auth client would: builds Signature-Input over
 * the given covered components, computes the RFC 9421 base with the module's own signatureBase
 * (the same code path the verifier uses), then signs it with the test's fresh Ed25519 key. */
function sign(privateKey,keyid,method,url,extraHeaders,covered,now){
 const created=now-2,expires=now+300;
 const sigInput=`sig1=(${covered.map(c=>`"${c}"`).join(' ')});created=${created};keyid="${keyid}";alg="ed25519";expires=${expires};tag="web-bot-auth"`;
 const headers={'signature-agent':`a="${SIGNER_ORIGIN}"`,'signature-input':sigInput,...extraHeaders};
 const request=new Request(url,{method,headers});
 const dict=tryParseDictionary(sigInput);
 const base=signatureBase(request,new URL(url),dict.get('sig1'));
 const sig=cryptoSign(null,Buffer.from(base,'utf8'),privateKey);
 return {'signature-agent':headers['signature-agent'],'signature-input':sigInput,'signature':`sig1=:${sig.toString('base64')}:`};
}

function idempotentCreate(){
 const seen=new Map();
 return (args)=>{
  const key=args.p_context.idempotency_key;
  if(seen.has(key))return {data:seen.get(key),replayed:true};
  const row={id:randomUUID(),...args.p_command};
  seen.set(key,row);
  return {data:row,replayed:false};
 };
}

test('a Web Bot Auth-signed POST /reviews verifies, and the recorded signature call carries the review id', async () => {
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const jwk=publicKey.export({format:'jwk'});
 const keyid=jwkThumbprint(jwk);
 const now=Math.floor(Date.now()/1000);
 const recordedSignatures=[];
 const s=setup({
  kb_create_review:idempotentCreate(),
  kb_record_signature:(args)=>{recordedSignatures.push(args.p_query);return {id:randomUUID()};},
  fetchDirectory:async (origin)=>{assert.equal(origin,SIGNER_ORIGIN);return {keys:[jwk]};},
 });
 const targetId='30000000-0000-4000-8000-000000000001';
 const url='http://localhost/api/v2/reviews';
 const body=JSON.stringify({target:{kind:'version',id:targetId},stance:'agree',focus:'content',explanation:'Matches the cited passage.',previous_review_id:null,basis:[]});
 const signed=sign(privateKey,keyid,'POST',url,{'content-type':'application/json'},['@authority'],now);
 const r=await s.handle(new Request(url,{method:'POST',headers:{...signed,'content-type':'application/json',authorization:`Bearer ${s.credential}`},body}));
 assert.equal(r.status,201);
 const payload=await r.json();
 assert.equal(payload.meta.signature.state,'verified');
 assert.equal(payload.meta.signature.origin,SIGNER_ORIGIN);
 assert.equal(recordedSignatures.length,1);
 assert.equal(recordedSignatures[0].object_kind,'review');
 assert.equal(recordedSignatures[0].object_id,payload.data.id);
 assert.equal(recordedSignatures[0].signer_origin,SIGNER_ORIGIN);
 assert.equal(recordedSignatures[0].key_thumbprint,keyid);
});

test('an unsigned POST /reviews behaves identically except meta.signature.state', async () => {
 const s=setup({kb_create_review:idempotentCreate()});
 const targetId='30000000-0000-4000-8000-000000000001';
 const body={target:{kind:'version',id:targetId},stance:'agree',focus:'content',explanation:'Matches the cited passage.',previous_review_id:null,basis:[]};
 const r=await s.handle(s.req('/reviews','POST',body));
 assert.equal(r.status,201);
 const payload=await r.json();
 assert.deepEqual(payload.meta.signature,{state:'absent'});
 assert.ok(payload.data.id);
 assert.equal(s.calls.some(c=>c.name==='kb_record_signature'),false);
});

test('an invalid signature (tampered) is accepted exactly like an unsigned write, with state:invalid', async () => {
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const jwk=publicKey.export({format:'jwk'});
 const keyid=jwkThumbprint(jwk);
 const now=Math.floor(Date.now()/1000);
 const s=setup({
  kb_create_review:idempotentCreate(),
  fetchDirectory:async ()=>({keys:[jwk]}),
 });
 const targetId='30000000-0000-4000-8000-000000000001';
 const url='http://localhost/api/v2/reviews';
 const body=JSON.stringify({target:{kind:'version',id:targetId},stance:'agree',focus:'content',explanation:'Matches the cited passage.',previous_review_id:null,basis:[]});
 const signed=sign(privateKey,keyid,'POST',url,{'content-type':'application/json'},['@authority'],now);
 signed.signature=signed.signature.slice(0,-4)+'AAAA:';// tamper the trailing signature bytes
 const r=await s.handle(new Request(url,{method:'POST',headers:{...signed,'content-type':'application/json',authorization:`Bearer ${s.credential}`},body}));
 assert.equal(r.status,201);
 const payload=await r.json();
 assert.equal(payload.meta.signature.state,'invalid');
 assert.ok(payload.data.id);
 assert.equal(s.calls.some(c=>c.name==='kb_record_signature'),false);
});

test('a signed POST /check records a signature for every object it created', async () => {
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const jwk=publicKey.export({format:'jwk'});
 const keyid=jwkThumbprint(jwk);
 const now=Math.floor(Date.now()/1000);
 const recorded=[];
 function recordCreate(){
  const seen=new Map();
  return (args)=>{
   const key=args.p_context.idempotency_key;
   if(seen.has(key))return {data:seen.get(key),replayed:true};
   const recordId=randomUUID(),versionId=randomUUID();
   const data={version:{id:versionId,record_id:recordId,version_no:1,parent_version_id:null,
    title:args.p_command.title,body_text:args.p_command.body_text,body_format:args.p_command.body_format,
    body_sha256:'a'.repeat(64),attributes:args.p_command.attributes,synthetic_demo:false,
    reason:args.p_command.reason,created_by:null,created_at:new Date().toISOString(),visibility:'public'},
    previous_current_version_id:null,branched_from_noncurrent:false,indexing:{lexical:'ready',semantic:'disabled'}};
   seen.set(key,data);
   return {data,replayed:false};
  };
 }
 const s=setup({
  kb_create_record:recordCreate(),kb_create_source:idempotentCreate(),kb_create_evidence:idempotentCreate(),
  kb_record_signature:(args)=>{recorded.push(args.p_query);return {id:randomUUID()};},
  fetchDirectory:async ()=>({keys:[jwk]}),
 });
 const url='http://localhost/api/v2/check';
 const payload={claim:'The bridge opened in 1932.',title:null,record_id:null,version_id:null,
  url:'https://source.example/article',excerpt:'City records show the bridge opened in 1932.',
  quote:'the bridge opened in 1932',explanation:'Direct statement.',
  published_at:null,retrieved_at:null,archive_url:null,attributes:{}};
 const body=JSON.stringify(payload);
 const signed=sign(privateKey,keyid,'POST',url,{'content-type':'application/json'},['@authority'],now);
 const r=await s.handle(new Request(url,{method:'POST',headers:{...signed,'content-type':'application/json'},body}));
 assert.equal(r.status,201);
 const out=await r.json();
 assert.equal(out.meta.signature.state,'verified');
 assert.deepEqual(recorded.map(x=>x.object_kind).sort(),['evidence','source','version']);
});
