import { defineCapability } from '@/kernel/manifest';

export const practiceCapability = defineCapability({
  name: 'practice',
  description:
    '练习消费侧：FSRS 传感器、判分评级、卷（paper）机制与会话编排。M2 加入流编排器与卷架（YUK-316）。',
  api: {
    // M2-T1 (YUK-316)：18 条路由全部带 load 懒加载 thunk（M1 配方）。[id]/[sid]
    // 段由 server/app.ts 的 toHonoPath 转 :id/:sid 并把捕获参数透传 handler。
    // 注：/api/practice/[id]/answer 实际是 POST（P2a 声明误写 PUT，壳与包从来是 POST）。
    routes: [
      {
        method: 'POST',
        path: '/api/review/submit',
        load: () => import('./api/submit').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/review/due',
        load: () => import('./api/due').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/advice',
        load: () => import('./api/advice').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/review/weekly',
        load: () => import('./api/weekly').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/appeal',
        load: () => import('./api/appeal').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/review/plan',
        load: () => import('./api/plan').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/sessions',
        load: () => import('./api/sessions').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/pause',
        load: () => import('./api/session-pause').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/resume',
        load: () => import('./api/session-resume').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/end',
        load: () => import('./api/session-end').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/reopen',
        load: () => import('./api/session-reopen').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/practice',
        load: () => import('./api/papers-list').then((m) => m.GET),
      },
      {
        // 开卷：start a review session bound to a paper artifact（M2-T6 补登：
        // handler 随 P2a 已迁入 papers-list.ts，manifest 此前漏了 POST 条目）。
        method: 'POST',
        path: '/api/practice',
        load: () => import('./api/papers-list').then((m) => m.POST),
      },
      {
        // M2 流编排器（YUK-316）。静态段 'stream' 在 Hono 中优先于 :id 匹配。
        method: 'GET',
        path: '/api/practice/stream',
        load: () => import('./api/stream').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/practice/stream/recompose',
        load: () => import('./api/stream').then((m) => m.POST),
      },
      {
        method: 'PATCH',
        path: '/api/practice/stream/items/[id]',
        load: () => import('./api/stream').then((m) => m.PATCH),
      },
      {
        method: 'GET',
        path: '/api/practice/[id]',
        load: () => import('./api/paper-detail-route').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/practice/[id]/submit',
        load: () => import('./api/paper-submit-route').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/practice/[id]/answer',
        load: () => import('./api/paper-answer-route').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve',
        load: () => import('./api/solve-start').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve/[sid]/submit',
        load: () => import('./api/solve-submit').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve/[sid]/hint',
        load: () => import('./api/solve-hint').then((m) => m.POST),
      },
    ],
  },
  // M2-T6 将把旧 /review、/practice 页重生为单一练习面 /practice（流+卷架）。
  ui: { pages: [{ route: '/practice' }] },
});
