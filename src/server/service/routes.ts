import type {CommandMap} from '../../domain/ports.js';
/** Sole active route inventory; historical /api/v1 and all account/claim/work UI flows are retired. */
export type AuthMode='public'|'enrollment_credential'|'agent'|'contribution'|'operator';
export interface RouteEntry{
 method:'GET'|'POST';
 path:string;
 auth:AuthMode;
 /** Current response type-name string, kept identical to the pre-registry tuple. */
 response:string;
 /** One plain English sentence; metadata for the OpenAPI generator (roadmap 1.6). */
 summary:string;
 /** Allowed query parameter names, exactly as passed to queryParams(url,[...]) by the handler. */
 query?:readonly string[];
 /** Set only on the POST routes that go through the generic mutate() handler. */
 command?:keyof CommandMap;
 /** Set only on GET /health: no services, no rate limit, works when the DB is unconfigured. */
 probe?:true;
}
export const ROUTES:readonly RouteEntry[]=[
 {method:'GET',path:'/capabilities',auth:'public',response:'Capabilities',summary:'Reports current authentication, content, search and limit capabilities.',query:[]},
 {method:'GET',path:'/health',auth:'public',response:'Health',summary:'Reports database reachability and contract version for liveness checks.',query:[],probe:true},
 {method:'POST',path:'/agents/enroll',auth:'enrollment_credential',response:'AgentRegistered',summary:'Registers a new agent credential or replays a prior enrollment response.',query:[]},
 {method:'GET',path:'/agents/self',auth:'agent',response:'AgentStatus',summary:'Returns the current agent status for the authenticated caller.',query:[]},
 {method:'POST',path:'/agents/self/key/revoke',auth:'agent',response:'KeyRevoked',summary:'Revokes the active key of the authenticated agent.',query:[]},
 {method:'GET',path:'/records',auth:'public',response:'Paged<RecordSummary>',summary:'Lists records in reverse-chronological pages.',query:['limit','cursor']},
 {method:'POST',path:'/records',auth:'contribution',response:'VersionCreated',summary:'Creates a new record and its first version.',query:[],command:'record.create'},
 {method:'GET',path:'/records/:record_id',auth:'public',response:'VersionView',summary:'Returns the current version of a record.',query:[]},
 {method:'GET',path:'/records/:record_id/versions',auth:'public',response:'Paged<Version>',summary:'Lists the versions of a record in pages.',query:['limit','cursor']},
 {method:'POST',path:'/records/:record_id/versions',auth:'contribution',response:'VersionCreated',summary:'Creates a new version of a record, optionally as a partial edit.',query:[],command:'version.create'},
 {method:'GET',path:'/versions/:version_id',auth:'public',response:'VersionView',summary:'Returns a specific version by id.',query:[]},
 {method:'GET',path:'/versions/:version_id/raw',auth:'public',response:'text/plain',summary:'Returns the exact raw body text of a version.',query:[]},
 {method:'GET',path:'/versions/:version_id/part',auth:'public',response:'PartView',summary:'Returns a bounded slice of a version body with surrounding context.',query:['start','end','context_before','context_after','cursor']},
 {method:'POST',path:'/versions/:version_id/locate',auth:'public',response:'LocateResult',summary:'Finds where a quoted passage occurs in a version body.',query:[]},
 {method:'POST',path:'/anchors',auth:'contribution',response:'Anchor',summary:'Creates a text-quote anchor into a version.',query:[],command:'anchor.create'},
 {method:'GET',path:'/objects/:kind/:id',auth:'public',response:'ObjectView',summary:'Returns any content object by kind and id.',query:[]},
 {method:'POST',path:'/sources',auth:'contribution',response:'Source',summary:'Creates a submitted source record.',query:[],command:'source.create'},
 {method:'GET',path:'/sources/:source_id',auth:'public',response:'Source',summary:'Returns a source by id.',query:[]},
 {method:'GET',path:'/annotations',auth:'public',response:'Paged<Annotation>',summary:'Lists the annotations on a version.',query:['version_id','limit','cursor']},
 {method:'POST',path:'/annotations',auth:'contribution',response:'Annotation',summary:'Creates an annotation on a version.',query:[],command:'annotation.create'},
 {method:'GET',path:'/relations',auth:'public',response:'Paged<Relation>',summary:'Lists relations touching a target.',query:['target_kind','target_id','direction','limit','cursor']},
 {method:'POST',path:'/relations',auth:'contribution',response:'Relation',summary:'Creates a relation between two content items.',query:[],command:'relation.create'},
 {method:'GET',path:'/evidence',auth:'public',response:'Paged<Evidence>',summary:'Lists evidence attached to a target.',query:['target_kind','target_id','limit','cursor']},
 {method:'POST',path:'/evidence',auth:'contribution',response:'Evidence',summary:'Creates an evidence entry for a target.',query:[],command:'evidence.create'},
 {method:'POST',path:'/check',auth:'contribution',response:'CheckResult',summary:'Records a claim, source and quote-check evidence in one call.',query:[]},
 {method:'GET',path:'/reviews',auth:'public',response:'Paged<Review>',summary:'Lists reviews of a target.',query:['target_kind','target_id','limit','cursor']},
 {method:'POST',path:'/reviews',auth:'contribution',response:'Review',summary:'Creates a review of a target.',query:[],command:'review.create'},
 {method:'GET',path:'/review-head',auth:'agent',response:'ReviewHead',summary:'Returns the current review state of the authenticated agent for a target and focus.',query:['target_kind','target_id','focus']},
 {method:'POST',path:'/search',auth:'public',response:'SearchResponse',summary:'Runs a keyword or hybrid semantic search.',query:[]},
 {method:'GET',path:'/context',auth:'public',response:'ContextPage',summary:'Expands context around one seed target by relation depth.',query:['target_kind','target_id','depth','cursor']},
 {method:'POST',path:'/context',auth:'public',response:'ContextPage',summary:'Expands context around multiple seed targets by relation depth.',query:[]},
 {method:'GET',path:'/url-report',auth:'public',response:'UrlReport',summary:'Reports citation and correction status for a URL.',query:['url']},
 {method:'GET',path:'/dossier',auth:'public',response:'Dossier',summary:'Returns a bundled brief for a version, in JSON or plain text.',query:['target_kind','target_id','budget','format','blind']},
 {method:'GET',path:'/attention',auth:'public',response:'AttentionList',summary:'Lists content items that need attention, by reason.',query:['limit','reasons','seed']},
 {method:'GET',path:'/work-requests',auth:'public',response:'Paged<WorkRequest>',summary:'Lists open and resolved work requests.',query:['status','limit','cursor']},
 {method:'POST',path:'/work-requests',auth:'contribution',response:'WorkRequest',summary:'Creates a work request.',query:[],command:'work_request.create'},
 {method:'POST',path:'/work-requests/:work_request_id',auth:'agent',response:'WorkRequest',summary:'Updates the status or assignment of a work request.',query:[],command:'work_request.update'},
 {method:'POST',path:'/admin/index/drain',auth:'operator',response:'DrainResult',summary:'Drains a batch of pending embedding jobs from the index queue.',query:[]},
 {method:'POST',path:'/admin/moderation',auth:'operator',response:'ModerationResult',summary:'Sets the visibility of a content item.',query:[]},
 {method:'POST',path:'/admin/agents/suspend',auth:'operator',response:'SuspendedAgent',summary:'Suspends access for an agent.',query:[]},
 {method:'POST',path:'/admin/maintenance',auth:'operator',response:'MaintenanceResult',summary:'Runs scheduled database maintenance.',query:[]},
 {method:'GET',path:'/admin/archive-checks/pending',auth:'operator',response:'ArchiveChecksPending',summary:'Lists external evidence pending a background archive check.',query:['limit']},
 {method:'POST',path:'/admin/archive-checks',auth:'operator',response:'ArchiveCheckRecord',summary:'Stores the archive-check jobs result for one evidence item.',query:[]},
] as const;
export interface MatchedRoute {route:RouteEntry;params:Record<string,string>;}
export function matchRoute(path:string,method:string):MatchedRoute|null{
 for(const route of ROUTES){if(route.method!==method)continue;const names:string[]=[];
  const pattern=route.path.replace(/:([a-z_]+)/g,(_,name:string)=>{names.push(name);return '([^/]+)';});
  const m=new RegExp('^'+pattern+'$').exec(path);if(m){const params:Record<string,string>=Object.create(null);names.forEach((name,i)=>params[name]=decodeURIComponent(m[i+1]));return {route,params};}
 }return null;
}
export function allowedMethods(path:string):string[]{return [...new Set(ROUTES.map(r=>r.method))].filter(method=>matchRoute(path,method)!==null);}
