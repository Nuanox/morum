import 'server-only';
import {createHash,createPublicKey,verify as cryptoVerify,constants as cryptoConstants} from 'node:crypto';

/**
 * Optional Web Bot Auth (RFC 9421 HTTP Message Signatures) verification for writes.
 * draft-ietf-webbotauth-httpsig-protocol-00 (webbotauth WG, 2026-09-01).
 *
 * This module NEVER rejects a request: verifyWebBotAuth only classifies a request as
 * absent / invalid / verified. Callers (handlers/mutations.ts, handlers/check.ts) attach the
 * result to the response as additive metadata and otherwise process the request identically,
 * per docs/design/2026-09-25-hash-identity.md stage 2 (signatures are optional; null allowed).
 */

// ============================================================================================
// RFC 8941 Structured Fields: minimal parser/serializer for the subset this module needs
// (Dictionary, Inner List, String, Token, Byte Sequence, Integer, Boolean, Parameters).
// ============================================================================================

export type SfToken={readonly token:string};
export type SfBare=string|number|boolean|Uint8Array|SfToken;
export interface SfItem{readonly value:SfBare;readonly params:ReadonlyMap<string,SfBare>;}
export interface SfInnerList{readonly items:readonly SfItem[];readonly params:ReadonlyMap<string,SfBare>;}
export type SfDictValue=SfItem|SfInnerList;

function isInnerList(v:SfDictValue):v is SfInnerList{return 'items' in v;}
function isToken(v:SfBare):v is SfToken{return typeof v==='object'&&v!==null&&'token' in v;}

class SfParseError extends Error{}

class SfParser{
 private i=0;
 constructor(private readonly s:string){}
 private err():never{throw new SfParseError('structured_field_parse_error');}
 private ws():void{while(this.s[this.i]===' ')this.i++;}
 private eof():boolean{return this.i>=this.s.length;}
 parseDictionary():Map<string,SfDictValue>{
  const map=new Map<string,SfDictValue>();
  this.ws();
  if(this.eof())return map;
  for(;;){
   const key=this.parseKey();
   let value:SfDictValue;
   if(this.s[this.i]==='='){
    this.i++;
    value=this.s[this.i]==='('?this.parseInnerList():this.parseItemValue();
   }else{
    value={value:true,params:this.parseParameters()};
   }
   map.set(key,value);
   this.ws();
   if(this.eof())break;
   if(this.s[this.i]!==',')this.err();
   this.i++;this.ws();
   if(this.eof())this.err();
  }
  return map;
 }
 private parseKey():string{
  const m=/^[a-z*][a-z0-9_.*-]*/.exec(this.s.slice(this.i));
  if(!m)this.err();this.i+=m[0].length;return m[0];
 }
 private parseItemValue():SfItem{
  const value=this.parseBareItem();
  const params=this.parseParameters();
  return {value,params};
 }
 private parseInnerList():SfInnerList{
  if(this.s[this.i]!=='(')this.err();this.i++;this.ws();
  const items:SfItem[]=[];
  while(this.s[this.i]!==')'){
   if(this.eof())this.err();
   items.push(this.parseItemValue());
   this.ws();
   if(this.s[this.i]===')')break;
  }
  this.i++;
  const params=this.parseParameters();
  return {items,params};
 }
 private parseParameters():Map<string,SfBare>{
  const params=new Map<string,SfBare>();
  for(;;){
   this.ws();
   if(this.s[this.i]!==';')break;
   this.i++;this.ws();
   const key=this.parseKey();
   let value:SfBare=true;
   if(this.s[this.i]==='='){this.i++;value=this.parseBareItem();}
   params.set(key,value);
  }
  return params;
 }
 private parseBareItem():SfBare{
  const c=this.s[this.i];
  if(c==='"')return this.parseString();
  if(c===':')return this.parseByteSequence();
  if(c==='?')return this.parseBoolean();
  if(c==='-'||(c>='0'&&c<='9'))return this.parseNumber();
  if(c!==undefined&&/[A-Za-z*]/.test(c))return this.parseToken();
  this.err();
 }
 private parseString():string{
  if(this.s[this.i]!=='"')this.err();this.i++;
  let out='';
  for(;;){
   const c=this.s[this.i];
   if(c===undefined)this.err();
   if(c==='"'){this.i++;return out;}
   if(c==='\\'){
    this.i++;const n=this.s[this.i];
    if(n!=='"'&&n!=='\\')this.err();
    out+=n;this.i++;continue;
   }
   const code=c.charCodeAt(0);
   if(code<0x20||code>0x7e)this.err();
   out+=c;this.i++;
  }
 }
 private parseToken():SfToken{
  const m=/^[A-Za-z*][A-Za-z0-9:/!#$%&'*+\-.^_`|~]*/.exec(this.s.slice(this.i));
  if(!m)this.err();this.i+=m[0].length;return {token:m[0]};
 }
 private parseByteSequence():Uint8Array{
  if(this.s[this.i]!==':')this.err();this.i++;
  const end=this.s.indexOf(':',this.i);if(end<0)this.err();
  const b64=this.s.slice(this.i,end);this.i=end+1;
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(b64))this.err();
  try{return new Uint8Array(Buffer.from(b64,'base64'));}catch{this.err();}
 }
 private parseBoolean():boolean{
  if(this.s[this.i]!=='?')this.err();this.i++;
  const c=this.s[this.i];
  if(c==='0'){this.i++;return false;}
  if(c==='1'){this.i++;return true;}
  this.err();
 }
 private parseNumber():number{
  const m=/^-?[0-9]+(\.[0-9]+)?/.exec(this.s.slice(this.i));
  if(!m)this.err();this.i+=m[0].length;
  const intDigits=m[0].replace('-','').split('.')[0];
  if(intDigits.length>15)this.err();
  return Number(m[0]);
 }
}

/** Returns undefined (never throws) so callers can treat a malformed header as absent. */
export function tryParseDictionary(headerValue:string):Map<string,SfDictValue>|undefined{
 try{return new SfParser(headerValue).parseDictionary();}catch{return undefined;}
}

function serializeBareItem(v:SfBare):string{
 if(typeof v==='boolean')return v?'?1':'?0';
 if(typeof v==='number'){
  if(Number.isInteger(v))return String(v);
  return v.toFixed(3);
 }
 if(v instanceof Uint8Array)return ':'+Buffer.from(v).toString('base64')+':';
 if(isToken(v))return v.token;
 return '"'+v.replace(/[\\"]/g,c=>'\\'+c)+'"';
}
function serializeParams(params:ReadonlyMap<string,SfBare>):string{
 let out='';
 for(const [k,v] of params){out+=';'+k;if(!(v===true))out+='='+serializeBareItem(v);}
 return out;
}
function serializeItem(item:SfItem):string{return serializeBareItem(item.value)+serializeParams(item.params);}
function serializeInnerList(list:SfInnerList):string{
 return '('+list.items.map(serializeItem).join(' ')+')'+serializeParams(list.params);
}

// ============================================================================================
// RFC 9421 signature base construction
// ============================================================================================

interface ComponentId{readonly name:string;readonly params:ReadonlyMap<string,SfBare>;}

function componentIdentifiers(list:SfInnerList):ComponentId[]{
 return list.items.map(it=>{
  if(typeof it.value!=='string')throw new Error('bad_component_identifier');
  return {name:it.value.toLowerCase(),params:it.params};
 });
}

/**
 * Derives the authority the same way the rest of the server would derive an externally-visible
 * origin behind Vercel: `x-forwarded-host` when present (Vercel always sets it on the edge),
 * else the `host` header. DEVIATION: the codebase has no existing `APP_URL`-derivation helper to
 * mirror (grepped; none found), so this is a fresh, narrowly-scoped choice, documented here and
 * in docs/OPERATIONS.md, rather than a reuse of prior art.
 */
function authorityOf(request:Request,url:URL):string{
 const forwarded=request.headers.get('x-forwarded-host');
 return (forwarded??request.headers.get('host')??url.host).split(',')[0].trim().toLowerCase();
}

function derangeComponentValue(request:Request,url:URL,id:ComponentId):string{
 switch(id.name){
  case '@method':return request.method.toUpperCase();
  case '@target-uri':return url.toString();
  case '@authority':return authorityOf(request,url);
  case '@scheme':return url.protocol.replace(':','').toLowerCase();
  case '@path':return url.pathname===''?'/':url.pathname;
  case '@query':return url.search===''?'?':url.search;
  default:break;
 }
 if(id.name.startsWith('@'))throw new Error('unsupported_derived_component');
 const raw=request.headers.get(id.name);
 if(raw===null)throw new Error('missing_component');
 const keyParam=id.params.get('key');
 if(keyParam!==undefined){
  if(typeof keyParam!=='string')throw new Error('bad_key_param');
  const dict=new SfParser(raw).parseDictionary();
  const entry=dict.get(keyParam);
  if(entry===undefined)throw new Error('missing_dictionary_key');
  if(isInnerList(entry))throw new Error('unsupported_inner_list_component');
  return serializeItem(entry);
 }
 if(id.params.get('bs')===true)return ':'+Buffer.from(raw,'utf8').toString('base64')+':';
 if(id.params.get('sf')===true){
  const dict=new SfParser(raw).parseDictionary();
  return [...dict.entries()].map(([k,v])=>isInnerList(v)?`${k}=${serializeInnerList(v)}`:v.value===true?k:`${k}=${serializeItem(v)}`).join(', ');
 }
 return raw.trim();
}

function componentIdLine(id:ComponentId):string{
 const item:SfItem={value:id.name,params:id.params};
 return serializeItem(item);
}

/** Builds the RFC 9421 signature base for one Signature-Input label's covered-components inner list. */
export function signatureBase(request:Request,url:URL,covered:SfInnerList):string{
 const ids=componentIdentifiers(covered);
 const lines=ids.map(id=>`${componentIdLine(id)}: ${derangeComponentValue(request,url,id)}`);
 lines.push(`"@signature-params": ${serializeInnerList(covered)}`);
 return lines.join('\n');
}

// ============================================================================================
// RFC 7638 JWK thumbprint
// ============================================================================================

export interface Jwk{readonly kty:string;readonly [key:string]:unknown;}

export function jwkThumbprint(jwk:Jwk):string{
 let ordered:Record<string,unknown>;
 if(jwk.kty==='OKP')ordered={crv:jwk.crv,kty:jwk.kty,x:jwk.x};
 else if(jwk.kty==='RSA')ordered={e:jwk.e,kty:jwk.kty,n:jwk.n};
 else if(jwk.kty==='EC')ordered={crv:jwk.crv,kty:jwk.kty,x:jwk.x,y:jwk.y};
 else throw new Error('unsupported_kty');
 const json=JSON.stringify(ordered);
 return createHash('sha256').update(json,'utf8').digest('base64url');
}

// ============================================================================================
// Verification
// ============================================================================================

export type SignerResult =
 | {readonly state:'absent'}
 | {readonly state:'invalid';readonly reason:string}
 | {readonly state:'verified';readonly origin:string;readonly key_thumbprint:string;readonly created:number;readonly expires:number};

export interface JwksDirectory{readonly keys:readonly Jwk[];}
export type FetchDirectory=(origin:string)=>Promise<JwksDirectory|null>;

const DIRECTORY_MEDIA_TYPE='application/http-message-signatures-directory+json';
const CACHE_TTL_MS=60*60*1000;
const NEGATIVE_CACHE_TTL_MS=5*60*1000;
const MAX_CACHED_ORIGINS=256;
const MAX_DIRECTORY_BYTES=64*1024;
const FETCH_TIMEOUT_MS=3000;

interface CacheEntry{readonly at:number;readonly value:JwksDirectory|null;}
const directoryCache=new Map<string,CacheEntry>();

function cacheGet(origin:string):JwksDirectory|null|undefined{
 const entry=directoryCache.get(origin);
 if(!entry)return undefined;
 const ttl=entry.value===null?NEGATIVE_CACHE_TTL_MS:CACHE_TTL_MS;
 if(Date.now()-entry.at>ttl){directoryCache.delete(origin);return undefined;}
 return entry.value;
}
function cacheSet(origin:string,value:JwksDirectory|null):void{
 if(!directoryCache.has(origin)&&directoryCache.size>=MAX_CACHED_ORIGINS){
  const oldestKey=directoryCache.keys().next().value;
  if(oldestKey!==undefined)directoryCache.delete(oldestKey);
 }
 directoryCache.set(origin,{at:Date.now(),value});
}
/** Test-only: clears the in-memory directory cache between unrelated test cases. */
export function clearDirectoryCache():void{directoryCache.clear();}

/**
 * Default directory fetcher: same-origin only, https, 3s timeout, 64 KiB cap, no cross-host
 * redirects, in-memory cache (1h positive / 5m negative, capped at 256 origins).
 */
export const defaultFetchDirectory:FetchDirectory=async (origin)=>{
 const cached=cacheGet(origin);
 if(cached!==undefined)return cached;
 let result:JwksDirectory|null=null;
 try{
  const target=new URL('/.well-known/http-message-signatures-directory',origin);
  if(target.protocol!=='https:')throw new Error('not_https');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
  try{
   const response=await fetch(target,{redirect:'manual',signal:controller.signal,headers:{accept:DIRECTORY_MEDIA_TYPE}});
   if(response.status>=300&&response.status<400)throw new Error('redirect_not_followed');
   if(!response.ok)throw new Error('bad_status');
   const reader=response.body?.getReader();
   if(!reader)throw new Error('no_body');
   const chunks:Uint8Array[]=[];let total=0;
   try{
    for(;;){
     const {done,value}=await reader.read();
     if(done)break;
     total+=value.length;
     if(total>MAX_DIRECTORY_BYTES)throw new Error('too_large');
     chunks.push(value);
    }
   }finally{reader.releaseLock();}
   const bytes=new Uint8Array(total);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
   const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(typeof parsed==='object'&&parsed!==null&&Array.isArray((parsed as {keys?:unknown}).keys))result=parsed as JwksDirectory;
  }finally{clearTimeout(timer);}
 }catch{result=null;}
 cacheSet(origin,result);
 return result;
};

function invalid(reason:string):SignerResult{return {state:'invalid',reason};}

export interface VerifyOptions{
 /** Current time in epoch seconds. Defaults to Date.now()/1000. */
 now?:number;
 fetchDirectory?:FetchDirectory;
 /**
  * Maximum allowed (expires - created) window, in seconds. Defaults to 24h, per spec. Test-only
  * escape hatch: the IETF draft's own Appendix E.2.1/E.1.1 example vectors use a deliberately
  * unrealistic multi-decade `expires` (illustrating the field, not a real deployment), which
  * would otherwise fail this repo's stricter 24h cap; tests that replay those literal vectors
  * pass a larger value here to isolate cryptographic correctness from that policy choice. Never
  * set by production callers (handlers/mutations.ts, handlers/check.ts), which use the default.
  */
 maxValiditySeconds?:number;
}

/** Verifies a signed request per draft-ietf-webbotauth-httpsig-protocol-00. Never throws. */
export async function verifyWebBotAuth(request:Request,options:VerifyOptions={}):Promise<SignerResult>{
 try{
  const sigInputHeader=request.headers.get('signature-input');
  const sigHeader=request.headers.get('signature');
  const agentHeader=request.headers.get('signature-agent');
  if(!sigInputHeader||!sigHeader||!agentHeader)return {state:'absent'};

  const now=options.now??Math.floor(Date.now()/1000);
  const fetchDirectory=options.fetchDirectory??defaultFetchDirectory;

  let inputDict:Map<string,SfDictValue>,sigDict:Map<string,SfDictValue>,agentDict:Map<string,SfDictValue>;
  try{
   inputDict=new SfParser(sigInputHeader).parseDictionary();
   sigDict=new SfParser(sigHeader).parseDictionary();
   agentDict=new SfParser(agentHeader).parseDictionary();
  }catch{return invalid('malformed_structured_field');}

  // Pick the first Signature-Input label whose parameters declare tag="web-bot-auth".
  let label:string|undefined,covered:SfInnerList|undefined;
  for(const [k,v] of inputDict){
   if(!isInnerList(v))continue;
   if(v.params.get('tag')==='web-bot-auth'){label=k;covered=v;break;}
  }
  if(label===undefined||covered===undefined)return invalid('no_web_bot_auth_signature');

  const params=covered.params;
  const created=params.get('created'),expires=params.get('expires'),keyid=params.get('keyid');
  if(typeof created!=='number'||!Number.isInteger(created))return invalid('missing_created');
  if(typeof expires!=='number'||!Number.isInteger(expires))return invalid('missing_expires');
  if(typeof keyid!=='string'||keyid.length===0)return invalid('missing_keyid');
  const alg=params.get('alg');
  if(alg!==undefined&&!isToken(alg)&&typeof alg!=='string')return invalid('bad_alg');
  const algName=alg===undefined?undefined:isToken(alg)?alg.token:typeof alg==='string'?alg:undefined;

  if(expires<=now)return invalid('expired');
  if(created>now+300)return invalid('created_in_future');
  if(expires-created>(options.maxValiditySeconds??24*3600))return invalid('validity_window_too_long');

  const names=covered.items.map(it=>typeof it.value==='string'?it.value.toLowerCase():'');
  if(!names.includes('@authority')&&!names.includes('@target-uri'))return invalid('missing_authority_or_target_uri');

  // Signature bytes for this label.
  const sigEntry=sigDict.get(label);
  if(!sigEntry||isInnerList(sigEntry)||!(sigEntry.value instanceof Uint8Array))return invalid('missing_signature_bytes');
  const signatureBytes=Buffer.from(sigEntry.value);

  // First Signature-Agent member whose type is 'directory' or absent, must be https.
  let agentOrigin:string|undefined;
  for(const [,v] of agentDict){
   if(isInnerList(v))continue;
   if(typeof v.value!=='string')continue;
   const type=v.params.get('type');
   const typeName=type===undefined?undefined:isToken(type)?type.token:typeof type==='string'?type:undefined;
   if(typeName!==undefined&&typeName!=='directory')continue;
   let u:URL;
   try{u=new URL(v.value);}catch{continue;}
   if(u.protocol!=='https:')continue;
   agentOrigin=u.origin;break;
  }
  if(agentOrigin===undefined)return invalid('no_usable_signature_agent');

  const url=new URL(request.url);
  let base:string;
  try{base=signatureBase(request,url,covered);}catch{return invalid('cannot_build_signature_base');}

  const directory=await fetchDirectory(agentOrigin);
  if(!directory)return invalid('directory_unavailable');
  const nowMs=now*1000;
  let matched:Jwk|undefined;
  for(const key of directory.keys){
   let thumb:string;
   try{thumb=jwkThumbprint(key);}catch{continue;}
   if(thumb!==keyid)continue;
   const nbf=key.nbf,exp=key.exp;
   if(typeof nbf==='number'&&nowMs<nbf*1000)continue;
   if(typeof exp==='number'&&nowMs>=exp*1000)continue;
   matched=key;break;
  }
  if(!matched)return invalid('key_not_found');

  const baseBytes=Buffer.from(base,'utf8');
  let ok=false;
  try{
   if(matched.kty==='OKP'&&(matched.crv==='Ed25519')&&(algName===undefined||algName==='ed25519')){
    const keyObject=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:matched.x} as JsonWebKeyLike,format:'jwk'});
    ok=cryptoVerify(null,baseBytes,keyObject,signatureBytes);
   }else if(matched.kty==='RSA'&&(algName===undefined||algName==='rsa-pss-sha512')){
    const keyObject=createPublicKey({key:{kty:'RSA',n:matched.n,e:matched.e} as JsonWebKeyLike,format:'jwk'});
    ok=cryptoVerify('sha512',baseBytes,{key:keyObject,padding:cryptoConstants.RSA_PKCS1_PSS_PADDING,saltLength:64},signatureBytes);
   }else{
    return invalid('unsupported_key_or_algorithm');
   }
  }catch{return invalid('verification_error');}
  if(!ok)return invalid('bad_signature');

  return {state:'verified',origin:agentOrigin,key_thumbprint:keyid,created,expires};
 }catch{
  return invalid('unexpected_error');
 }
}

// node:crypto's createPublicKey JWK typing is narrower than the JWKS shapes we parse from the
// wire; this local alias avoids importing node's internal JsonWebKey type just for a cast.
type JsonWebKeyLike={kty:string;crv?:string;x?:string;y?:string;n?:string;e?:string};

/** Shapes a SignerResult into the additive `meta.signature` object (handlers/mutations.ts, handlers/check.ts). */
export function signatureMeta(result:SignerResult):Record<string,unknown>{
 if(result.state==='verified')return {state:'verified',origin:result.origin};
 if(result.state==='invalid')return {state:'invalid',reason:result.reason};
 return {state:'absent'};
}
