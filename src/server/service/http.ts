import 'server-only';
import {randomUUID} from 'node:crypto';
import type * as T from '../../contracts/types.js';
import {CONTRACT_VERSION} from '../../contracts/types.js';
import {ensure,fail,apiFailure,DomainError} from '../../domain/errors.js';
import {uuid} from '../../domain/validation.js';
import type {Services} from './factory.js';
import type {AgentContext} from './auth.js';
import {HttpError} from './transport.js';
import {matchRoute,allowedMethods} from './routes.js';
import {HANDLERS} from './handlers/index.js';
import type {RespondFn} from './handlers/index.js';
import {healthProbe} from './handlers/system.js';
const BASE='/api/v2';
const headers=(id:string):Record<string,string>=>({'cache-control':'no-store','x-content-type-options':'nosniff','x-contract-version':CONTRACT_VERSION,'x-request-id':id,'referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; frame-ancestors 'none'"});
function success(data:unknown,id:string,replayed=false,status=200,maxBytes=1048576,extraMeta?:Record<string,unknown>):Response{
 ensure(data!==undefined,'INTERNAL_ERROR');const body=JSON.stringify({data,meta:{contract_version:CONTRACT_VERSION,request_id:id,replayed,...extraMeta}});
 if(Buffer.byteLength(body)>maxBytes)throw new HttpError('PAYLOAD_TOO_LARGE',413);
 return new Response(body,{status,headers:{...headers(id),'content-type':'application/json; charset=utf-8'}});
}
export function createHandler(factory:()=>Services,health:()=>Promise<T.Health>=()=>factory().db.call('kb_health',{})){
 return async function handle(request:Request):Promise<Response>{
  const id=randomUUID();let allow:string[]=[];let writeKey:string|undefined;
  try{
   const url=new URL(request.url),method=request.method==='HEAD'?'GET':request.method;
   const version=request.headers.get('x-contract-version');if(version&&!/^2\.[0-9]+\.[0-9]+$/.test(version))throw new HttpError('VALIDATION_FAILED',400);
   if(!url.pathname.startsWith(BASE+'/'))fail('NOT_FOUND');const path=url.pathname.slice(BASE.length);
   let match;try{match=matchRoute(path,method);allow=allowedMethods(path);}catch{throw new HttpError('VALIDATION_FAILED',400);}
   if(!match){if(allow.length)throw new HttpError('VALIDATION_FAILED',405);fail('NOT_FOUND');}
   const route=match.route,p=match.params;
   for(const [name,value]of Object.entries(p))if(name!=='kind')uuid(value);
   const respond:RespondFn=(data,replayed=false,status=200,max=1048576,extraMeta)=>{const r=success(data,id,replayed,status,max,extraMeta);if(writeKey)r.headers.set('idempotency-key',writeKey);return request.method==='HEAD'?new Response(null,{status:r.status,headers:r.headers}):r;};
   const rawResponse=(body:string|null,extra:Record<string,string>,status=200)=>new Response(request.method==='HEAD'?null:body,{status,headers:{...headers(id),...extra}});
   // No services, no rate limit: /health must report a friendly status even when the DB is unconfigured.
   if(route.probe)return await healthProbe(url,health,respond);
   const s=factory();const client=s.rates.client(request);
   // Public reads never fetch a session/me endpoint or inspect browser cookies.
   await s.rates.require(`read:${client}`,120,60);
   let actor:AgentContext|undefined;let contributor:T.AuthContext|undefined;
   if(route.auth==='agent'||route.auth==='operator'){
    actor=await s.auth.authenticate(request,route.path==='/agents/self/key/revoke');
    if(route.method==='POST')await s.rates.require(`write:${actor.actor_id}`,30,60);
   }
   if(route.auth==='contribution'){
    if(request.headers.has('authorization'))actor=await s.auth.authenticate(request);
    contributor=actor??{kind:'anonymous'};
    await s.rates.require(actor?`write:${actor.actor_id}`:`write:public:${client}`,30,60);
   }
   const handler=HANDLERS.get(`${route.method} ${route.path}`);ensure(handler,'NOT_FOUND');
   return await handler({request,url,requestId:id,route,params:p,services:s,client,actor,contributor,respond,rawResponse,setWriteKey:(key:string)=>{writeKey=key;}});
  }catch(error){
   const failure=apiFailure(error,id);const status=error instanceof HttpError?error.httpStatus:error instanceof DomainError?error.status:500;
   const extra:Record<string,string>=writeKey?{'idempotency-key':writeKey}:{};if(error instanceof HttpError&&error.retryAfter)extra['retry-after']=String(error.retryAfter);if(status===405)extra.allow=allow.join(', ');
   return new Response(request.method==='HEAD'?null:JSON.stringify(failure),{status,headers:{...headers(id),...extra,'content-type':'application/json; charset=utf-8'}});
  }
 };
}
