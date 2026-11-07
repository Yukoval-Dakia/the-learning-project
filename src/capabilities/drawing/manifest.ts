import { z } from 'zod';
import { API_ERROR_RESPONSES, ApiIdParamsSchema } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { DrawingSessionQuerySchema, DrawingStatusResponseSchema } from './api/contracts';

export const drawingCapability = defineCapability({
  name: 'drawing',
  description:
    '生成式 UI 绘图域：compose_block drawing 委托的 Sol 后台单轮绘制——来源闭包授权登记、' +
    '事务入队、durable 状态机（queued/running/ready/waiting_quota/waiting_login/failed/cancelled/expired）、' +
    '归属校验状态读、取消/重画幂等与撤回拒绝派生。',
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/drawings/[id]',
        operationId: 'getDrawingStatus',
        request: { params: ApiIdParamsSchema, query: DrawingSessionQuerySchema },
        responses: { 200: DrawingStatusResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/drawing-status').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/drawings/[id]/asset',
        operationId: 'getDrawingAsset',
        request: { params: ApiIdParamsSchema, query: DrawingSessionQuerySchema },
        responses: { 200: z.unknown(), ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/drawing-asset').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/drawings/[id]/cancel',
        operationId: 'cancelDrawing',
        request: { params: ApiIdParamsSchema, body: DrawingSessionQuerySchema },
        responses: { 200: DrawingStatusResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/drawing-cancel').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/drawings/[id]/redraw',
        operationId: 'redrawDrawing',
        request: { params: ApiIdParamsSchema, body: DrawingSessionQuerySchema },
        responses: { 200: DrawingStatusResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/drawing-redraw').then((m) => m.POST),
      },
    ],
  },
  jobs: {
    handlers: [
      {
        // Independent queue off the Copilot session head: one model call per
        // generation, waits re-arm a delayed send instead of holding a lease.
        name: 'drawing_generate',
        queue: 'llm',
        load: () => import('./jobs/drawing_generate').then((m) => m.buildDrawingGenerateHandler),
      },
    ],
  },
});
