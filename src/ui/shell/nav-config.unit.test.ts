import { describe, expect, it } from 'vitest';
import { breadcrumbParamFromPath } from './nav-config';

describe('breadcrumbParamFromPath', () => {
  it('不把学习者明细页的数据库标识放进全局面包屑', () => {
    expect(breadcrumbParamFromPath('/questions/question_raw_id')).toBeNull();
    expect(breadcrumbParamFromPath('/knowledge/seed:yuwen:root')).toBeNull();
    expect(breadcrumbParamFromPath('/notes/note_raw_id')).toBeNull();
  });

  it('保留后台诊断面的路径段', () => {
    expect(breadcrumbParamFromPath('/admin/runs')).toBe('runs');
  });
});
