import type { ReactNode } from 'react';

interface ShellMainProps {
  blockedByModal: boolean;
  children: ReactNode;
}

/**
 * 主内容区的模态隔离边界。
 *
 * 移动导航打开时，视觉 scrim 之外还必须让页面退出读屏树与键盘顺序；关闭后
 * React 会同时移除两项属性，恢复原有交互。
 */
export function ShellMain({ blockedByModal, children }: ShellMainProps) {
  return (
    <div className="main" aria-hidden={blockedByModal ? true : undefined} inert={blockedByModal}>
      {children}
    </div>
  );
}
