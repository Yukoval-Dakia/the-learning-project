// Static harness: real React, real tokens and reading layer, no server. Theme and block come from the URL.
import { createRoot } from 'react-dom/client';
import { Blocks } from './demo-data';
import '../../../ui-next/tokens.css';
import '../../../ui-next/reading.css';
import './proto.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') ?? 'light';
const SECTIONS: Array<{ id: string; before: string; after: string }> = [
  { id: 'apparatus', before: '实验室用二氧化锰和浓盐酸加热制取氯气，装置如下：', after: '氯气有毒，尾气必须吸收。洗气瓶的顺序不能反：先除 HCl，再干燥。' },
  { id: 'salt', before: '粗盐提纯分两段：先除去不溶性杂质，再蒸发得到精盐。', after: '过滤后滤液仍然浑浊，就要再过滤一次。' },
  { id: 'roots', before: '判断根的情况，只看判别式的符号：', after: '记得先把方程化成一般式再读 a、b、c。' },
  { id: 'plot', before: '判别式对应到图像上，就是抛物线和 x 轴有几个交点：', after: '开口方向不影响这个结论。' },
];
function Demo({ form, id, before, after }: { form: string; id: string; before: string; after: string }) {
  return (
    <div className="lp-demo" data-form={form} data-block={id}>
      <div className="un-read" data-read={form === 'panel' ? 'compact' : undefined}>
        <p>{before}</p>
        <Blocks only={id} />
        <p>{after}</p>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root') as HTMLElement).render(
  <div data-ui-next="" data-un-theme={theme}>
    <div className="lp-page">
      {SECTIONS.map((s) => (
        <section className="lp-section" key={s.id}>
          <Demo form="main" {...s} />
          <Demo form="panel" {...s} />
        </section>
      ))}
    </div>
  </div>,
);
