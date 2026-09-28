import 'server-only';
import type {Health} from '../../contracts/types.js';
import {SupabaseRpcClient,databaseConfig} from '../db/client.js';
import {KnowledgeRepository} from '../db/knowledge-repository.js';
import {CursorCodec} from '../db/cursor.js';
import {ensure,fail} from '../../domain/errors.js';
import {AgentAuth} from './auth.js';
import {RateLimiter} from './rate-limit.js';
import {Embeddings,IndexWorker,embeddingConfig} from './embeddings.js';
import {Retrieval} from './retrieval.js';
import {verifyWebBotAuth} from './web-bot-auth.js';
import type {SignerResult} from './web-bot-auth.js';
import type {RpcClient} from '../../domain/ports.js';
export interface Services {
 db:RpcClient;repo:KnowledgeRepository;auth:AgentAuth;rates:RateLimiter;
 embeddings:Embeddings;retrieval:Retrieval;worker:IndexWorker;
 /** Optional Web Bot Auth (RFC 9421) verification for the write handlers. Injectable so service
  * tests can stub the key-directory fetch without a real network call; production uses the
  * default fetchDirectory (see web-bot-auth.ts). Never rejects a request itself. */
 verifySignature:(request:Request)=>Promise<SignerResult>;
}
/** Lazy factory: imports and Next build never contact a database or provider. */
export function createServices(env:NodeJS.ProcessEnv=process.env):Services{
 const db=new SupabaseRpcClient(databaseConfig(env));
 const cursorKey=env.CURSOR_SIGNING_KEY,pepper=env.AGENT_KEY_PEPPER||undefined;
 if(!cursorKey)fail('NOT_CONFIGURED');
 let trustedHeader:string|undefined;
 if(env.TRUSTED_CLIENT_IP_HEADER){ensure(env.TRUSTED_PROXY_CONFIRMED==='true','NOT_CONFIGURED');const configuredHeader=String(env.TRUSTED_CLIENT_IP_HEADER).toLowerCase();ensure(['x-real-ip','x-vercel-forwarded-for'].includes(configuredHeader),'NOT_CONFIGURED');trustedHeader=configuredHeader;}
 const cursors=new CursorCodec(cursorKey),rates=new RateLimiter(db,cursorKey,trustedHeader);
 const auth=new AgentAuth(db,pepper,env.AGENT_REGISTRATION_ENABLED==='true');
 const embeddings=new Embeddings(embeddingConfig(env),rates);
 return {db,repo:new KnowledgeRepository(db,cursors),auth,rates,embeddings,retrieval:new Retrieval(db,cursors,embeddings),worker:new IndexWorker(db,embeddings),verifySignature:(request)=>verifyWebBotAuth(request)};
}
export async function readHealth(env:NodeJS.ProcessEnv=process.env):Promise<Health>{return new SupabaseRpcClient(databaseConfig(env)).call('kb_health',{});}
