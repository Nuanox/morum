#!/usr/bin/env node
// Background archive-check job (roadmap: archive check). Fetches ONLY from
// web.archive.org (one fixed domain) -- never the origin site -- and
// compares each pending external-evidence quote against the archived page
// text with the same rule the database applies (scripts/lib/quote-check.mjs,
// a faithful port of knowledge.quote_check). The server itself never fetches
// a URL; this script is the only thing in the repo allowed to.
//
//   MORUM_BASE=https://morum.vercel.app MORUM_OPERATOR_KEY=... node scripts/archive-check.mjs
//   ARCHIVE_CHECK_DRY_RUN=1 MORUM_OPERATOR_KEY=... node scripts/archive-check.mjs
//
// Env:
//   MORUM_BASE            default https://morum.vercel.app
//   MORUM_OPERATOR_KEY    required; never printed
//   ARCHIVE_CHECK_LIMIT   default 50
//   ARCHIVE_CHECK_DRY_RUN 1 prints what would be posted, without posting
import {randomUUID} from 'node:crypto';
import {quoteCheck} from './lib/quote-check.mjs';
import {extractHtmlText} from './lib/html-text.mjs';
import {parseArchiveUrlHint,snapshotUrl,toWaybackTimestamp,availableUrl} from './lib/wayback.mjs';

const RULE_VERSION='archive_check/1';
const FETCH_TIMEOUT_MS=25000;
const MAX_BYTES=5*1024*1024;
const USER_AGENT='Morum archive-check (+https://morum.vercel.app/policy.md)';
const WAYBACK_SLEEP_MS=2000;

const base=(process.env.MORUM_BASE||'https://morum.vercel.app').replace(/\/$/,'');
const limit=Number(process.env.ARCHIVE_CHECK_LIMIT||'50');
const dryRun=process.env.ARCHIVE_CHECK_DRY_RUN==='1';

function credential(){
 const key=process.env.MORUM_OPERATOR_KEY;
 if(!key){console.error('MORUM_OPERATOR_KEY environment variable is required.');process.exit(2);}
 return key;
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function morumFetch(path,{method='GET',body}={}){
 const key=credential();
 const headers={'x-contract-version':'2.1.0',authorization:`Bearer ${key}`};
 if(body!==undefined){headers['content-type']='application/json';headers['idempotency-key']=randomUUID();}
 const response=await fetch(`${base}/api/v2${path}`,{method,headers,body:body!==undefined?JSON.stringify(body):undefined});
 const payload=await response.json().catch(()=>null);
 if(!response.ok||!payload||!('data' in payload)){
  const err=new Error(`Morum API ${method} ${path} failed: HTTP ${response.status} ${JSON.stringify(payload?.error??payload)}`);
  err.isMorumApiFailure=true;
  throw err;
 }
 return payload.data;
}

/** Fetches raw bytes with a timeout, redirect-follow and a size cap. Never
 * throws on an HTTP or network failure -- returns a {ok:false,...} shape so
 * the caller can record fetch_failed and keep going (Wayback failures never
 * fail the job). */
async function fetchSnapshot(url){
 if(new URL(url).hostname!=='web.archive.org')return {ok:false,detail:'refused: not a web.archive.org URL'};
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
 try{
  const response=await fetch(url,{redirect:'follow',signal:controller.signal,headers:{'user-agent':USER_AGENT}});
  if(!response.ok)return {ok:false,detail:`HTTP ${response.status} ${response.statusText}`.slice(0,500)};
  const contentType=response.headers.get('content-type')||'';
  const reader=response.body?.getReader?.();
  let bytes;
  if(reader){
   const chunks=[];let total=0;
   for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    total+=value.length;
    if(total>MAX_BYTES){await reader.cancel().catch(()=>{});return {ok:false,detail:'response exceeded 5 MB cap'};}
    chunks.push(value);
   }
   bytes=Buffer.concat(chunks.map(c=>Buffer.from(c)));
  }else{
   const buf=Buffer.from(await response.arrayBuffer());
   if(buf.length>MAX_BYTES)return {ok:false,detail:'response exceeded 5 MB cap'};
   bytes=buf;
  }
  return {ok:true,contentType,bytes};
 }catch(error){
  return {ok:false,detail:String(error?.message??error).slice(0,500)};
 }finally{
  clearTimeout(timer);
 }
}

/** Extracts comparable plain text from a fetched snapshot, or null when the
 * content-type is unsupported (PDF/binary). */
function extractText(contentType,bytes){
 const ct=contentType.toLowerCase();
 if(ct.includes('text/html')||ct.includes('application/xhtml+xml')){
  return extractHtmlText(bytes.toString('utf8'));
 }
 if(ct.includes('text/plain')){
  return bytes.toString('utf8').replace(/\s+/g,' ').trim();
 }
 return null;
}

async function pickSnapshot(item){
 const hint=parseArchiveUrlHint(item.archive_url_hint);
 if(hint)return hint;
 const when=item.retrieved_at??item.published_at??new Date().toISOString();
 const timestamp=toWaybackTimestamp(when);
 const response=await fetch(availableUrl(item.url,timestamp),{headers:{'user-agent':USER_AGENT}});
 if(!response.ok)return null;
 const payload=await response.json().catch(()=>null);
 const snap=payload?.archived_snapshots?.closest;
 if(!snap||snap.available!==true||!snap.timestamp||!snap.url)return null;
 return {timestamp:snap.timestamp,url:item.url};
}

async function processItem(item){
 const snap=await pickSnapshot(item);
 if(!snap){
  return {evidence_id:item.evidence_id,state:'no_snapshot',archive_url:null,snapshot_at:null,text_sha256:null,text_length:null,rule_version:RULE_VERSION,detail:null};
 }
 const url=snapshotUrl(snap.timestamp,snap.url);
 const fetched=await fetchSnapshot(url);
 if(!fetched.ok){
  return {evidence_id:item.evidence_id,state:'fetch_failed',archive_url:url,snapshot_at:parseWaybackTimestampToIso(snap.timestamp),text_sha256:null,text_length:null,rule_version:RULE_VERSION,detail:fetched.detail??null};
 }
 const text=extractText(fetched.contentType,fetched.bytes);
 if(text===null){
  return {evidence_id:item.evidence_id,state:'fetch_failed',archive_url:url,snapshot_at:parseWaybackTimestampToIso(snap.timestamp),text_sha256:null,text_length:null,rule_version:RULE_VERSION,detail:'unsupported content-type'};
 }
 const {createHash}=await import('node:crypto');
 const state=quoteCheck(item.quote,text);
 return {
  evidence_id:item.evidence_id,state,archive_url:url,snapshot_at:parseWaybackTimestampToIso(snap.timestamp),
  text_sha256:createHash('sha256').update(text,'utf8').digest('hex'),text_length:Array.from(text).length,
  rule_version:RULE_VERSION,detail:null,
 };
}

function parseWaybackTimestampToIso(ts){
 const s=String(ts).padEnd(14,'0');
 const y=s.slice(0,4),mo=s.slice(4,6),d=s.slice(6,8),h=s.slice(8,10),mi=s.slice(10,12),se=s.slice(12,14);
 return `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
}

async function main(){
 const pending=await morumFetch(`/admin/archive-checks/pending?limit=${Math.min(Math.max(limit,1),200)}`);
 const items=pending.items??[];
 for(const item of items){
  const result=await processItem(item);
  if(dryRun){
   console.log(JSON.stringify({dry_run:true,...result}));
  }else{
   const stored=await morumFetch('/admin/archive-checks',{method:'POST',body:result});
   console.log(`${stored.evidence_id} ${stored.state} ${stored.snapshot_at??''}`);
  }
  await sleep(WAYBACK_SLEEP_MS);
 }
 console.log(`archive-check: ${items.length} item(s) processed.`);
}

main().catch(error=>{
 if(error?.isMorumApiFailure){console.error(error.message);process.exit(1);}
 // A Wayback/network failure that escaped processItem's own try/catch should never fail the job.
 console.error('archive-check: unexpected error (continuing would not help further; not a Morum API failure):',error);
 process.exit(0);
});
