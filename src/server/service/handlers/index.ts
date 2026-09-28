import 'server-only';
import type * as T from '../../../contracts/types.js';
import type {Services} from '../factory.js';
import type {AgentContext} from '../auth.js';
import type {RouteEntry} from '../routes.js';
import * as system from './system.js';
import * as agents from './agents.js';
import * as retrieval from './retrieval.js';
import * as surfaces from './surfaces.js';
import * as reads from './reads.js';
import * as admin from './admin.js';
import * as archive from './archive.js';
import * as mutations from './mutations.js';
import * as check from './check.js';

export type RespondFn=(data:unknown,replayed?:boolean,status?:number,maxBytes?:number)=>Response;
/** Everything a handler needs; built once per request in http.ts after auth resolves. */
export interface HandlerContext{
 request:Request;url:URL;requestId:string;route:RouteEntry;params:Record<string,string>;
 services:Services;client:string;actor?:AgentContext;contributor?:T.AuthContext;
 respond:RespondFn;
 rawResponse:(body:string|null,headers:Record<string,string>,status?:number)=>Response;
 setWriteKey:(key:string)=>void;
}
export type Handler=(ctx:HandlerContext)=>Promise<Response>;

/** GET /health is dispatched by http.ts's own probe short-circuit (see handlers/system.ts healthProbe), not through this map. */
export const HANDLERS:ReadonlyMap<string,Handler>=new Map<string,Handler>([
 ['GET /capabilities',system.capabilities],
 ['POST /agents/enroll',agents.enroll],
 ['GET /agents/self',agents.self],
 ['POST /agents/self/key/revoke',agents.revoke],
 ['GET /records',reads.listRecords],
 ['POST /records',mutations.mutationHandler],
 ['GET /records/:record_id',reads.getRecord],
 ['GET /records/:record_id/versions',reads.listVersions],
 ['POST /records/:record_id/versions',mutations.mutationHandler],
 ['GET /versions/:version_id',reads.getVersion],
 ['GET /versions/:version_id/raw',reads.getRaw],
 ['GET /versions/:version_id/part',reads.getPart],
 ['POST /versions/:version_id/locate',reads.locate],
 ['POST /anchors',mutations.mutationHandler],
 ['GET /objects/:kind/:id',reads.getObject],
 ['POST /sources',mutations.mutationHandler],
 ['GET /sources/:source_id',reads.getSource],
 ['GET /annotations',reads.listAnnotations],
 ['POST /annotations',mutations.mutationHandler],
 ['GET /relations',reads.listRelations],
 ['POST /relations',mutations.mutationHandler],
 ['GET /evidence',reads.listEvidence],
 ['POST /evidence',mutations.mutationHandler],
 ['POST /check',check.check],
 ['GET /reviews',reads.listReviews],
 ['POST /reviews',mutations.mutationHandler],
 ['GET /review-head',retrieval.reviewHead],
 ['POST /search',retrieval.search],
 ['GET /context',retrieval.context],
 ['POST /context',retrieval.context],
 ['GET /url-report',surfaces.urlReport],
 ['GET /dossier',surfaces.dossier],
 ['GET /attention',surfaces.attention],
 ['GET /work-requests',reads.listWorkRequests],
 ['POST /work-requests',mutations.mutationHandler],
 ['POST /work-requests/:work_request_id',mutations.mutationHandler],
 ['POST /admin/index/drain',admin.drain],
 ['POST /admin/moderation',admin.moderation],
 ['POST /admin/agents/suspend',admin.suspend],
 ['POST /admin/maintenance',admin.maintenance],
 ['GET /admin/archive-checks/pending',archive.pending],
 ['POST /admin/archive-checks',archive.record],
 ['GET /admin/metrics/lookups',admin.lookupMetrics],
]);
