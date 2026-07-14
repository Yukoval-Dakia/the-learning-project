// YUK-329 — shipped SPA surface inventory。
//
// 这是 router / capability ui.pages / shell title+nav / command palette 的共同真相源。
// 它只含静态声明与纯函数，保持 kernel 无 IO、无 React、无路由库依赖。TanStack 的
// 动态段统一使用 `$id`；manifest 不再另写 `:id` 变体。

export type UiSurfaceOwner =
  | 'agency'
  | 'ingestion'
  | 'knowledge'
  | 'notes'
  | 'observability'
  | 'onboarding'
  | 'practice'
  | 'shell';

export type UiNavSection = '织造' | '整理';

export interface UiSurfaceDecl {
  id: string;
  route: string;
  owner: UiSurfaceOwner;
  kind: 'page' | 'redirect';
  /** 当前 surface 的具体面包屑标题。 */
  title: string;
  /** 侧栏/移动栏的 active key；详情页可指向所属列表面。 */
  activeId: string;
  nav?: {
    section: UiNavSection;
    order: number;
    mobileOrder?: number;
  };
  search?: {
    label: string;
    keywords?: string;
  };
  /** 仅后台动态详情保留路径参数；学习者实体 id 不进全局面包屑。 */
  showParam?: boolean;
}

export const UI_SURFACES = [
  {
    id: 'root',
    route: '/',
    owner: 'shell',
    kind: 'redirect',
    title: '今日',
    activeId: 'today',
  },
  {
    id: 'today',
    route: '/today',
    owner: 'shell',
    kind: 'page',
    title: '今日',
    activeId: 'today',
    nav: { section: '织造', order: 10, mobileOrder: 10 },
    search: { label: '今日' },
  },
  {
    id: 'welcome',
    route: '/welcome',
    owner: 'onboarding',
    kind: 'page',
    title: '开始设置',
    activeId: 'welcome',
  },
  {
    id: 'onboarding-upload',
    route: '/onboarding/upload',
    owner: 'onboarding',
    kind: 'page',
    title: '上传学习材料',
    activeId: 'onboarding-upload',
  },
  {
    id: 'placement',
    route: '/placement',
    owner: 'onboarding',
    kind: 'page',
    title: '起点探测',
    activeId: 'placement',
  },
  {
    id: 'profile',
    route: '/profile',
    owner: 'onboarding',
    kind: 'page',
    title: '起始档案',
    activeId: 'profile',
  },
  {
    id: 'inbox',
    route: '/inbox',
    owner: 'shell',
    kind: 'page',
    title: '收件箱',
    activeId: 'inbox',
    nav: { section: '整理', order: 10 },
    search: { label: '收件箱' },
  },
  {
    id: 'mistakes',
    route: '/mistakes',
    owner: 'practice',
    kind: 'page',
    title: '错题本',
    activeId: 'mistakes',
    search: { label: '错题本', keywords: '错题 mistakes' },
  },
  {
    id: 'agent-notes',
    route: '/agent-notes',
    owner: 'agency',
    kind: 'page',
    title: 'AI 观察',
    activeId: 'agent-notes',
    nav: { section: '整理', order: 50 },
    search: { label: 'AI 观察' },
  },
  {
    id: 'event-detail',
    route: '/events/$id',
    owner: 'observability',
    kind: 'page',
    title: '事件证据',
    activeId: 'events',
  },
  {
    id: 'record',
    route: '/record',
    owner: 'ingestion',
    kind: 'page',
    title: '录入',
    activeId: 'record',
    nav: { section: '织造', order: 30, mobileOrder: 30 },
    search: { label: '录入', keywords: '上传 OCR' },
  },
  {
    id: 'practice',
    route: '/practice',
    owner: 'practice',
    kind: 'page',
    title: '练习',
    activeId: 'practice',
    nav: { section: '织造', order: 20, mobileOrder: 20 },
    search: { label: '练习' },
  },
  {
    id: 'drafts',
    route: '/drafts',
    owner: 'practice',
    kind: 'page',
    title: '草稿审核',
    activeId: 'drafts',
    nav: { section: '整理', order: 30 },
    search: { label: '草稿审核' },
  },
  {
    id: 'questions',
    route: '/questions',
    owner: 'practice',
    kind: 'page',
    title: '题库',
    activeId: 'questions',
    nav: { section: '整理', order: 20 },
    search: { label: '题库', keywords: '题目 questions' },
  },
  {
    id: 'question-detail',
    route: '/questions/$id',
    owner: 'practice',
    kind: 'page',
    title: '题目详情',
    activeId: 'questions',
  },
  {
    id: 'knowledge',
    route: '/knowledge',
    owner: 'knowledge',
    kind: 'page',
    title: '知识',
    activeId: 'knowledge',
    nav: { section: '整理', order: 40, mobileOrder: 40 },
    search: { label: '知识' },
  },
  {
    id: 'knowledge-detail',
    route: '/knowledge/$id',
    owner: 'knowledge',
    kind: 'page',
    title: '知识详情',
    activeId: 'knowledge',
  },
  {
    id: 'note-detail',
    route: '/notes/$id',
    owner: 'notes',
    kind: 'page',
    title: '笔记',
    activeId: 'notes',
  },
  {
    id: 'coach',
    route: '/coach',
    owner: 'shell',
    kind: 'page',
    title: 'Coach',
    activeId: 'coach',
    nav: { section: '整理', order: 60 },
    search: { label: 'Coach', keywords: '周报 教练' },
  },
  {
    id: 'admin-runs',
    route: '/admin/runs',
    owner: 'observability',
    kind: 'page',
    title: '运行记录',
    activeId: 'admin',
    search: { label: 'Admin · 运行记录', keywords: 'AI runs' },
  },
  {
    id: 'admin-cost',
    route: '/admin/cost',
    owner: 'observability',
    kind: 'page',
    title: '成本',
    activeId: 'admin',
    search: { label: 'Admin · 成本', keywords: 'cost' },
  },
  {
    id: 'admin-failures',
    route: '/admin/failures',
    owner: 'observability',
    kind: 'page',
    title: '失败记录',
    activeId: 'admin',
    search: { label: 'Admin · 失败记录', keywords: 'failures' },
  },
  {
    id: 'admin-subjects',
    route: '/admin/subjects',
    owner: 'observability',
    kind: 'page',
    title: '学科配置',
    activeId: 'admin',
    search: { label: 'Admin · 学科配置', keywords: 'subjects' },
  },
  {
    id: 'admin-subject-detail',
    route: '/admin/subjects/$id',
    owner: 'observability',
    kind: 'page',
    title: '学科特征',
    activeId: 'admin',
    showParam: true,
  },
  {
    id: 'admin-coverage-lattice',
    route: '/admin/coverage-lattice',
    owner: 'observability',
    kind: 'page',
    title: '供题覆盖',
    activeId: 'admin',
    search: { label: 'Admin · 供题覆盖', keywords: 'coverage lattice' },
  },
  {
    id: 'admin-conjecture-scores',
    route: '/admin/conjecture-scores',
    owner: 'observability',
    kind: 'page',
    title: '猜想评分',
    activeId: 'admin',
    search: { label: 'Admin · 猜想评分', keywords: 'conjecture scores' },
  },
] as const satisfies readonly UiSurfaceDecl[];

export type UiSurfaceId = (typeof UI_SURFACES)[number]['id'];
type SurfaceForId<Id extends UiSurfaceId> = Extract<(typeof UI_SURFACES)[number], { id: Id }>;

export function surfaceById<Id extends UiSurfaceId>(id: Id): SurfaceForId<Id> {
  const surface = UI_SURFACES.find((candidate) => candidate.id === id);
  if (!surface) throw new Error(`unknown UI surface: ${id}`);
  return surface as SurfaceForId<Id>;
}

export function surfacePath<Id extends UiSurfaceId>(id: Id): SurfaceForId<Id>['route'] {
  return surfaceById(id).route as SurfaceForId<Id>['route'];
}

export function uiPagesFor(owner: UiSurfaceOwner): Array<{ route: string }> {
  return UI_SURFACES.filter((surface) => surface.owner === owner && surface.kind === 'page').map(
    (surface) => ({ route: surface.route }),
  );
}

export interface UiSurfaceMatch {
  surface: (typeof UI_SURFACES)[number];
  params: Record<string, string>;
}

function matchRoute(route: string, pathname: string): Record<string, string> | null {
  const routeParts = route.split('/');
  const pathParts = pathname.split('/');
  if (routeParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < routeParts.length; index += 1) {
    const expected = routeParts[index] ?? '';
    const actual = pathParts[index] ?? '';
    if (expected.startsWith('$')) {
      if (!actual) return null;
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        params[expected.slice(1)] = actual;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export function matchUiSurface(pathname: string): UiSurfaceMatch | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  for (const surface of UI_SURFACES) {
    const params = matchRoute(surface.route, normalized);
    if (params) return { surface, params };
  }
  return null;
}

export interface UiSurfaceAuditInput {
  routerSurfaceIds: readonly string[];
  manifestPages: readonly { owner: string; route: string }[];
}

function duplicates(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

/**
 * 构建门禁的纯校验核。调用方从 router 源绑定和 capability manifests 取实值；任何
 * 漏路由、幽灵路由、漏/错归属声明、`:id`/`$id` 语法漂移都聚合为一个可读失败。
 */
export function auditUiSurfaceInventory(input: UiSurfaceAuditInput): void {
  const errors: string[] = [];
  const knownIds = UI_SURFACES.map((surface) => surface.id);
  const knownIdSet = new Set<string>(knownIds);
  const routerIdSet = new Set(input.routerSurfaceIds);

  for (const id of duplicates(knownIds)) errors.push(`duplicate inventory id: ${id}`);
  for (const route of duplicates(UI_SURFACES.map((surface) => surface.route))) {
    errors.push(`duplicate inventory route: ${route}`);
  }
  for (const id of duplicates(input.routerSurfaceIds))
    errors.push(`duplicate router binding: ${id}`);
  for (const id of knownIds) {
    if (!routerIdSet.has(id)) errors.push(`inventory route is not bound in router: ${id}`);
  }
  for (const id of input.routerSurfaceIds) {
    if (!knownIdSet.has(id)) errors.push(`router binds unknown surface: ${id}`);
  }

  for (const surface of UI_SURFACES) {
    if (surface.route.includes('/:')) {
      errors.push(`inventory route must use TanStack $param syntax: ${surface.route}`);
    }
    if (!surface.title.trim()) errors.push(`surface has no title: ${surface.id}`);
    if ('search' in surface && surface.search && surface.route.includes('$')) {
      errors.push(`dynamic surface cannot be directly searched: ${surface.id}`);
    }
  }

  const expectedManifest = UI_SURFACES.filter((surface) => surface.kind === 'page').map(
    (surface) => `${surface.owner} ${surface.route}`,
  );
  const actualManifest = input.manifestPages.map((page) => `${page.owner} ${page.route}`);
  for (const page of input.manifestPages) {
    if (page.route.includes('/:')) {
      errors.push(`manifest route must use TanStack $param syntax: ${page.owner} ${page.route}`);
    }
  }
  const actualSet = new Set(actualManifest);
  const expectedSet = new Set(expectedManifest);
  for (const key of duplicates(actualManifest)) errors.push(`duplicate manifest page: ${key}`);
  for (const key of expectedManifest) {
    if (!actualSet.has(key)) errors.push(`manifest is missing page: ${key}`);
  }
  for (const key of actualManifest) {
    if (!expectedSet.has(key)) errors.push(`manifest declares unknown or misowned page: ${key}`);
  }

  if (errors.length > 0) throw new Error(`UI surface inventory drift:\n- ${errors.join('\n- ')}`);
}
