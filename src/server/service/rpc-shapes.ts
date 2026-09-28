import 'server-only';
import {ensure,fail} from '../../domain/errors.js';
import {object,integer,text,uuid,hash,ref,CONTENT,validateCommand} from '../../domain/validation.js';

/** A malformed successful dependency response is a 503, never an empty success or client fault. */
export function checkedRpc<T>(value:unknown,check:(value:unknown)=>void):T {
 try { check(value); } catch { fail('DEPENDENCY_UNAVAILABLE'); }
 return value as T;
}
const bool=(value:unknown)=>ensure(typeof value==='boolean');
const nilUuid=(value:unknown)=>{if(value!==null)uuid(value);};
const one=(value:unknown,allowed:readonly unknown[])=>ensure(allowed.includes(value));
function date(value:unknown):number {
 ensure(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value));
 const n=Date.parse(value);ensure(Number.isFinite(n));return n;
}
function snapshot(value:Record<string,unknown>,max:number):void {
 uuid(value.snapshot_id);integer(value.scan_index,0,max);bool(value.has_more);bool(value.truncated);
 const at=date(value.snapshot_at),expires=date(value.snapshot_expires_at);
 ensure(expires>at&&expires-at<=601000);
 // An empty visible page is valid, but a continuation must make progress.
 ensure(!value.has_more||(value.scan_index as number)>0);
}
function reviewSummary(value:unknown):void {
 const s=object(value);
 for(const field of ['agree','disagree','needs_review','effective_reviewers'])integer(s[field],0,2147483647);
 integer(s.anonymous_reviews,0,2147483647);const a=object(s.anonymous_stances);for(const field of ['agree','disagree','needs_review'])integer(a[field],0,2147483647);ensure(s.anonymous_reviews===(a.agree as number)+(a.disagree as number)+(a.needs_review as number));
 one(s.review_state,['reviewed','unreviewed']);ensure(s.approval_inherited===false);
}
export function checkSearchCounts(value:unknown,requireProfile=false):void {
 const c=object(value);integer(c.eligible_units,0,2147483647);integer(c.indexed_units,0,c.eligible_units as number);
 if(requireProfile||c.profile_compatible!==undefined)bool(c.profile_compatible);
}
export function checkSearchPage(value:unknown):void {
 const p=object(value);snapshot(p,100);ensure(Array.isArray(p.candidates)&&p.candidates.length<=20);
 const s=object(p.stored_status);checkSearchCounts(s);
 one(s.mode,['keyword_only','hybrid','hybrid_partial']);one(s.query_embedding,['ready','not_attempted','failed']);
 one(s.reason,[null,'disabled','missing_configuration','budget_not_approved','budget_exhausted','provider_timeout','provider_error','index_pending','profile_mismatch','input_too_large','empty_input']);
 one(s.profile_id,[null,'openai-te3s-1536-v1']);ensure(s.quality_gate==='not_evaluated');
 one(s.result_state,['candidates','no_match','insufficient_index']);
 if(s.index_truncated!==undefined)bool(s.index_truncated);
 if(s.mode!=='keyword_only')ensure(s.query_embedding==='ready'&&s.profile_id==='openai-te3s-1536-v1');
 for(const value of p.candidates){
  const c=object(value);uuid(c.unit_id);ref(c.target,CONTENT);nilUuid(c.record_id);nilUuid(c.version_id);
  text(c.snippet,1200,0);text(c.title,240,0,true);one(c.is_current,[null,true,false]);bool(c.synthetic_demo);
  if(c.snippet_truncated!==undefined)bool(c.snippet_truncated);
  for(const rank of [c.lexical_rank,c.semantic_rank])if(rank!==null)integer(rank,1,50);
  ensure(c.lexical_rank!==null||c.semantic_rank!==null);reviewSummary(c.review_summary);
  const loc=object(c.locator);one(loc.kind,['body','field','object']);
  if(loc.kind==='body'){
   uuid(loc.version_id);ensure(loc.version_id===c.version_id);integer(loc.start,0,100000);integer(loc.end,loc.start as number,100000);hash(loc.body_sha256);
  }else if(loc.kind==='field'){uuid(loc.version_id);ensure(loc.version_id===c.version_id);text(loc.json_pointer,4096);}
  else ref(loc.target,CONTENT);
 }
}
export function checkContextPage(value:unknown):void {
 const p=object(value);snapshot(p,200);
 ensure(Array.isArray(p.items)&&p.items.length<=20&&Array.isArray(p.relations)&&p.relations.length<=20);
 ensure(p.omitted_count===null||Number.isSafeInteger(p.omitted_count)&&(p.omitted_count as number)>=0);
 let chars=0;
 for(const value of p.items){
  const i=object(value);ref(i.target,CONTENT);text(i.text,1200,0);chars+=Array.from(i.text as string).length;
  one(i.reason,['match','correction','counterargument','premise','evidence','meaning','surrounding_text','related']);
  bool(i.synthetic_demo);one(i.is_current,[null,true,false]);text(i.original_url,2048,0,true);
  if(i.text_truncated!==undefined)bool(i.text_truncated);
 }
 ensure(chars<=16000);
 for(const value of p.relations){
  const r=object(value);uuid(r.id);nilUuid(r.created_by);date(r.created_at);
  validateCommand('relation.create',{from:r.from,to:r.to,predicate:r.predicate,explanation:r.explanation,attributes:r.attributes,basis:[]});
 }
}
export function checkClaimedJobs(value:unknown,limit:number):void {
 ensure(Array.isArray(value)&&value.length<=limit);
 const seen=new Set<string>();
 for(const item of value){
  const j=object(item);uuid(j.id);uuid(j.unit_id);uuid(j.lease_token);hash(j.input_sha256);bool(j.oversized);
  ensure(!seen.has(j.id));seen.add(j.id);
  if(j.oversized)ensure(j.text===null);
  else{ text(j.text,12000,0);ensure(Buffer.byteLength(j.text as string,'utf8')<=12000); }
 }
}
export function checkFinishedJob(value:unknown):void {
 const r=object(value);bool(r.accepted);
 one(r.state,r.accepted?['ready','retry','dead','blocked']:['stale_lease','profile_mismatch']);
}

export function checkListPage(value:unknown):void {
 const p=object(value);snapshot(p,500);ensure(Array.isArray(p.items)&&p.items.length<=50);
 for(const value of p.items){const item=object(value);text(item.kind,32);uuid(object(item.value).id);}
}
export function checkHistoryPage(value:unknown):void {
 const p=object(value);ensure(Array.isArray(p.items)&&p.items.length<=50);
 integer(p.upper_version_no,0,2147483647);bool(p.has_more);bool(p.truncated);date(p.snapshot_at);
 if(p.last_version_no!==null)integer(p.last_version_no,1,p.upper_version_no as number);
 ensure(!p.has_more||p.last_version_no!==null);
 for(const value of p.items){const item=object(value);uuid(item.id);uuid(item.record_id);integer(item.version_no,1,p.upper_version_no as number);}
}
export function checkRawText(value:unknown):void {text(value,100000,0);}
export function checkPartPagination(value:unknown):void {const p=object(value);snapshot(p,500);}

function arr(value:unknown,max=100000):unknown[] {ensure(Array.isArray(value)&&value.length<=max);return value;}
export function checkUrlReport(value:unknown):void {
 const r=object(value);text(r.url,2048);ensure(r.canonical_url===null||typeof r.canonical_url==='string');
 arr(r.sources);arr(r.citations);arr(r.corrections);
 const counts=object(r.counts);for(const field of ['sources','citations','corrections'])integer((counts as Record<string,unknown>)[field],0);
 object(counts.quote_states);
 const truncated=object(r.truncated);for(const field of ['sources','citations','corrections'])bool((truncated as Record<string,unknown>)[field]);
 date(r.generated_at);
 // Roadmap 2.11 (extended): added by the handler after the kb_url_report call, not by the RPC
 // itself; validated here too since urlReport validates the merged response, not the raw RPC result.
 if(r.first_lookup_at!==null)date(r.first_lookup_at);
 text(r.check_guide,64);
}
/** A review's `on` ref (counterarguments.reviews / agreements.reviews element). Roadmap 2.9:
 * an anchor-kind ref optionally carries exact/start/end; a not-yet-migrated database (pre-0113)
 * never sends them, so all three stay optional here rather than required. */
function reviewOnRef(value:unknown):void {
 const o=object(value,['kind','id','exact','start','end'],['kind','id']);one(o.kind,CONTENT);uuid(o.id);
 if(o.exact!==undefined)text(o.exact,100000,0);
 if(o.start!==undefined)integer(o.start,0);
 if(o.end!==undefined)integer(o.end,0);
}
function reviewListing(value:unknown):void {
 for(const item of arr(value)){const r=object(item);uuid(r.id);text(r.stance,32);text(r.focus,32);reviewOnRef(r.on);}
}
export function checkDossier(value:unknown):void {
 const d=object(value);const v=object(d.version);uuid(v.id);uuid(v.record_id);integer(v.version_no,1);bool(v.is_current);
 arr(d.corrections);const ca=object(d.counterarguments);reviewListing(ca.reviews);arr(ca.contradicts);object(ca.groups);
 const ag=object(d.agreements);
 // Additive (roadmap 2.9): a not-yet-migrated database's kb_dossier omits reviews/truncated
 // entirely, so both stay optional rather than required.
 if(ag.reviews!==undefined)reviewListing(ag.reviews);
 if(ag.truncated!==undefined)bool(ag.truncated);
 arr(d.evidence);arr(d.premises);arr(d.meanings);arr(d.related);object(d.omitted);
 bool(d.blind);date(d.generated_at);
}
export function checkLocate(value:unknown):void {
 const r=object(value);uuid(r.version_id);hash(r.body_sha256);one(r.state,['unique','ambiguous','not_found']);
 const candidates=arr(r.candidates,10);
 for(const value of candidates){const c=object(value);integer(c.start,0);integer(c.end,c.start as number);text(c.prefix,32,0);text(c.suffix,32,0);}
 bool(r.truncated);
}
export function checkAttention(value:unknown):void {
 const a=object(value);const items=arr(a.items,50);
 for(const item of items){const i=object(item);text(i.reason,64);integer(i.priority);ref(i.target,CONTENT);date(i.since);}
 object(a.counts);date(a.generated_at);
}
