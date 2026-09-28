import type * as T from '../contracts/types.js';
import {ensure,fail} from './errors.js';
import {validateScalar,validateBody,cpLength} from './text.js';
import {canonicalJSON} from './idempotency.js';
export type Dict=Record<string,unknown>;
export function object(v:unknown,allowed?:readonly string[],required:readonly string[]=[]):Dict {
 ensure(v!==null&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null));
 const o=v as Dict;ensure(!Object.getOwnPropertySymbols(o).length);
 if(allowed)ensure(Object.keys(o).every(k=>allowed.includes(k)));
 ensure(required.every(k=>Object.hasOwn(o,k)&&o[k]!==undefined));return o;
}
export function uuid(v:unknown):asserts v is string {ensure(typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));}
export function hash(v:unknown):void {ensure(typeof v==='string'&&/^[0-9a-f]{64}$/.test(v));}
export function integer(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):asserts v is number {ensure(typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max);}
export function text(v:unknown,max:number,min=1,nullable=false):void {
 if(v===null&&nullable)return;const s=validateScalar(v);ensure(cpLength(s)<=max&&cpLength(s)>=min&&(min===0||s.trim().length>0));
}
function one(v:unknown,values:readonly unknown[]):void {ensure(values.includes(v));}
export function nilUuid(v:unknown):void {if(v!==null)uuid(v);}
export function date(v:unknown):void {
 if(v===null)return;
 ensure(typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v)));
 const y=Number(v.slice(0,4)),m=Number(v.slice(5,7)),d=Number(v.slice(8,10));
 const leap=y%4===0&&(y%100!==0||y%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 ensure(y>=1&&m>=1&&m<=12&&d>=1&&d<=days[m-1]!&&Number(v.slice(11,13))<24&&Number(v.slice(14,16))<60&&Number(v.slice(17,19))<60);
}
export function attributes(v:unknown):void {
 object(v);let leaves=0;
 function visit(x:unknown,depth:number):void {
  ensure(depth<=8);
  if(x===null||typeof x!=='object'){
   leaves++;ensure(leaves<=1024);if(typeof x==='string')validateScalar(x);
   else if(typeof x==='number')ensure(Number.isFinite(x)&&Math.abs(x)<=Number.MAX_SAFE_INTEGER);
   else ensure(x===null||typeof x==='boolean');return;
  }
  if(Array.isArray(x)){ensure(Object.keys(x).length===x.length&&Object.keys(x).every((k,i)=>k===String(i)));for(const y of x)visit(y,depth+1);return;}
  const o=object(x);for(const [k,y]of Object.entries(o)){text(k,128);ensure(!['__proto__','prototype','constructor'].includes(k));visit(y,depth+1);}
 }
 visit(v,0);if(new TextEncoder().encode(canonicalJSON(v)).length>65536)fail('PAYLOAD_TOO_LARGE');
}
export const LOCATIONS=['version','anchor','source'] as const;
export const CONTENT=['version','anchor','source','relation','annotation','evidence','review'] as const;
export function ref(v:unknown,kinds:readonly string[]=LOCATIONS):void {const o=object(v,['kind','id'],['kind','id']);one(o.kind,kinds);uuid(o.id);}
function basis(v:unknown):void {
 const o=object(v);text(o.explanation,8000);
 if(o.kind==='reasoning')object(o,['kind','explanation'],['kind','explanation']);
 else if(o.kind==='external'){object(o,['kind','source_id','quote','explanation'],['kind','source_id','quote','explanation']);uuid(o.source_id);text(o.quote,10000,1,true);}
 else{one(o.kind,['internal']);object(o,['kind','source','explanation'],['kind','source','explanation']);ref(o.source,['version','anchor']);}
}
function bases(v:unknown,min=0):void {ensure(Array.isArray(v)&&v.length>=min);for(const b of v)basis(b);}
function format(v:unknown):void{one(v,['plain_text','markdown']);}
export function meaningful(body:string,attrs:T.Attributes):void{ensure(body.trim().length>0||Object.keys(attrs).length>0);}
export function validateMetadata(value:unknown):void {
 const o=object(value,['title','body_format','attributes_set','attributes_remove']);
 if('title'in o)text(o.title,240,1,true);if('body_format'in o)format(o.body_format);
 if('attributes_set'in o)attributes(o.attributes_set);
 if('attributes_remove'in o){ensure(Array.isArray(o.attributes_remove));const keys=o.attributes_remove;ensure(new Set(keys).size===keys.length);for(const k of keys){text(k,128);ensure(!['__proto__','prototype','constructor'].includes(k as string));ensure(!Object.hasOwn((o.attributes_set??{}) as object,k as string));}}
}
export type MutationName='record.create'|'version.create'|'anchor.create'|'source.create'|'relation.create'|'annotation.create'|'evidence.create'|'review.create'|'work_request.create'|'work_request.update';
const shape:Record<MutationName,readonly string[]>={
 'record.create':['title','body_text','body_format','attributes','synthetic_demo','reason','basis'],
 'version.create':['base_version_id','base_body_sha256','edits','metadata_update','reason','basis'],
 'anchor.create':['version_id','body_sha256','selector'],
 'source.create':['url','title','submitted_text','published_at','retrieved_at','rights_note','attributes','synthetic_demo'],
 'relation.create':['from','to','predicate','explanation','attributes','basis'],
 'annotation.create':['anchor_id','meaning','concept_version_id','attributes','supersedes_annotation_id','basis'],
 'evidence.create':['target','basis'],
 'review.create':['target','stance','focus','explanation','previous_review_id','basis'],
 'work_request.create':['title','description','target','suggested_query'],
 'work_request.update':['expected_revision','action','reason','resolution_refs'],
};
export function normalizeRecordRequest(value:unknown):T.NormalizedRecordRequest {
 const supplied=object(value,shape['record.create'],['body_text']);
 const defaults={title:null,body_format:'plain_text',attributes:{},synthetic_demo:false,reason:'Initial contribution',basis:[]};
 // Explicit null/undefined/unknown fields are not silently coerced into valid input.
 return {body_text:validateScalar(supplied.body_text),...defaults,...supplied} as T.NormalizedRecordRequest;
}
export function validateCommand(op:MutationName,value:unknown):void {
 const fields=shape[op];ensure(fields);const normalized=op==='record.create'?normalizeRecordRequest(value):value;
 const o=object(normalized,fields,fields.filter(k=>k!=='metadata_update'));
 canonicalJSON(o);if(new TextEncoder().encode(JSON.stringify(o)).length>1048576)fail('PAYLOAD_TOO_LARGE');
 switch(op){
 case 'record.create':
  text(o.title,240,1,true);validateBody(o.body_text);format(o.body_format);attributes(o.attributes);one(o.synthetic_demo,[true,false]);text(o.reason,2000);bases(o.basis);meaningful(o.body_text as string,o.attributes as T.Attributes);break;
 case 'version.create':
  uuid(o.base_version_id);hash(o.base_body_sha256);ensure(Array.isArray(o.edits)&&o.edits.length<=20);
  for(const raw of o.edits){
   const e=object(raw,['start','end','exact','replacement','prefix','suffix'],['exact','replacement']);
   ensure((e.start!==undefined)===(e.end!==undefined));
   if(e.start!==undefined){integer(e.start,0,100000);integer(e.end,e.start as number,100000);}
   const exact=validateBody(e.exact);validateBody(e.replacement);
   text(e.prefix!==undefined?e.prefix:'',32,0);text(e.suffix!==undefined?e.suffix:'',32,0);
   if(exact.length===0&&e.start===undefined)ensure(cpLength((e.prefix as string|undefined)??'')>0&&cpLength((e.suffix as string|undefined)??'')>0);
  }
  if('metadata_update'in o)validateMetadata(o.metadata_update);text(o.reason,2000);bases(o.basis,1);break;
 case 'anchor.create':{
  uuid(o.version_id);hash(o.body_sha256);
  const s=object(o.selector,['unit','start','end','exact','prefix','suffix'],['unit','exact']);
  one(s.unit,['unicode_code_point']);
  ensure((s.start!==undefined)===(s.end!==undefined));
  if(s.start!==undefined){integer(s.start,0,99999);integer(s.end,(s.start as number)+1,100000);}
  const exact=validateBody(s.exact);
  text(s.prefix!==undefined?s.prefix:'',32,0);text(s.suffix!==undefined?s.suffix:'',32,0);
  if(exact.length===0&&s.start===undefined)ensure(cpLength((s.prefix as string|undefined)??'')>0&&cpLength((s.suffix as string|undefined)??'')>0);
  break;}
 case 'source.create':
  if(o.url!==null){text(o.url,2048);let url:URL;try{url=new URL(o.url as string);}catch{fail('VALIDATION_FAILED');}
   ensure(!/\s/.test(o.url as string)&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!!url.hostname&&/^https?:\/\//i.test(o.url as string));}
  text(o.title,240,1,true);if(o.submitted_text!==null){validateScalar(o.submitted_text);ensure(cpLength(o.submitted_text as string)<=8000);}
  ensure(o.url!==null||(typeof o.submitted_text==='string'&&o.submitted_text.trim().length>0));date(o.published_at);date(o.retrieved_at);text(o.rights_note,8000,1,true);attributes(o.attributes);one(o.synthetic_demo,[true,false]);break;
 case 'relation.create':
  ref(o.from);ref(o.to);ensure((o.from as Dict).kind!==(o.to as Dict).kind||String((o.from as Dict).id).toLowerCase()!==String((o.to as Dict).id).toLowerCase());text(o.predicate,100);
  ensure(['supports','contradicts','corrects','depends_on','defines','same_meaning_as','translation_of','derived_from','related_to'].includes(o.predicate as string)||/^x:[a-z][a-z0-9_.-]{0,31}:[a-z][a-z0-9_.-]{0,31}$/.test(o.predicate as string));
  text(o.explanation,8000);attributes(o.attributes);bases(o.basis);break;
 case 'annotation.create':uuid(o.anchor_id);text(o.meaning,8000);nilUuid(o.concept_version_id);nilUuid(o.supersedes_annotation_id);attributes(o.attributes);bases(o.basis);break;
 case 'evidence.create':ref(o.target,['version','anchor','source','relation','annotation','review']);basis(o.basis);break;
 case 'review.create':ref(o.target,['version','anchor','source','relation','annotation','evidence']);one(o.stance,['agree','disagree','needs_review']);one(o.focus,['content','evidence_support','quote_match','meaning']);text(o.explanation,8000);nilUuid(o.previous_review_id);bases(o.basis);break;
 case 'work_request.create':text(o.title,240);text(o.description,8000);if(o.target!==null)ref(o.target);text(o.suggested_query,500,1,true);break;
 case 'work_request.update':integer(o.expected_revision,1,2147483647);one(o.action,['claim','release','resolve','close','reopen']);text(o.reason,2000);ensure(Array.isArray(o.resolution_refs));for(const r of o.resolution_refs)ref(r);ensure(o.action==='resolve'?o.resolution_refs.length>0:o.resolution_refs.length===0);break;
 }
}
export function validateListQuery(value:unknown,extra:readonly string[]=[]):Dict {
 const o=object(value,['limit','cursor',...extra]);if(o.limit!==undefined)integer(o.limit,1,50);
 if(o.cursor!==undefined&&o.cursor!==null)text(o.cursor,4096);return o;
}
export function parseQueryInteger(value:string):number {ensure(/^(0|[1-9][0-9]*)$/.test(value));const n=Number(value);integer(n);return n;}
/** POST /check body: shape + scalar checks only; the three bundled sub-commands are re-validated
 * with validateCommand by the handler once they are assembled, so limits (e.g. excerpt/submitted_text)
 * stay defined in exactly one place (the source.create case above). */
const CHECK_FIELDS=['claim','title','record_id','version_id','url','excerpt','quote','explanation','published_at','retrieved_at','archive_url','attributes'] as const;
export function validateCheckRequest(value:unknown):T.CheckRequest {
 const o=object(value,CHECK_FIELDS,CHECK_FIELDS);
 text(o.claim,4000,1);text(o.title,240,1,true);nilUuid(o.record_id);nilUuid(o.version_id);
 ensure(o.record_id===null||o.version_id===null);
 text(o.url,2048,1);text(o.excerpt,8000,1);text(o.quote,10000,1);text(o.explanation,8000,1);
 ensure(cpLength(o.quote as string)<=cpLength(o.excerpt as string));
 date(o.published_at);date(o.retrieved_at);text(o.archive_url,2048,1,true);attributes(o.attributes);
 return o as unknown as T.CheckRequest;
}
/** POST /admin/archive-checks body: the background job's own comparison result (never fetched or
 * re-derived server-side). Mirrors the CHECK values enforced again by public.kb_record_archive_check. */
const ARCHIVE_CHECK_FIELDS=['evidence_id','state','archive_url','snapshot_at','text_sha256','text_length','rule_version','detail'] as const;
const ARCHIVE_CHECK_STATES=['found_exact','found_normalized','found_fragments','not_found','no_snapshot','fetch_failed'] as const;
export function validateRecordArchiveCheckRequest(value:unknown):T.RecordArchiveCheckRequest {
 const o=object(value,ARCHIVE_CHECK_FIELDS,['evidence_id','state','rule_version']);
 uuid(o.evidence_id);one(o.state,ARCHIVE_CHECK_STATES);
 if(o.archive_url===undefined)o.archive_url=null;
 if(o.archive_url!==null){text(o.archive_url,2048,1);ensure((o.archive_url as string).startsWith('https://web.archive.org/web/'));}
 if(o.snapshot_at===undefined)o.snapshot_at=null;date(o.snapshot_at);
 if(o.text_sha256===undefined)o.text_sha256=null;if(o.text_sha256!==null)hash(o.text_sha256);
 if(o.text_length===undefined)o.text_length=null;if(o.text_length!==null)integer(o.text_length,0);
 text(o.rule_version,64);
 if(o.detail===undefined)o.detail=null;text(o.detail,500,0,true);
 return o as unknown as T.RecordArchiveCheckRequest;
}
