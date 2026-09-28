import 'server-only';
import {randomUUID} from 'node:crypto';
import type {CommandMap} from '../../../domain/ports.js';
import {ensure} from '../../../domain/errors.js';
import {validateCommand,normalizeRecordRequest} from '../../../domain/validation.js';
import {mutate} from '../../../domain/mutate.js';
import {readJson,readRecordBody,queryParams,readIdempotencyKey,parseDeclaredAgent} from '../transport.js';
import {signatureMeta} from '../web-bot-auth.js';
import type {SignerResult} from '../web-bot-auth.js';
import type {Handler} from './index.js';
import type {Services} from '../factory.js';

/** Object kind + id that a given command's output represents, for knowledge.signatures (roadmap:
 * optional Web Bot Auth verification, stage19-signatures). Matches the object_kind CHECK list. */
function signedObject(op:keyof CommandMap,pathId:string|undefined,data:unknown):{kind:string;id:string}{
 const d=data as Record<string,unknown>;
 if(op==='record.create'||op==='version.create'){const version=d.version as Record<string,unknown>;return {kind:'version',id:version.id as string};}
 if(op==='work_request.update')return {kind:'work_request',id:pathId as string};
 const kind=op.split('.')[0];
 return {kind,id:d.id as string};
}

/** Records a verified signature against the object this command just wrote. Never fatal: a
 * failure to record is logged and the response is unaffected (spec: "Failure to record is
 * non-fatal"). No-op unless the signature actually verified. */
async function recordSignatureIfVerified(s:Services,result:SignerResult,op:keyof CommandMap,pathId:string|undefined,data:unknown,signatureInput:string|null,signature:string|null):Promise<void>{
 if(result.state!=='verified')return;
 try{
  const {kind,id}=signedObject(op,pathId,data);
  await s.db.call('kb_record_signature',{p_query:{
   object_kind:kind,object_id:id,
   signer_origin:result.origin,key_thumbprint:result.key_thumbprint,
   created:result.created,expires:result.expires,
   signature_input:signatureInput,signature,
  }});
 }catch{/* never let recording affect the response */}
}

/** One generic handler for every ROUTES entry that carries a `command` (the ten contribution/agent mutate POSTs). */
export const mutationHandler:Handler=async (ctx)=>{
 const {request,url,route,params:p,services:s,contributor,actor,respond,setWriteKey}=ctx;
 queryParams(url,[]);
 const op=route.command;ensure(op,'NOT_FOUND');
 const requestKey:string=request.headers.has('idempotency-key')?readIdempotencyKey(request):randomUUID();setWriteKey(requestKey);
 const body=op==='record.create'?normalizeRecordRequest(await readRecordBody(request)):await readJson(request);validateCommand(op,body);
 const declared=parseDeclaredAgent(request.headers.get('morum-agent'));
 const pathId=p.record_id??p.work_request_id;
 // Roadmap: optional Web Bot Auth (RFC 9421) verification, run AFTER auth succeeds and NEVER
 // rejecting the request on an absent or invalid signature (docs/design/2026-09-25-hash-identity.md
 // stage 2: signatures are optional; null allowed).
 const signer=await s.verifySignature(request);
 const result=await mutate(s.repo,contributor??actor!,op,body as CommandMap[typeof op]['input'],requestKey,pathId,declared);
 if(!result.replayed)await recordSignatureIfVerified(s,signer,op,pathId,result.data,request.headers.get('signature-input'),request.headers.get('signature'));
 return respond(result.data,result.replayed,result.replayed?200:201,undefined,{signature:signatureMeta(signer)});
};
