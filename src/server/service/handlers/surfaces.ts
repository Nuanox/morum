import 'server-only';
import type * as T from '../../../contracts/types.js';
import {ensure} from '../../../domain/errors.js';
import {uuid} from '../../../domain/validation.js';
import {queryParams,intQuery,parseDeclaredAgent,HttpError} from '../transport.js';
import {checkedRpc,checkUrlReport,checkDossier,checkAttention} from '../rpc-shapes.js';
import {renderDossierText} from '../dossier-text.js';
import {renderClaimReviews,publicOrigin} from '../claimreview.js';
import type {Handler} from './index.js';

/** Roadmap 2.11 (extended): records this lookup for adoption metrics (hit rate, write-back rate,
 * distinct operators -- see docs/METRICS.md) and returns first_lookup_at for the response. Never
 * lets a recording failure affect the read: any error here is swallowed and first_lookup_at is
 * null, exactly as if this lookup had never been logged. */
async function recordLookup(ctx:{request:Request;requestId:string;services:{db:{call<T>(name:string,args:unknown):Promise<T>};auth:{authenticate(request:Request):Promise<{actor_id:string}>}}},kind:'url_report'|'check',urlInput:string,hit:boolean):Promise<string|null>{
 try{
  const declared=parseDeclaredAgent(ctx.request.headers.get('morum-agent'));
  let agentKeyId:string|null=null;
  if(ctx.request.headers.has('authorization')){
   try{agentKeyId=(await ctx.services.auth.authenticate(ctx.request)).actor_id;}catch{/* unauthenticated stays anonymous, never a 401 for a read */}
  }
  const rec=await ctx.services.db.call<{id:string;first_lookup_at:string|null}>('kb_record_lookup',{p_query:{
   kind,url_input:urlInput,hit,
   operator:declared?.operator??null,harness:declared?.harness??null,model:declared?.model??null,
   agent_key_id:agentKeyId,request_id:ctx.requestId,
  }});
  return rec.first_lookup_at;
 }catch{return null;}
}

export const urlReport:Handler=async (ctx)=>{
 const {url,services:s,respond}=ctx;
 const q=queryParams(url,['url']);
 if(q.url===undefined||q.url.length===0||q.url.length>2048||!/^https?:\/\//i.test(q.url))throw new HttpError('VALIDATION_FAILED',400);
 const raw=await s.db.call<Record<string,unknown>>('kb_url_report',{p_query:{url:q.url}});
 const counts=raw&&typeof raw==='object'?(raw.counts as {sources?:number}|undefined):undefined;
 const hit=(counts?.sources??0)>=1;
 const firstLookupAt=await recordLookup(ctx,'url_report',q.url,hit);
 const result=checkedRpc<T.UrlReport>({...raw,first_lookup_at:firstLookupAt,check_guide:'/skill.md#check-before-you-cite-read-before-you-write'},checkUrlReport);
 return respond(result,false,200,262144);
};

export const dossier:Handler=async (ctx)=>{
 const {url,services:s,rawResponse,respond}=ctx;
 const q=queryParams(url,['target_kind','target_id','budget','format','blind']);
 ensure(q.target_kind==='version','VALIDATION_FAILED');uuid(q.target_id);
 const budget=intQuery(q.budget,1000,20000,6000);
 const format=q.format??'json';ensure(format==='json'||format==='text');
 let blind=false;if(q.blind!==undefined){ensure(q.blind==='true'||q.blind==='false');blind=q.blind==='true';}
 const dossierData=checkedRpc<T.Dossier>(await s.db.call('kb_dossier',{p_query:{target:{kind:'version',id:q.target_id},blind}}),checkDossier);
 if(format==='text'){
  const body=renderDossierText(dossierData,budget);
  return rawResponse(body,{'content-type':'text/plain; charset=utf-8'});
 }
 // Roadmap 2.9: additive field, text format above is unchanged.
 const claim_reviews=renderClaimReviews(dossierData,publicOrigin(url.origin));
 return respond({...dossierData,claim_reviews},false,200,1048576);
};

export const attention:Handler=async ({url,services:s,respond})=>{
 const q=queryParams(url,['limit','reasons','seed']);
 const limit=intQuery(q.limit,1,50,20);
 let reasons:string[]|undefined;
 if(q.reasons!==undefined){
  reasons=q.reasons.split(',').map(r=>r.trim()).filter(r=>r.length>0);
  const allowed=['quote_not_found','archive_not_found','contested','no_basis','requested','quote_unverifiable','unreviewed','uncategorized'];
  ensure(reasons.length>0&&reasons.every(r=>allowed.includes(r)),'VALIDATION_FAILED');
 }
 if(q.seed!==undefined)ensure(/^[A-Za-z0-9._~-]{1,64}$/.test(q.seed),'VALIDATION_FAILED');
 const result=checkedRpc<T.AttentionList>(await s.db.call('kb_attention',{p_query:{limit,...(reasons?{reasons}:{}),...(q.seed!==undefined?{seed:q.seed}:{})}}),checkAttention);
 return respond(result);
};
