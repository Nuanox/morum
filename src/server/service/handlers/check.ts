import 'server-only';
import {randomUUID} from 'node:crypto';
import type * as T from '../../../contracts/types.js';
import {validateCheckRequest} from '../../../domain/validation.js';
import {mutate} from '../../../domain/mutate.js';
import {sha256} from '../../../domain/hash.js';
import {readJson,readIdempotencyKey,parseDeclaredAgent,queryParams} from '../transport.js';
import type {Handler} from './index.js';

/** Roadmap 2.11 (extended): mirrors surfaces.ts's recordLookup for the kind='check' side of the
 * lookup log (write-back detection needs both sides). Only meaningful when the check carried a
 * URL; non-fatal, same as the url_report side -- never affects the response. */
async function recordCheckLookup(request:Request,requestId:string,s:{db:{call<T>(name:string,args:unknown):Promise<T>}},urlInput:string,hit:boolean,actorId:string|null):Promise<void>{
 try{
  const declared=parseDeclaredAgent(request.headers.get('morum-agent'));
  await s.db.call('kb_record_lookup',{p_query:{
   kind:'check',url_input:urlInput,hit,
   operator:declared?.operator??null,harness:declared?.harness??null,model:declared?.model??null,
   agent_key_id:actorId,request_id:requestId,
  }});
 }catch{/* never let recording affect the response */}
}

/** Fallback only: mirrors the first two branches of knowledge.evidence_quote_check (exact
 * substring or not_found). The full six-state check is read back from kb_url_report below
 * whenever the source has a URL; this fallback covers excerpt-only sources and read failures. */
function quoteCheckState(quote:string,excerpt:string):T.QuoteCheckState {
 if(quote.trim().length===0)return 'no_quote';
 if(excerpt.trim().length===0)return 'no_text';
 return excerpt.includes(quote)?'found_exact':'not_found';
}
/** Derives a sub-step idempotency key from the bundle's key. Colons are not in the
 * idempotency-key charset, so the derivation is hashed rather than concatenated raw. */
const subKey=(key:string,part:string):string=>sha256(`${key}:${part}`);

export const check:Handler=async (ctx)=>{
 const {request,url,requestId,services:s,contributor,actor,respond,setWriteKey}=ctx;
 queryParams(url,[]);
 const requestKey:string=request.headers.has('idempotency-key')?readIdempotencyKey(request):randomUUID();
 setWriteKey(requestKey);
 const body=validateCheckRequest(await readJson(request));
 const declared=parseDeclaredAgent(request.headers.get('morum-agent'));
 const who=contributor??actor!;

 let recordId:T.UUID,versionId:T.UUID,recordCreated=false,recordReplayed=true;
 if(body.record_id!==null){
  recordId=body.record_id;
  const view=await s.repo.getRecord(recordId);
  versionId=view.version.id;
 }else if(body.version_id!==null){
  const view=await s.repo.getVersion(body.version_id);
  versionId=view.version.id;recordId=view.version.record_id;
 }else{
  const recordInput:T.CreateRecordRequest={
   title:body.title,
   body_text:body.claim,body_format:'plain_text',
   attributes:body.attributes,synthetic_demo:false,
   reason:'Recorded via POST /check',basis:[],
  };
  const result=await mutate(s.repo,who,'record.create',recordInput,subKey(requestKey,'record'),undefined,declared);
  recordId=result.data.version.record_id;versionId=result.data.version.id;
  recordCreated=!result.replayed;recordReplayed=result.replayed;
 }

 // Reuse the source row when a source at this URL already carries this exact excerpt, byte-identical.
 // Only the SOURCE row is reused; a fresh evidence row is always created, so repeated checks of the
 // same passage share one source_id but leave distinct evidence — the "not independent" signal.
 let reusedSourceId:T.UUID|null=null;
 if(body.url!==null){
  try{
   const report=await s.db.call<T.UrlReport>('kb_url_report',{p_query:{url:body.url}});
   const candidates=(report?.sources??[]).filter(src=>src.has_text).slice(0,10);
   const excerptHash=sha256(body.excerpt);
   for(const candidate of candidates){
    const source=await s.repo.getSource(candidate.id);
    if(source.submitted_text!==null&&sha256(source.submitted_text)===excerptHash){reusedSourceId=source.id;break;}
   }
  }catch{/* on any read failure, fall back to creating a new source */}
 }

 let sourceId:T.UUID,sourceCreated:boolean,sourceReplayed=true;
 if(reusedSourceId!==null){
  sourceId=reusedSourceId;sourceCreated=false;
 }else{
  const sourceInput:T.SourceInput={
   url:body.url,title:null,submitted_text:body.excerpt,
   published_at:body.published_at,retrieved_at:body.retrieved_at,rights_note:null,
   attributes:body.archive_url!==null?{archive_url:body.archive_url}:{},
   synthetic_demo:false,
  };
  const sourceResult=await mutate(s.repo,who,'source.create',sourceInput,subKey(requestKey,'source'),undefined,declared);
  sourceId=sourceResult.data.id;sourceCreated=!sourceResult.replayed;sourceReplayed=sourceResult.replayed;
 }

 const evidenceInput:T.CreateEvidenceRequest={
  target:{kind:'version',id:versionId},
  basis:{kind:'external',source_id:sourceId,quote:body.quote,explanation:body.explanation},
 };
 const evidenceResult=await mutate(s.repo,who,'evidence.create',evidenceInput,subKey(requestKey,'evidence'),undefined,declared);

 // Read the server's own six-state quote check back for this evidence row when the source has a URL.
 let quoteCheck:T.QuoteCheck={state:quoteCheckState(body.quote,body.excerpt),source_id:sourceId};
 if(body.url!==null){
  try{
   const report=await s.db.call<T.UrlReport>('kb_url_report',{p_query:{url:body.url}});
   const hit=report?.citations?.find(c=>c.evidence_id===evidenceResult.data.id);
   if(hit)quoteCheck=hit.quote_check;
  }catch{/* keep the fallback */}
 }
 const replayed=recordReplayed&&sourceReplayed&&evidenceResult.replayed;
 const data:T.CheckResult={
  record_id:recordId,version_id:versionId,source_id:sourceId,evidence_id:evidenceResult.data.id,
  quote_check:quoteCheck,
  created:{record:recordCreated,source:sourceCreated,evidence:!evidenceResult.replayed},
 };
 if(body.url!==null)await recordCheckLookup(request,requestId,s,body.url,!sourceCreated,actor?.actor_id??null);
 return respond(data,replayed,replayed?200:201);
};
