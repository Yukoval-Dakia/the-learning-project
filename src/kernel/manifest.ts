// 内核契约 manifest/组合：声明元数据 + 组合期校验，不是运行时插件总线。字段按
// 第二实例原则加入；组合根见 src/capabilities/index.ts（静态、类型检查）。

import { type ZodTypeAny, z } from 'zod';
import { type JobDagMemberInput, type JobDependencyDecl, validateJobDag } from './job-dag';
import type { NightlyEligibilityFn } from './nightly-eligibility';
import type {
  ProposalAcceptDecl,
  ProposalDismissDecl,
  ProposalRetractDecl,
} from './proposals/types';

/** Web 标准 handler；组合根把路径参数透传为第二实参，无参路由忽略。 */
export type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequestSchemaDecl {
  /** 路径参数必须是 Zod object，且 key 与 `[param]` 段完全一致。 */
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  headers?: ZodTypeAny;
  body?: ZodTypeAny;
  /** 缺省为 application/json；multipart 上传等真实非 JSON body 必须显式声明。 */
  bodyMediaType?: string;
  /** body 存在时缺省为 true；允许声明接受空 body 的兼容 route。 */
  bodyRequired?: boolean;
}

export interface CursorPaginationDecl {
  kind: 'cursor';
  defaultLimit: number;
  maxLimit: number;
}

export type ApiPaginationDecl = 'none' | CursorPaginationDecl;

export interface ApiDeprecationDecl {
  successor: string;
  /** RFC 9745 Structured Field Date，例如 `@1783987200`。 */
  since?: string;
  /** RFC 1123 HTTP-date；只有获批删除日期后才声明。 */
  sunset?: string;
}

export interface ApiRouteDecl {
  method: HttpMethod;
  path: string; // 形如 '/api/agents/notes'
  /** OpenAPI operationId；一旦声明即受全局唯一性校验。 */
  operationId?: string;
  request?: ApiRequestSchemaDecl;
  /** HTTP status → response body schema。错误响应可渐进补齐。 */
  responses?: Partial<Record<number, ZodTypeAny>>;
  /** HTTP status → media type(s); defaults to application/json. */
  responseMediaTypes?: Partial<Record<number, string | readonly string[]>>;
  /** 允许幂等创建等 route 声明多个成功状态（例如 200/201）。 */
  successStatus?: number | readonly number[];
  pagination?: ApiPaginationDecl;
  deprecation?: ApiDeprecationDecl;
  /**
   * Lazy thunk keeps manifest pure metadata (no runtime deps at import); resolved
   * only when mounted. No load = ownership metadata, not mounted.
   */
  load?: () => Promise<RouteHandler>;
}

export interface UiPageDecl {
  route: string; // 形如 '/agent-notes'
}

/**
 * pg-boss handler factory `(db) => (jobs) => Promise<unknown>`. `any` on the input
 * is a deliberate variance escape hatch so kernel stays free of pg-boss/db types;
 * the cast is confined to the registrar. Returning a value lets batchSize:1
 * handlers store a run report in the job output; Promise<void> stays assignable.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate variance escape hatch（见 docblock）
export type JobHandlerFactory = (db: any) => (jobs: any) => Promise<unknown>;

export type JobScheduleDecl = {
  cron: string;
  tz: string;
} & (
  | {
      /** pg-boss singleton throttling is effective only when both fields are present. */
      singletonKey: string;
      singletonSeconds: number;
    }
  | {
      singletonKey?: never;
      singletonSeconds?: never;
    }
);

export interface JobDecl {
  /** Transitional backend admission. Only migrated families may declare dbos. */
  backend?: 'pg-boss' | 'dbos';
  name: string; // boss 队列名，形如 'dreaming_nightly'
  includeMetadata?: boolean;
  /**
   * Optional queue-level worker heartbeat. Use only for handlers whose active
   * lease must fail over faster than the queue tier's broad expiry ceiling.
   */
  heartbeatSeconds?: number;
  /** Non-default boss.work mount options; the registrar passes them through. */
  pollingIntervalSeconds?: number;
  batchSize?: number;
  /** cron 调度；无 schedule 的是链式/按需 job（如 rejudge） */
  schedule?: JobScheduleDecl;
  /** Queue tier → registrar recipe: llm/agent get a DLQ, fast does not. */
  queue: 'llm' | 'agent' | 'fast';
  /**
   * DAG membership: presence (even []) makes the job orchestrated; absence = bare
   * cron. Edges reference upstream members; soft edges only mean "do not block".
   * Members must not also declare schedule (would double-run); validation lives in
   * validateComposition and ./job-dag.
   */
  dependsOn?: readonly JobDependencyDecl[];
  /**
   * Enqueue-time eligibility: the orchestrator evaluates DAG members before send;
   * the registrar evaluates scheduled jobs at handler entry.
   */
  eligibility?: NightlyEligibilityFn;
  /** 懒加载 handler 工厂（ApiRouteDecl.load 同构语义）；无 load 的 decl 是纯归属元数据，不被挂载。 */
  load?: () => Promise<JobHandlerFactory>;
}

/**
 * DomainTool ownership declaration. name is globally unique; load is lazy and
 * optional (absent = ownership metadata only). The minimal return type keeps kernel
 * independent of the server DomainTool type.
 */
export interface CopilotToolDecl {
  name: string;
  load?: () => Promise<{ name: string }>;
}

/**
 * Proposal kinds owned by this capability. Ownership follows the producer domain and
 * is independent of whether an accept applier exists.
 */
export interface ProposalKindDecl {
  kind: string;
  accept?: ProposalAcceptDecl;
  dismiss?: ProposalDismissDecl;
  retract?: ProposalRetractDecl;
}

export interface EventSubscriptionDelivery {
  subscriberId: string;
  subscriberVersion: number;
  // Decimal string, not bigint: deliveries go to user handlers and
  // JSON.stringify(bigint) throws. Parse with BigInt() when needed.
  deliverySeq: string;
  sourceEventId: string;
}

export type EventSubscriptionOutcome =
  | { status: 'succeeded'; detail?: Record<string, unknown> }
  | { status: 'skipped'; reason: string; detail?: Record<string, unknown> };

export type EventSubscriptionHandler = (
  delivery: EventSubscriptionDelivery,
) => Promise<EventSubscriptionOutcome>;

/**
 * Event subscription handler factory. As with JobHandlerFactory, `any` is a
 * deliberate variance escape hatch so kernel stays independent of the DB
 * implementation while capability manifests can reference concrete factories.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate variance escape hatch（见 docblock）
export type EventSubscriptionHandlerFactory = (db: any) => EventSubscriptionHandler;

export interface EventSubscriptionDecl {
  /** Stable subscriber identity; version is tracked separately. */
  id: string;
  version: number;
  /** Exact event actions consumed by this handler. */
  actions: readonly string[];
  /** Mandatory lazy factory loader; composition validation never invokes it. */
  load: () => Promise<EventSubscriptionHandlerFactory>;
}

export interface CapabilityManifest {
  name: string;
  description: string;
  /** 本包拥有/骑乘的 event actions（组合期查跨包重复声明） */
  events?: { actions: string[] };
  /** 本包消费的 event actions；订阅者可与 action owner 分属不同 capability。 */
  subscriptions?: { handlers: EventSubscriptionDecl[] };
  /** 本包的 API 面归属元数据（真实 route 文件由外壳挂载） */
  api?: { routes: ApiRouteDecl[] };
  /** 本包的 pg-boss job 面（M4 第一实例）：注册由组合根收集挂载 */
  jobs?: { handlers: JobDecl[] };
  /** 本包拥有的 proposal kinds（M4 第一实例）：组合期查全局唯一 + 与 schema 枚举对账 */
  proposals?: { kinds: ProposalKindDecl[] };
  /** 本包拥有的 DomainTools：组合期查全局唯一，启动期由组合根聚合器完整注册 */
  copilotTools?: { tools: CopilotToolDecl[] };
  /** 本包拥有的 shipped SPA 页面；路径统一来自 ui-surfaces inventory。 */
  ui?: { pages?: UiPageDecl[] };
}

/** identity helper — 只为类型推断与调用点可读性。 */
export function defineCapability(manifest: CapabilityManifest): CapabilityManifest {
  return manifest;
}

export function apiRouteKey(route: Pick<ApiRouteDecl, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

export function apiSuccessStatuses(route: ApiRouteDecl): number[] {
  if (route.successStatus === undefined) return [];
  return typeof route.successStatus === 'number' ? [route.successStatus] : [...route.successStatus];
}

export function apiResponseMediaType(route: ApiRouteDecl, status: number): string {
  return apiResponseMediaTypes(route, status)[0];
}

/** 一个 status 声明的全部响应 media type（缺省 ['application/json']）。 */
export function apiResponseMediaTypes(route: ApiRouteDecl, status: number): string[] {
  const declared = route.responseMediaTypes?.[status];
  const list = declared == null ? [] : typeof declared === 'string' ? [declared] : [...declared];
  return list.length > 0 ? list : ['application/json'];
}

export function apiRequestBodyMediaType(route: ApiRouteDecl): string {
  return route.request?.bodyMediaType ?? 'application/json';
}

export class ApiRouteContractError extends Error {
  override name = 'ApiRouteContractError';
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
}

function schemaObjectKeys(schema: ZodTypeAny): string[] | null {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : null;
}

function validateApiRouteContract(route: ApiRouteDecl): void {
  const key = apiRouteKey(route);
  if (route.operationId !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(route.operationId)) {
    throw new Error(`api route '${key}' has invalid operationId '${route.operationId}'`);
  }
  const pathParams = pathParamNames(route.path).sort();
  const paramsSchema = route.request?.params;

  if (paramsSchema !== undefined) {
    const schemaParams = schemaObjectKeys(paramsSchema);
    if (schemaParams === null) {
      throw new Error(`api route '${key}' request.params must be a Zod object`);
    }
    if (schemaParams.sort().join(',') !== pathParams.join(',')) {
      throw new Error(
        `api route '${key}' path params [${pathParams.join(',')}] do not match request.params [${schemaParams.join(',')}]`,
      );
    }
  } else if (route.operationId !== undefined && pathParams.length > 0) {
    throw new Error(`api route '${key}' declares operationId but no request.params schema`);
  }

  if (route.request?.headers !== undefined && schemaObjectKeys(route.request.headers) === null) {
    throw new Error(`api route '${key}' request.headers must be a Zod object`);
  }
  if (route.request?.bodyMediaType !== undefined) {
    if (route.request.body === undefined) {
      throw new Error(`api route '${key}' declares request body media type but no body schema`);
    }
    if (!isMediaType(route.request.bodyMediaType)) {
      throw new Error(
        `api route '${key}' has invalid request body media type '${route.request.bodyMediaType}'`,
      );
    }
  }
  if (route.request?.bodyRequired !== undefined) {
    if (route.request.body === undefined) {
      throw new Error(`api route '${key}' declares bodyRequired but no body schema`);
    }
    if (typeof route.request.bodyRequired !== 'boolean') {
      throw new Error(`api route '${key}' bodyRequired must be boolean`);
    }
  }

  const successStatuses = apiSuccessStatuses(route);
  for (const status of successStatuses) {
    if (!Number.isInteger(status) || status < 200 || status > 299) {
      throw new Error(`api route '${key}' has invalid success status ${status}`);
    }
    if (route.responses?.[status] === undefined) {
      throw new Error(`api route '${key}' success status ${status} has no response schema`);
    }
  }

  for (const rawStatus of Object.keys(route.responses ?? {})) {
    const status = Number(rawStatus);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error(`api route '${key}' has invalid response status ${rawStatus}`);
    }
  }

  for (const [rawStatus, declared] of Object.entries(route.responseMediaTypes ?? {})) {
    const status = Number(rawStatus);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error(`api route '${key}' has invalid response media type status ${rawStatus}`);
    }
    if (route.responses?.[status] === undefined) {
      throw new Error(
        `api route '${key}' response media type status ${status} has no response schema`,
      );
    }
    if (status === 204) {
      throw new Error(`api route '${key}' cannot declare a response media type for status 204`);
    }
    const mediaTypes =
      declared == null ? [] : typeof declared === 'string' ? [declared] : [...declared];
    if (mediaTypes.length === 0) {
      throw new Error(
        `api route '${key}' declares an empty response media type list for status ${status}`,
      );
    }
    for (const mediaType of mediaTypes) {
      if (!isMediaType(mediaType)) {
        throw new Error(`api route '${key}' has invalid response media type '${mediaType}'`);
      }
    }
  }

  if (route.pagination !== undefined && route.method !== 'GET') {
    throw new Error(`api route '${key}' declares pagination on a non-GET route`);
  }
  if (route.pagination !== undefined && route.pagination !== 'none') {
    const { defaultLimit, maxLimit } = route.pagination;
    if (
      !Number.isInteger(defaultLimit) ||
      !Number.isInteger(maxLimit) ||
      defaultLimit <= 0 ||
      maxLimit < defaultLimit
    ) {
      throw new Error(`api route '${key}' has invalid cursor pagination limits`);
    }
    const queryKeys = route.request?.query ? schemaObjectKeys(route.request.query) : null;
    if (queryKeys === null || !queryKeys.includes('cursor') || !queryKeys.includes('limit')) {
      throw new Error(
        `api route '${key}' cursor pagination requires request.query cursor and limit fields`,
      );
    }
  }

  if (route.deprecation !== undefined && !route.deprecation.successor.startsWith('/api/')) {
    throw new Error(`api route '${key}' deprecation successor must start with /api/`);
  }
}

function isMediaType(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s/]+\/[^\s/]+$/.test(value);
}

/** Runtime guard for the success status declared by a migrated handler contract. */
export function assertApiRouteSuccessStatus(route: ApiRouteDecl, response: Response): void {
  if (!response.ok || route.successStatus === undefined) return;
  const allowed = apiSuccessStatuses(route);
  if (!allowed.includes(response.status)) {
    throw new ApiRouteContractError(
      `api route '${apiRouteKey(route)}' returned ${response.status}; declared success status is ${allowed.join('/')}`,
    );
  }
}

/**
 * DAG 成员投影的唯一真相源：存在 dependsOn 的 job（含 [] 根）。组合期校验与
 * 运行期建图必须共用本函数，否则校验过的图与实际跑的图会静默分叉。
 */
export function projectDagMembers(
  capabilities: readonly CapabilityManifest[],
): JobDagMemberInput[] {
  const members: JobDagMemberInput[] = [];
  for (const cap of capabilities) {
    for (const job of cap.jobs?.handlers ?? []) {
      if (job.dependsOn === undefined) continue;
      members.push({
        name: job.name,
        owner: cap.name,
        dependsOn: job.dependsOn,
        ...(job.eligibility ? { eligibility: job.eligibility } : {}),
      });
    }
  }
  return members;
}

/** 组合期校验：包名及各类声明（含 UI page）全局唯一，冲突即抛错。 */
export function validateComposition(capabilities: CapabilityManifest[]): void {
  const names = new Set<string>();
  for (const cap of capabilities) {
    if (names.has(cap.name)) throw new Error(`duplicate capability name: ${cap.name}`);
    names.add(cap.name);
  }
  const actionOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const action of cap.events?.actions ?? []) {
      const owner = actionOwner.get(action);
      if (owner !== undefined) {
        throw new Error(`event action '${action}' declared by both '${owner}' and '${cap.name}'`);
      }
      actionOwner.set(action, cap.name);
    }
  }
  const subscriptionOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const subscription of cap.subscriptions?.handlers ?? []) {
      // Validate raw id/version before composing identity so errors name the
      // offending field rather than a malformed combined string.
      if (subscription.id.trim().length === 0) {
        throw new Error(
          `capability '${cap.name}' has an event subscription with invalid id '${subscription.id}'`,
        );
      }
      if (!Number.isInteger(subscription.version) || subscription.version <= 0) {
        throw new Error(
          `capability '${cap.name}' event subscription '${subscription.id}' has invalid version ${subscription.version}`,
        );
      }
      const identity = `${subscription.id}@v${subscription.version}`;
      if (subscription.actions.length === 0) {
        throw new Error(`event subscription '${identity}' must declare at least one action`);
      }
      const subscribedActions = new Set<string>();
      for (const action of subscription.actions) {
        if (action.trim().length === 0) {
          throw new Error(`event subscription '${identity}' declares an empty action`);
        }
        if (subscribedActions.has(action)) {
          throw new Error(`event subscription '${identity}' declares duplicate action '${action}'`);
        }
        subscribedActions.add(action);
        if (!actionOwner.has(action)) {
          throw new Error(
            `event subscription '${identity}' subscribes to undeclared event action '${action}'`,
          );
        }
      }
      if (typeof subscription.load !== 'function') {
        throw new Error(`event subscription '${identity}' has no loader`);
      }
      const owner = subscriptionOwner.get(identity);
      if (owner !== undefined) {
        throw new Error(
          `duplicate event subscription '${identity}' declared by both '${owner}' and '${cap.name}'`,
        );
      }
      subscriptionOwner.set(identity, cap.name);
    }
  }
  const routeOwner = new Map<string, string>([
    ['GET /api/health', 'builtin'],
    // Readiness, not liveness; see server/app.ts.
    ['GET /api/ready', 'builtin'],
    ['GET /api/auth/check', 'builtin'],
    ['GET /api/openapi.json', 'builtin'],
  ]);
  const operationOwner = new Map<string, string>([
    ['getHealth', 'GET /api/health'],
    ['getReady', 'GET /api/ready'],
    ['checkAuth', 'GET /api/auth/check'],
    ['getOpenApiDocument', 'GET /api/openapi.json'],
  ]);
  for (const cap of capabilities) {
    for (const route of cap.api?.routes ?? []) {
      const key = apiRouteKey(route);
      const owner = routeOwner.get(key);
      if (owner !== undefined) {
        throw new Error(`api route '${key}' declared by both '${owner}' and '${cap.name}'`);
      }
      routeOwner.set(key, cap.name);
      validateApiRouteContract(route);
      if (route.operationId !== undefined) {
        const operationRoute = operationOwner.get(route.operationId);
        if (operationRoute !== undefined) {
          throw new Error(
            `api operationId '${route.operationId}' declared by both '${operationRoute}' and '${key}'`,
          );
        }
        operationOwner.set(route.operationId, key);
      }
    }
  }
  const jobOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const job of cap.jobs?.handlers ?? []) {
      const owner = jobOwner.get(job.name);
      if (owner !== undefined) {
        throw new Error(`job '${job.name}' declared by both '${owner}' and '${cap.name}'`);
      }
      jobOwner.set(job.name, cap.name);
      if (job.dependsOn !== undefined && job.schedule !== undefined) {
        // Orchestrated jobs must not keep a cron, or they double-run.
        throw new Error(
          `job '${job.name}' (${cap.name}) is a DAG member (declares dependsOn) but also declares a cron schedule; orchestrated jobs must not keep their own cron`,
        );
      }
    }
  }
  // Validate the shared projection so the validated graph and runtime DAG cannot diverge.
  validateJobDag(projectDagMembers(capabilities), new Set(jobOwner.keys()));
  const kindOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const decl of cap.proposals?.kinds ?? []) {
      const owner = kindOwner.get(decl.kind);
      if (owner !== undefined) {
        throw new Error(
          `proposal kind '${decl.kind}' declared by both '${owner}' and '${cap.name}'`,
        );
      }
      kindOwner.set(decl.kind, cap.name);
    }
  }
  const copilotToolOwners = new Map<string, string>();
  for (const cap of capabilities) {
    for (const tool of cap.copilotTools?.tools ?? []) {
      const owner = copilotToolOwners.get(tool.name);
      if (owner !== undefined) {
        throw new Error(
          `copilot tool '${tool.name}' declared by both '${owner}' and '${cap.name}'`,
        );
      }
      copilotToolOwners.set(tool.name, cap.name);
    }
  }
  const uiPageOwners = new Map<string, string>();
  for (const cap of capabilities) {
    for (const page of cap.ui?.pages ?? []) {
      const owner = uiPageOwners.get(page.route);
      if (owner !== undefined) {
        throw new Error(`ui page '${page.route}' declared by both '${owner}' and '${cap.name}'`);
      }
      uiPageOwners.set(page.route, cap.name);
    }
  }
}
