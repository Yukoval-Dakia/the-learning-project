// Loom · mock content. Chinese-first, matches the product's wenyan/学习 voice.
window.LOOM = {
  user: { name: '何远舟', initial: '舟', plan: 'Weaver · Pro' },
  nav: [
    { section: '编织' },
    { id: 'today', label: '今日', icon: 'today' },
    { id: 'review', label: '复习', icon: 'review', count: 18 },
    { id: 'record', label: '录入', icon: 'record' },
    { section: '织物' },
    { id: 'items', label: '学习项', icon: 'items', count: 342 },
    { id: 'knowledge', label: '知识图谱', icon: 'knowledge' },
    { id: 'mistakes', label: '错题与收件箱', icon: 'mistakes', count: 7 },
  ],
  tabs: ['today', 'review', 'record', 'knowledge', 'mistakes'],
  today: {
    greeting: '午安，远舟',
    line: '今日有三缕丝线待你编织——温故、知新、归整。',
    date: '六月二日 · 周二',
    streak: 47,
    kpis: [
      { label: 'DUE TODAY', value: 18, unit: '', icon: 'review', tone: 'coral', delta: null, sub: '待复习卡片' },
      { label: 'RETENTION 30D', value: 91, unit: '%', icon: 'target', tone: 'good', delta: 2.4, sub: '记忆留存率' },
      { label: 'NEW THIS WEEK', value: 56, unit: '', icon: 'sparkle', tone: 'info', delta: 12, sub: '新增学习项' },
      { label: 'FOCUS MIN', value: 124, unit: '', icon: 'clock', tone: 'hard', delta: -8, sub: '本周专注分钟' },
    ],
    threads: [
      { id: 'review', title: '温故', sub: '复习 18 张到期卡片', icon: 'review', tone: 'coral', meta: '约 12 分钟', pct: 0,
        states: [{ label: 'Again', v: 3, tone: 'again' }, { label: 'Hard', v: 4, tone: 'hard' }, { label: 'Good', v: 9, tone: 'good' }, { label: 'New', v: 2, tone: 'info' }] },
      { id: 'record', title: '知新', sub: '从《宋诗选注》摘录 4 段', icon: 'record', tone: 'info', meta: '草稿 · 2 段已成卡', pct: 50 },
      { id: 'mistakes', title: '归整', sub: '7 项待归整，3 条 AI 建议', icon: 'mistakes', tone: 'hard', meta: '收件箱', pct: 0 },
    ],
    timeline: [
      { t: '08:12', title: '晨间复习 · 23 张', tone: 'good', icon: 'check', sub: 'Retention 94% · Again 1' },
      { t: '10:40', title: '录入《理想国》卷四笔记', tone: 'info', icon: 'note', sub: '生成 6 张卡片 · 2 个知识点' },
      { t: '13:05', title: 'Copilot 拆解「正义即各司其职」', tone: 'coral', icon: 'copilot', sub: '关联 3 个已有学习项' },
    ],
    recent: [
      { title: '边际效用递减', tag: '经济学', due: '今日', tone: 'coral', strength: 38 },
      { title: 'σ-代数与可测空间', tag: '实分析', due: '明日', tone: 'neutral', strength: 72 },
      { title: '《登幽州台歌》全文', tag: '唐诗', due: '3 天后', tone: 'neutral', strength: 88 },
      { title: 'TCP 三次握手', tag: '计算机网络', due: '今日', tone: 'coral', strength: 51 },
    ],
  },
  review: {
    queue: 18, done: 0,
    card: {
      deck: '唐诗 · 七言', tag: '杜甫',
      front: '会当凌绝顶，____。',
      back: '一览众山小。',
      note: '出自《望岳》。"会当"意为终当、定要；全句写登顶后俯瞰群山的豪情，是少年杜甫的壮志写照。',
      hint: '《望岳》尾联',
      fsrs: { stability: 12.4, difficulty: 0.31, retr: 0.92, interval: '14 天' },
    },
  },
  record: {
    drafts: [
      { title: '《宋诗选注》摘录', src: '图片 · 钱锺书', count: 4, status: '识别中', tone: 'info', pct: 60 },
      { title: '经济学原理 · 第7章', src: 'PDF · Mankiw', count: 11, status: '待成卡', tone: 'hard', pct: 0 },
    ],
    suggestions: [
      { title: '边际成本 vs 边际收益', from: '经济学原理 · 第7章', kind: 'cloze' },
      { title: '供给曲线为何向上', from: '经济学原理 · 第7章', kind: 'qa' },
      { title: '"看不见的手" 释义', from: '经济学原理 · 第7章', kind: 'def' },
    ],
  },
  items: [
    { title: '边际效用递减', tag: '经济学', cards: 4, strength: 38, due: '今日', tone: 'coral', updated: '2 小时前' },
    { title: 'σ-代数与可测空间', tag: '实分析', cards: 6, strength: 72, due: '明日', tone: 'neutral', updated: '昨天' },
    { title: 'TCP 三次握手', tag: '计算机网络', cards: 3, strength: 51, due: '今日', tone: 'coral', updated: '昨天' },
    { title: '《登幽州台歌》', tag: '唐诗', cards: 2, strength: 88, due: '3 天后', tone: 'neutral', updated: '3 天前' },
    { title: '正义即各司其职', tag: '哲学', cards: 5, strength: 64, due: '后天', tone: 'neutral', updated: '5 天前' },
    { title: '傅里叶级数', tag: '高等数学', cards: 8, strength: 45, due: '今日', tone: 'coral', updated: '6 天前' },
  ],
  mistakes: [
    { title: '把"边际"误作"平均"成本', tag: '经济学', kind: '概念混淆', tone: 'again', ai: '已生成对比卡片，建议加入「边际效用递减」', when: '今日 13:20' },
    { title: 'σ-代数对可数并不封闭？', tag: '实分析', kind: '记忆错误', tone: 'hard', ai: '建议复习定义，关联「可测空间」', when: '昨日' },
    { title: 'TCP 第三次握手方向记反', tag: '计算机网络', kind: '方向错误', tone: 'again', ai: '已标记，下次复习前置', when: '昨日' },
  ],
  inbox: [
    { title: '微信收藏 · 一篇关于复利的长文', src: '链接', icon: 'link', tone: 'info' },
    { title: '拍照 · 白板上的推导', src: '图片', icon: 'camera', tone: 'coral' },
    { title: '语音 · 通勤路上的灵感', src: '录音 0:48', icon: 'mic', tone: 'hard' },
    { title: '剪藏 · Stripe 工程博客段落', src: '文本', icon: 'text', tone: 'neutral' },
  ],
};
