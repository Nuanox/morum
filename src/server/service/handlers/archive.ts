import 'server-only';
import type * as T from '../../../contracts/types.js';
import {validateRecordArchiveCheckRequest} from '../../../domain/validation.js';
import {queryParams,intQuery,readJson} from '../transport.js';
import type {Handler} from './index.js';

/** GET /admin/archive-checks/pending: external evidence with a quote and a source url that has
 * never been archive-checked, or whose newest check is a stale (>7d) fetch_failed. The server
 * still never fetches a URL itself -- this only lists what scripts/archive-check.mjs should try. */
export const pending:Handler=async ({url,services:s,actor,respond})=>{
 const q=queryParams(url,['limit']);
 const limit=intQuery(q.limit,1,200,50);
 const result=await s.db.call<T.ArchiveChecksPending>('kb_archive_checks_pending',{p_actor:actor,p_query:{limit}});
 return respond(result);
};

/** POST /admin/archive-checks: stores one archive-check result produced by the background job
 * (scripts/archive-check.mjs). Operator-authenticated like the other /admin routes; the request
 * body itself is the job's own comparison, never fetched or re-derived server-side. */
export const record:Handler=async ({request,url,services:s,actor,respond})=>{
 queryParams(url,[]);
 const body=validateRecordArchiveCheckRequest(await readJson(request));
 const result=await s.db.call<T.ArchiveCheckRecord>('kb_record_archive_check',{p_actor:actor,p_query:body});
 return respond(result,false,201);
};
