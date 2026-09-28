import 'server-only';
import type {RpcClient} from '../../domain/ports.js';
import {DomainError,ensure,fail,mapDatabaseError} from '../../domain/errors.js';
/** No service secret can be imported into a client component through this module. */
export interface DatabaseConfig {url:string;secretKey:string;keyMode?:'publishable_secret'|'legacy';timeoutMs?:number;maxResponseBytes?:number;}
const RPC_NAMES=new Set([
 'kb_enroll_agent','kb_lookup_key','kb_agent_status','kb_revoke_key','kb_review_head','kb_rate_limit','kb_health','kb_moderate','kb_suspend_agent','kb_search','kb_context','kb_search_state','kb_embedding_claim','kb_embedding_finish','kb_embedding_status','kb_maintenance',
 'kb_url_report','kb_dossier','kb_attention','kb_locate','kb_archive_checks_pending','kb_record_archive_check',
 'kb_record_lookup','kb_lookup_metrics',
 'kb_create_record','kb_create_version','kb_create_anchor','kb_create_source','kb_create_relation',
 'kb_create_annotation','kb_create_evidence','kb_create_review','kb_create_work_request','kb_update_work_request',
 'kb_get_record','kb_get_version','kb_get_raw','kb_get_part','kb_get_source','kb_get_object',
 'kb_list_versions','kb_list_records','kb_list_relations','kb_list_annotations','kb_list_evidence','kb_list_reviews','kb_list_work_requests'
]);
export function databaseConfig(env:NodeJS.ProcessEnv=process.env):DatabaseConfig {
 const keyMode=env.SUPABASE_KEY_MODE??'publishable_secret';
 ensure(keyMode==='publishable_secret'||keyMode==='legacy','NOT_CONFIGURED');
 const url=env.NEXT_PUBLIC_SUPABASE_URL,secretKey=keyMode==='legacy'?env.SUPABASE_SERVICE_ROLE_KEY:env.SUPABASE_SECRET_KEY;
 if(!url||!secretKey)fail('NOT_CONFIGURED');
 return {url,secretKey,keyMode};
}
/** Single-object reads embed every attached basis item, so a few large evidence rows must not make an exact version unreadable (worst case ~1.8 MB). */
export const SINGLE_OBJECT_MAX_BYTES=3145728;
const SINGLE_OBJECT_RPCS=new Set(['kb_get_record','kb_get_version','kb_get_object']);
async function boundedText(response:Response,max:number):Promise<string> {
 const reader=response.body?.getReader();if(!reader)fail('DEPENDENCY_UNAVAILABLE');
 const chunks:Uint8Array[]=[];let bytes=0;
 try {while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;
  if(bytes>max){await reader.cancel();fail('PAYLOAD_TOO_LARGE');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const data=new Uint8Array(bytes);let at=0;for(const c of chunks){data.set(c,at);at+=c.length;}
 try{return new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{fail('DEPENDENCY_UNAVAILABLE');}
}
export class SupabaseRpcClient implements RpcClient {
 private readonly origin:string;private readonly config:DatabaseConfig;
 constructor(config:DatabaseConfig,private readonly transport:typeof fetch=fetch){
  let url:URL;try{url=new URL(config.url);}catch{fail('NOT_CONFIGURED');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  ensure((url.protocol==='https:'||(local&&url.protocol==='http:'))&&!url.username&&!url.password&&!url.search&&!url.hash&&(url.pathname==='/'||url.pathname===''),'NOT_CONFIGURED');
  ensure(config.secretKey.length>=20,'NOT_CONFIGURED');
  // This URL is trusted server configuration, never a submitted Source.url.
  this.origin=url.origin;this.config={...config};
 }
 async call<T>(name:string,args:Record<string,unknown>):Promise<T>{
  ensure(RPC_NAMES.has(name),'FORBIDDEN');const body=JSON.stringify(args);
  for(let attempt=0;attempt<3;attempt++){
   try{
    const key=this.config.secretKey;
    // New sb_secret keys belong only in apikey; legacy JWT service keys also use Bearer.
    const headers:Record<string,string>={'content-type':'application/json','accept':'application/json','apikey':key};
    if(this.config.keyMode==='legacy')headers.authorization=`Bearer ${key}`;
    const response=await this.transport(`${this.origin}/rest/v1/rpc/${name}`,{
     method:'POST',headers,body,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(this.config.timeoutMs??15000)
    });
    let value:unknown;try{value=JSON.parse(await boundedText(response,SINGLE_OBJECT_RPCS.has(name)?Math.max(SINGLE_OBJECT_MAX_BYTES,this.config.maxResponseBytes??0):this.config.maxResponseBytes??1048576));}
    catch(error){if(error instanceof DomainError)throw error;fail('DEPENDENCY_UNAVAILABLE');}
    if(!response.ok){
     const driver=value as {code?:unknown};const retry=driver?.code==='40001'||driver?.code==='40P01';
     if(retry&&attempt<2)continue; // Same body, same permanent idempotency receipt key.
     if(response.status===401||response.status===403)fail('NOT_CONFIGURED');
     throw mapDatabaseError(value);
    }
    // Server-issued PostgREST JSON is the DTO boundary; SQL tests assert exact shapes.
    return value as T;
   }catch(error){if(error instanceof DomainError)throw error;fail('DEPENDENCY_UNAVAILABLE');}
  }
  fail('DEPENDENCY_UNAVAILABLE');
 }
}
