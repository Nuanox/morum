import 'server-only';
import type * as T from '../../../contracts/types.js';
import {ensure} from '../../../domain/errors.js';
import {object,integer,text,uuid,ref,CONTENT} from '../../../domain/validation.js';
import {queryParams,intQuery,readJson} from '../transport.js';
import type {Handler} from './index.js';

export const drain:Handler=async ({request,url,services:s,actor,respond})=>{
 queryParams(url,[]);const q=await readJson(request,16384);
 const input=object(q,['limit'],['limit']);integer(input.limit,1,3);return respond(await s.worker.drain(actor!,input.limit));
};

export const maintenance:Handler=async ({request,url,services:s,actor,respond})=>{
 queryParams(url,[]);const q=await readJson(request,16384);
 object(q,[]);return respond(await s.db.call('kb_maintenance',{p_actor:actor}));
};

export const moderation:Handler=async ({request,url,services:s,actor,respond})=>{
 queryParams(url,[]);const q=await readJson(request,16384);
 const input=object(q,['target','visibility','reason'],['target','visibility','reason']);ref(input.target,['record',...CONTENT]);ensure(['public','hidden','tombstone'].includes(input.visibility as string));text(input.reason,2000);
 return respond(await s.db.call('kb_moderate',{p_actor:actor,p_query:input}));
};

export const suspend:Handler=async ({request,url,services:s,actor,respond})=>{
 queryParams(url,[]);const q=await readJson(request,16384);
 const input=object(q,['agent_id','reason'],['agent_id','reason']);uuid(input.agent_id);text(input.reason,2000);return respond(await s.db.call('kb_suspend_agent',{p_actor:actor,p_query:input}));
};

/** GET /admin/metrics/lookups: roadmap 2.11 (extended) adoption metrics -- hit rate, write-back
 * rate, distinct operators/agent keys, over the lookup log recorded non-fatally by url-report and
 * check (see supabase/migrations/202609200122_lookup_log.sql). Operator-only, like the other
 * /admin routes. */
export const lookupMetrics:Handler=async ({url,services:s,actor,respond})=>{
 const q=queryParams(url,['days']);
 const days=intQuery(q.days,1,365,30);
 const result=await s.db.call<T.LookupMetrics>('kb_lookup_metrics',{p_actor:actor,p_query:{days}});
 return respond(result);
};
