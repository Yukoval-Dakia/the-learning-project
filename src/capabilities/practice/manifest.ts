import { defineCapability } from '@/kernel/manifest';

export const practiceCapability = defineCapability({
  name: 'practice',
  description:
    '练习消费侧：FSRS 传感器、判分评级、卷（paper）机制与会话编排。P2c 将加入流编排器与卷架；P2a 仅等价承载迁入模块。',
  api: {
    routes: [
      { method: 'POST', path: '/api/review/submit' },
      { method: 'GET', path: '/api/review/due' },
      { method: 'POST', path: '/api/review/advice' },
      { method: 'GET', path: '/api/review/weekly' },
      { method: 'POST', path: '/api/review/appeal' },
      { method: 'GET', path: '/api/review/plan' },
      { method: 'POST', path: '/api/review/sessions' },
      { method: 'POST', path: '/api/review/sessions/[id]/pause' },
      { method: 'POST', path: '/api/review/sessions/[id]/resume' },
      { method: 'POST', path: '/api/review/sessions/[id]/end' },
      { method: 'POST', path: '/api/review/sessions/[id]/reopen' },
      { method: 'GET', path: '/api/practice' },
      { method: 'GET', path: '/api/practice/[id]' },
      { method: 'POST', path: '/api/practice/[id]/submit' },
      { method: 'PUT', path: '/api/practice/[id]/answer' },
      { method: 'POST', path: '/api/questions/[id]/solve' },
      { method: 'POST', path: '/api/questions/[id]/solve/[sid]/submit' },
      { method: 'POST', path: '/api/questions/[id]/solve/[sid]/hint' },
    ],
  },
  ui: { pages: [{ route: '/review' }, { route: '/practice' }, { route: '/practice/[id]' }] },
});
