// Product-shaped, de-identified data for the prototype (built on the §13 ellipse story).
export const library = {
  questions: [
    { id: 'q1', title: '椭圆综合题', sub: '圆锥曲线练习 第 2 题', source: '学校作业', seen: '今晚', state: '第 (2) 问待订正', next: '10/12', follow: 1, open: 'question' },
    { id: 'q2', title: '抛物线弦长', sub: '过焦点的弦与面积', source: '自己练习', seen: '9/28', state: '给出设法后完成', next: '10/14', follow: 0 },
    { id: 'q3', title: '双曲线渐近线', sub: '离心率范围', source: '错题', seen: '9/26', state: '独立完成', next: '10/20', follow: 0 },
    { id: 'q4', title: '圆锥曲线练习 第 3 题', sub: '原图已保存', source: '学校作业', seen: '10/5', state: '还没开始', next: '周五交', follow: 0 },
    { id: 'q5', title: '向量综合 第 4 题', sub: '数量积最值', source: '学校作业', seen: '10/1', state: '判分待复核', next: '—', follow: 0 },
    { id: 'q6', title: '导数：极值点偏移', sub: '构造对称函数', source: '自己练习', seen: '9/20', state: '看提示后完成', next: '10/10', follow: 1 },
  ],
  notes: [
    { id: 'n1', title: '椭圆中的“设而不求”', sub: '课堂笔记照片 · 3 处批注', source: '课堂', seen: '今晚', state: '1 段被引用', next: '—', follow: 0, open: 'note' },
    { id: 'n2', title: '均值不等式的取等条件', sub: '自己整理', source: '自己', seen: '10/2', state: '—', next: '—', follow: 0 },
    { id: 'n3', title: '《什么是数学》§4.2 射影几何', sub: '阅读批注', source: '阅读', seen: '10/4', state: '读到第 187 页', next: '—', follow: 0 },
    { id: 'n4', title: '圆锥曲线统一定义', sub: '课堂笔记', source: '课堂', seen: '9/15', state: '—', next: '—', follow: 0 },
  ],
  mistakes: [
    { id: 'm1', title: '椭圆综合题 第 (2) 问', sub: '最值取等条件', source: '学校作业', seen: '今晚', state: '原因还没判断', next: '10/12', follow: 1, open: 'question' },
    { id: 'm2', title: '导数：极值点偏移', sub: '构造函数方向', source: '自己练习', seen: '9/20', state: '看提示后完成', next: '10/10', follow: 1 },
  ],
};

export const attempts = [
  { at: '今晚 20:02', kind: 'mismatch', text: '第 (2) 问提交 $2\\sqrt{3}$ —— 与参考答案 $3$ 不一致（确定性核对）', note: '原因还没判断：可能在取等条件，也可能在 $t$ 的范围。' },
  { at: '今晚 19:42', kind: 'help', text: '看了提示 1（方向），随后改设 $x=my+1$', note: '第 4 步记为“看提示后完成”' },
  { at: '今晚 19:20', kind: 'ok', text: '第 (1) 问提交 —— 与参考方程一致（确定性核对）' },
  { at: '10/5 学校', kind: 'photo', text: '拍下作业与草稿：“这题做完了，但下次可能还不会。”', note: '草稿第 3 行识别不清，没有用于判断' },
];

export const note = {
  title: '椭圆中的“设而不求”',
  meta: '9/20 课堂笔记照片整理 · 3 处批注 · 今晚被引用 1 次',
  sections: [
    {
      h: '什么时候用',
      p: '求弦长、面积或中点时，两个交点的坐标往往算不干净。只要式子里用到的是 $x_1+x_2$、$x_1x_2$（或 $y_1+y_2$、$y_1y_2$），就不必真的把交点解出来。',
    },
    {
      h: '直线怎么设',
      p: '过 $x$ 轴上定点 $(t,0)$ 的直线，设成 $x=my+t$：不用单独讨论斜率不存在，而且 $|y_1-y_2|$ 直接就是面积的“高”。',
      mark: '这里我每次都想不到 —— 9/20 批注',
    },
    {
      h: '面积的常用写法',
      p: '$S=\\dfrac12|F_1F_2|\\cdot|y_1-y_2|$，其中 $|y_1-y_2|=\\sqrt{(y_1+y_2)^2-4y_1y_2}$。代入韦达定理后，通常只剩一个参数。',
    },
    {
      h: '最值的陷阱',
      p: '换元后常见形如 $\\dfrac{a}{bt+\\frac{c}{t}}$ 的式子。先确认 $t$ 的范围，再决定用均值不等式还是单调性 —— 等号取不到时，均值不等式给出的只是一个达不到的界。',
    },
  ],
  related: '相关：椭圆综合题 第 (2) 问（今晚）',
};

export const conversations = {
  question: [
    { role: 'me', text: '第 5 步哪里不对？' },
    {
      role: 'ai',
      ref: '第 5 步',
      text: '第 5 步的式子本身没有问题，问题在最后一步：$3t+\\frac1t\\ge2\\sqrt3$ 要在 $t=\\frac{\\sqrt3}{3}$ 时取等，而 $t=\\sqrt{m^2+1}\\ge1$，这个等号取不到。在 $t\\ge1$ 上它是单调递增的，所以应该看 $t=1$。',
    },
    {
      role: 'proposal',
      title: '加入待跟进：最值题先检查取等条件',
      body: '下次遇到换元求最值时，我会先留出一步让你自己检查范围。可以随时关闭。',
    },
  ],
  note: [
    { role: 'me', quote: '过 x 轴上定点 (t,0) 的直线，设成 x = my + t', cite: '直线怎么设', text: '为什么这样就不用讨论斜率？' },
    {
      role: 'ai',
      ref: '直线怎么设',
      text: '$x=my+t$ 里的 $m$ 是斜率的倒数：竖直的直线对应 $m=0$，可以直接表示；而 $y=k(x-t)$ 写不出竖直线，才需要单独讨论。代价是它表示不了水平线 $y=0$ —— 但那条线只与椭圆交于长轴端点，构不成三角形，正好不需要。',
    },
  ],
  home: [],
};

export const followUps = {
  question: '第 5 步之后，你想自己先检查 $t$ 的范围，还是让我直接给出单调性的写法？',
  note: '要不要我从你的错题里找一道正好需要 $x=my+t$ 的题，用来确认这一点？',
  home: '今晚 40 分钟，我建议先用 12 分钟做短对比例子，再回到作业第 3 题。你想换个顺序也可以。',
};

export const recentChats = [
  { id: 'c1', title: '椭圆第 (2) 问：取等条件', at: '今晚', route: 'question' },
  { id: 'c2', title: '为什么设 x = my + t', at: '今晚', route: 'note' },
  { id: 'c3', title: '期中范围怎么排', at: '昨天', route: 'home' },
];
