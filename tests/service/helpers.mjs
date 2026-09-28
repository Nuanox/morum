/** Explicit RPC double. Never imported by app/src or used as a production fallback. */
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {AgentAuth} from '../../.test-build/server/service/auth.js';
import {RateLimiter} from '../../.test-build/server/service/rate-limit.js';
import {Embeddings,IndexWorker} from '../../.test-build/server/service/embeddings.js';
import {Retrieval} from '../../.test-build/server/service/retrieval.js';
import {KnowledgeRepository} from '../../.test-build/server/db/knowledge-repository.js';
import {CursorCodec} from '../../.test-build/server/db/cursor.js';
import {createHandler} from '../../.test-build/server/service/http.js';
import {DomainError} from '../../.test-build/domain/errors.js';
import {verifyWebBotAuth} from '../../.test-build/server/service/web-bot-auth.js';
export const PEPPER='test-only-pepper-not-a-deployed-secret-'.repeat(2);
export const CURSOR='test-only-cursor-not-a-deployed-secret-'.repeat(2);
export const off={provider:'disabled',budgetApproved:false,dataSharingApproved:false,dailyTokenCap:0,requestTokenCap:0,timeoutMs:100};
export function token(){return `nuanox_${randomUUID()}_${randomBytes(32).toString('base64url')}`;}
export function setup(custom={}){
 const calls=[],keys=new Map();
 const credential=token(),keyId=credential.split('_')[1],actorId=randomUUID();
 keys.set(keyId,{actor_id:actorId,key_id:keyId,digest:createHmac('sha256',PEPPER).update('nuanox-agent-v1\0').update(credential).digest('hex'),pepper_version:'v1',revoked_at:null,state:'active'});
 const db={async call(name,args){calls.push({name,args});if(custom[name])return custom[name](args);
  if(name==='kb_rate_limit')return {allowed:true,retry_after:60};
  if(name==='kb_health')return {status:'ok',database:'reachable',contract_version:'2.1.0'};
  if(name==='kb_lookup_key')return keys.get(args.p_query.key_id)??null;
  if(name==='kb_enroll_agent'){
   const q=args.p_query,old=keys.get(q.key_id);if(old&&old.digest!==q.key_digest)throw new DomainError('UNAUTHENTICATED');
   if(old&&(old.request_hash!==q.request_hash||old.idempotency_key!==q.idempotency_key))throw new DomainError('IDEMPOTENCY_CONFLICT');
   const row=old??{actor_id:randomUUID(),key_id:q.key_id,digest:q.key_digest,pepper_version:'v1',revoked_at:null,state:'active',request_hash:q.request_hash,idempotency_key:q.idempotency_key};keys.set(q.key_id,row);
   return {data:{agent:{id:row.actor_id,kind:'agent',state:'active',display_name:q.display_name,self_description:q.self_description},key_id:row.key_id,credential_delivery:'client_generated'},replayed:!!old};
  }
  if(name==='kb_agent_status')return {active_key_id:args.p_actor.key_id,agent:{id:args.p_actor.actor_id,kind:'agent',state:'active',display_name:'SYNTHETIC test actor',self_description:null}};
  throw Error(`Unexpected test RPC: ${name}`);
 }};
 const cursors=new CursorCodec(CURSOR),rates=new RateLimiter(db,CURSOR),auth=new AgentAuth(db,PEPPER,true),repo=new KnowledgeRepository(db,cursors);
 const embeddings=new Embeddings(off,rates,()=>{throw Error('No external calls allowed in this test');});
 // Default: real verifyWebBotAuth logic, but its fetchDirectory is a stub that refuses network
 // access outright (tests that want a signature verified pass custom.fetchDirectory).
 const verifySignature=custom.verifySignature??((request)=>verifyWebBotAuth(request,{fetchDirectory:custom.fetchDirectory??(async ()=>{throw Error('No external directory fetch allowed in this test');})}));
 const services={db,repo,auth,rates,embeddings,retrieval:new Retrieval(db,cursors,embeddings),worker:new IndexWorker(db,embeddings),verifySignature};
 const handle=createHandler(()=>services);
 const req=(path,method='GET',body,options={})=>new Request(`http://localhost/api/v2${path}`,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(options.auth===false?{}:{authorization:`Bearer ${options.token??credential}`}),...options.headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
 return {calls,keys,credential,keyId,actorId,db,rates,auth,services,cursors,handle,req};
}
export const record=()=>({title:'SYNTHETIC protocol test',body_text:'\ubc30\ub97c \ud0c0\uace0 \uc81c\uc8fc\ub3c4\ub85c \uac14\ub2e4.',body_format:'plain_text',attributes:{},synthetic_demo:true,reason:'Explicit test fixture',basis:[]});
export const summary={agree:0,disagree:0,needs_review:0,effective_reviewers:0,anonymous_reviews:0,anonymous_stances:{agree:0,disagree:0,needs_review:0},review_state:'unreviewed',approval_inherited:false};
export const now=()=>new Date().toISOString();
export const expires=()=>new Date(Date.now()+590000).toISOString();
