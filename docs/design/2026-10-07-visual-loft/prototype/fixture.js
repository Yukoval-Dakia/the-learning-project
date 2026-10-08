// De-identified fixture for the YUK-1353 loft. Constructed from the hypothetical
// ellipse story in behavior design §13; no owner problem, draft or record is used.

export const now = {
  date: '10月7日 周三',
  part: '晚上',
  clock: '20:10',
  availableMinutes: 40,
  availableSource: '你下午说的',
};

export const goals = [
  { id: 'school', label: '学校作业', detail: '圆锥曲线练习 · 周五 10/9 交', kind: 'locked', note: '剩 2 题' },
  { id: 'midterm', label: '期中考试', detail: '10/21 · 选必一第三章', kind: 'date', note: '14 天后' },
  { id: 'deep', label: '真正理解“设而不求”', detail: '长期 · 你在 9/20 设的', kind: 'long', note: '无期限' },
  { id: 'read', label: '《什么是数学》第 4 章', detail: '兴趣阅读', kind: 'interest', note: '不关联也可以' },
];

export const problem = {
  id: 'q-ellipse-02',
  title: '椭圆综合题',
  source: '学校作业 · 圆锥曲线练习 第 2 题',
  photoDate: '10/5',
  goals: ['school', 'midterm'],
  stem:
    '已知椭圆 $C:\\ \\dfrac{x^2}{a^2}+\\dfrac{y^2}{b^2}=1\\ (a>b>0)$ 的离心率为 $\\dfrac{1}{2}$，左、右焦点分别为 $F_1,F_2$，点 $P\\left(1,\\dfrac{3}{2}\\right)$ 在 $C$ 上。过 $F_2$ 且不与 $x$ 轴重合的直线 $l$ 交 $C$ 于 $A,B$ 两点，$O$ 为坐标原点。',
  requirement: '作业要求：写出完整过程；弦长或面积公式需说明来由，不能直接套用结论。',
  parts: [
    {
      id: 'p1',
      label: '(1)',
      text: '求 $C$ 的方程；',
      status: 'correct',
      at: '19:20',
      check: '确定性核对：与参考方程 $\\dfrac{x^2}{4}+\\dfrac{y^2}{3}=1$ 一致',
    },
    {
      id: 'p2',
      label: '(2)',
      text: '求 $\\triangle F_1AB$ 面积的最大值，并求此时直线 $l$ 的方程。',
      status: 'working',
    },
  ],
};

// Draft steps for part (2). `origin` separates the photographed school draft
// from tonight's typed work; `help` records the help condition in effect.
export const draftSteps = [
  {
    id: 's1',
    text: '设 $l:\\ y=k(x-1)$，代入 $C$ 得 $(3+4k^2)x^2-8k^2x+4k^2-12=0$',
    origin: 'photo',
    help: 'none',
  },
  {
    id: 's2',
    text: '$x_1+x_2=\\dfrac{8k^2}{3+4k^2}$，$x_1x_2=\\dfrac{4k^2-12}{3+4k^2}$',
    origin: 'photo',
    help: 'none',
  },
  {
    id: 's3',
    text: '$S=\\dfrac{1}{2}\\cdot|F_1F_2|\\cdot|y_1-y_2|$，$|y_1-y_2|=|k|\\cdot|x_1-x_2|=\\ \\cdots$',
    origin: 'photo',
    help: 'none',
    unclear: '照片此行后半段识别不清，已保留原图，未用于判断',
  },
  {
    id: 's4',
    text: '改设 $l:\\ x=my+1$，代入得 $(3m^2+4)y^2+6my-9=0$，$y_1+y_2=-\\dfrac{6m}{3m^2+4}$，$y_1y_2=-\\dfrac{9}{3m^2+4}$',
    origin: 'tonight',
    help: 'h1',
  },
  {
    id: 's5',
    text: '$S=\\dfrac{12\\sqrt{m^2+1}}{3m^2+4}$，令 $t=\\sqrt{m^2+1}$，则 $S=\\dfrac{12}{3t+\\frac{1}{t}}\\le\\dfrac{12}{2\\sqrt{3}}=2\\sqrt{3}$',
    origin: 'tonight',
    help: 'none',
    current: true,
  },
];

export const hints = [
  {
    id: 'h1',
    level: '提示 1 · 方向',
    text: '试试把直线设成 $x=my+1$：既不用单独讨论斜率不存在，面积也能直接用 $|y_1-y_2|$ 表示。',
    seenAt: '19:42',
    anchor: 's4',
    record: '第 4 步记为“看提示后完成”',
  },
  {
    id: 'h2',
    level: '提示 2 · 检查',
    text: '用均值不等式之前，先确认等号能不能取到：这里 $t$ 的取值范围是什么？',
    anchor: 's5',
    record: '打开后，第 5 步记为“看提示后完成”',
  },
];

export const explanation = [
  '第 5 步的式子没有问题，问题在最后一步的取等条件。',
  '由 $t=\\sqrt{m^2+1}$ 可知 $t\\ge 1$；而 $3t+\\dfrac{1}{t}\\ge 2\\sqrt{3}$ 要在 $t=\\dfrac{\\sqrt{3}}{3}$ 时取等，不在范围内。',
  '在 $t\\ge 1$ 上 $3t+\\dfrac{1}{t}$ 单调递增，所以 $t=1$（即 $m=0$）时取最小值 $4$。',
  '因此 $S$ 的最大值为 $3$，此时 $l:\\ x=1$。',
];

// The learning-state judgement for the method choice: observed / said / unknown kept apart (§6.1).
export const judgement = {
  topic: '选择设直线的方式',
  observed: '给出设法的两个例子里，你都完成了后续推导（9/28 抛物线弦长题、今晚第 4 步）。',
  said: '10/5 你说：“这题做完了，但下次可能还不会。”',
  unknown: '没有提示时，能否自己想到设 $x=my+1$ —— 还没有证据。',
  changeBy: '一道换了条件表达的题里，你自己选出设法。',
  photo: '学校草稿第 3 行识别不清，没有用于判断。',
};

export const lead = {
  headline: '上次你做完了椭圆题的第 (1) 问，第 (2) 问停在求面积的最大值。',
  body: '还不确定遇到新条件时，你能否自己想到把直线设成 $x=my+1$。我准备了一个短对比例子；也可以直接继续原来的作业。',
};

export const continueItems = [
  {
    id: 'c-ellipse',
    title: '椭圆综合题 · 第 (2) 问',
    where: '停在第 5 步：求 $S$ 的最大值',
    goal: 'school',
    meta: '学校作业 · 周五交',
    spent: 34,
    saved: '草稿已保存',
    primary: true,
  },
  {
    id: 'c-read',
    title: '《什么是数学》第 4 章',
    where: '读到 §2 射影几何 · 第 187 页',
    goal: 'read',
    meta: '兴趣阅读 · 3 条批注',
    spent: 0,
    saved: '位置已保存',
  },
  {
    id: 'c-hw3',
    title: '圆锥曲线练习 · 第 3 题',
    where: '还没开始 · 题目已拍照',
    goal: 'school',
    meta: '学校作业 · 周五交',
    spent: 0,
    saved: '原图已保存',
  },
];

export const suggestions = [
  {
    id: 'g-contrast',
    status: 'ready',
    title: '短对比例子：两道设直线方式不同的题',
    what: '两道短题，只要求选出设直线的方式并写出联立式，不必算完。',
    purpose: '确认没有提示时，你能否自己选出 $x=my+1$ 这类设法。',
    whyNow: '今晚第 4 步是看提示后完成的；期中范围包含这一类题。',
    minutes: 12,
    needs: '纸笔即可，题目已核对题意与答案。',
    stop: '两题里能自己选出设法就停；第一题就卡住也可以停，结果同样有用。',
    alternatives: ['改用作业第 3 题（自然机会）', '推迟到周末', '不再跟进这一点'],
    goals: ['midterm', 'deep'],
  },
  {
    id: 'g-review',
    status: 'ready',
    deterministic: true,
    title: '到期复习 · 4 项',
    what: '4 个知识点的到期回忆，按记忆间隔排定。',
    purpose: '保持已经学过的内容。',
    whyNow: '按复习间隔今天到期；离开几天也不会累加成欠账。',
    minutes: 8,
    needs: '无',
    stop: '做完 4 项或随时停下，未做的顺延。',
    alternatives: ['只做 2 项', '明天再做'],
    goals: ['midterm'],
  },
  {
    id: 'g-scope',
    status: 'generating',
    title: '期中范围梳理 · 选必一第三章',
    what: '把第三章按“已有证据 / 还不确定 / 还没学”整理成一页。',
    purpose: '帮你决定期中前两周的重点。',
    whyNow: '期中在 14 天后，你上周提过想要一份范围清单。',
    minutes: 15,
    progress: [3, 5],
    needs: '课本目录（已有）',
    stop: '看完一页即可，不附带练习。',
    alternatives: ['只梳理圆锥曲线一节', '不需要'],
    goals: ['midterm'],
  },
];

export const readiness = [
  { id: 'r1', state: 'ready', title: '短对比例子', detail: '2 题 · 已核对题意与答案', at: '19:58' },
  { id: 'r2', state: 'generating', title: '期中范围梳理', detail: '已完成 3/5 节 · 约 2 分钟', at: '进行中' },
  {
    id: 'r3',
    state: 'review',
    title: '作业第 3 题的参考答案',
    detail: '参考答案用了 $a=2$，原题条件是 $a=\\sqrt{5}$，先别按它核对',
    at: '19:31',
  },
];

export const cost = { week: 1.84, cap: 20, currency: '¥' };

export const backlog = [
  { id: 'b1', title: '错题重做 · 3 道', meta: '上周 · 抛物线 2 道、双曲线 1 道' },
  { id: 'b2', title: '笔记整理 · 2 篇', meta: '课堂照片已保存，未整理' },
  { id: 'b3', title: '英语听力 · 第 6 单元', meta: '你在 9/30 暂停了' },
  { id: 'b4', title: '向量综合 · 第 4 题复盘', meta: '判分待复核' },
  { id: 'b5', title: '《什么是数学》§1 回述', meta: '可选' },
  { id: 'b6', title: '期中模拟卷 A', meta: '还没开始 · 10/14 前' },
];

// Thread history for variant C (newest first). `basis` explains why items are linked.
export const thread = {
  title: '椭圆 · 设直线的方式',
  basis: '都需要先选择设直线的方式，不是因为都属于“椭圆”。',
  events: [
    { id: 't1', at: '今晚 19:42', kind: 'help', text: '第 (2) 问看了提示 1（方向），随后写出第 4 步。' },
    { id: 't2', at: '今晚 19:20', kind: 'check', text: '第 (1) 问提交，确定性核对正确。' },
    {
      id: 't3',
      at: '10/5 学校',
      kind: 'photo',
      text: '拍下作业和草稿，并说：“这题做完了，但下次可能还不会。”',
    },
    {
      id: 't4',
      at: '9/28',
      kind: 'link',
      text: '抛物线弦长题：同样卡在设直线，给出设法后完成了推导。',
    },
  ],
};

export const otherThreads = [
  { id: 'o1', title: '《什么是数学》第 4 章', meta: '读到第 187 页 · 3 条批注', at: '10/4' },
  { id: 'o2', title: '期中复习', meta: '范围梳理生成中 3/5', at: '进行中' },
  { id: 'o3', title: '到期复习', meta: '4 项 · 约 8 分钟', at: '今天' },
];

export const absence = {
  days: 12,
  text: '这段时间没有新记录 —— 只说明系统没有新的观察，不代表退步。到期复习没有累加。',
  offer: '可以从断点继续；也可以先花 5 分钟确认哪些还记得。',
};

export const nextUp = { title: '短对比例子', minutes: 12 };
