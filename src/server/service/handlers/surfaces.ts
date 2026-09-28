import 'server-only';
import type * as T from '../../../contracts/types.js';
import {ensure} from '../../../domain/errors.js';
import {uuid} from '../../../domain/validation.js';
import {queryParams,intQuery,HttpError} from '../transport.js';
import {checkedRpc,checkUrlReport,checkDossier,checkAttention} from '../rpc-shapes.js';
import {renderDossierText} from '../dossier-text.js';
import {renderClaimReviews,publicOrigin} from '../claimreview.js';
import type {Handler} from './index.js';

export const urlReport:Handler=async ({url,services:s,respond})=>{
 const q=queryParams(url,['url']);
 if(q.url===undefined||q.url.length===0||q.url.length>2048||!/^https?:\/\//i.test(q.url))throw new HttpError('VALIDATION_FAILED',400);
 const result=checkedRpc<T.UrlReport>(await s.db.call('kb_url_report',{p_query:{url:q.url}}),checkUrlReport);
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
