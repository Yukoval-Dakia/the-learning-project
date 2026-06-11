import { redirect } from 'next/navigation';

// M4-T7 (YUK-319)：工作台迁 SPA（web/ 的 /today），旧 today 页已拆——迁移期
// 旧栈根路径指向仅存的主 surface /coach；M5 旧栈整体退役时本页一并删除。
export default function Page() {
  redirect('/coach');
}
