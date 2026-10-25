// 验证“监测状态”在三种情况下的文案与颜色，重点是登录失效不能再显示成“缓存”。
//
// 用最小 DOM 桩跑真实的 renderProfile，断言写进元素的文本/类名。
// 这类问题肉眼看代码很容易漏（上一次就是“缓存”这个措辞误导了用户），
// 所以固定成用例。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\r\n?/g, '\n');

// 从 app.js 抽出 renderProfile 与 staleNote 两个函数
function extract(name) {
  const at = appSrc.indexOf(`function ${name}(`);
  if (at < 0) throw new Error('找不到 ' + name);
  const rest = appSrc.slice(at);
  const m = rest.match(/\n(?:function |\/\/ ={3,}|\$\()/);
  return m ? rest.slice(0, m.index) : rest;
}

const els = {};
// 注意：真实代码用 $('#id') 这种带井号的选择器，桩必须把井号去掉再当键，
// 否则写入和读取会落在两个不同的“元素”上，断言全空（我在这里踩过一次）。
function el(selector) {
  const id = String(selector).replace(/^#/, '');
  if (!els[id]) els[id] = { id, textContent: '', innerHTML: '', className: '', style: {}, classList: { toggle() {}, add() {}, remove() {} } };
  return els[id];
}

const sandbox = {
  console,
  Date,
  Set,
  Number,
  String,
  Object,
  Array,
  Math,
  JSON,
  remoteConnected: false,
  backendState: '未连接',
  dataReady: false,
  lastScanAt: null,
  totalPointTarget: 25,
  profile: { name: '张三', avatar: '', totalPoints: 16, recentPoints: 2, recentActivity: '某活动' },
  $: el
};
vm.createContext(sandbox);
// renderProfile 里会调用 renderTotalGoal（渲染积分目标进度），
// 少抽这一个函数就会 ReferenceError —— 整个测试文件直接崩掉。
vm.runInContext([
  extract('staleNote'),
  extract('renderTotalGoal'),
  extract('renderProfile'),
  'this.__render = renderProfile;'
].join('\n'), sandbox);

const render = (o) => {
  Object.assign(sandbox, o);
  sandbox.__render();
  return {
    value: el('monitorStatusValue').textContent,
    detail: el('monitorStatusDetail').textContent,
    symbolClass: el('monitorStatusSymbol').className,
    valueClass: el('monitorStatusValue').className
  };
};

console.log('=== 1. 在线 ===');
{
  const r = render({ remoteConnected: true, backendState: 'online', dataReady: true, lastScanAt: new Date().toISOString() });
  console.log('    ' + r.value + ' / ' + r.detail);
  check('文案为“在线”', r.value === '在线', r.value);
  check('状态点为绿色', r.symbolClass === 'stat-symbol green', r.symbolClass);
  check('状态文字无异常色', !/warn|idle/.test(r.valueClass), r.valueClass);
}

console.log('');
console.log('=== 2. 登录失效（用户实际遇到的情况）===');
{
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const r = render({ remoteConnected: false, backendState: 'auth_required', dataReady: true, lastScanAt: twoHoursAgo });
  console.log('    ' + r.value + ' / ' + r.detail);
  check('文案为“登录失效”而不是“缓存”', r.value === '登录失效', r.value);
  check('明确说了该做什么（relogin-monitor.cmd）', /relogin-monitor\.cmd/.test(r.detail), r.detail);
  check('给出了数据有多旧', /小时前/.test(r.detail), r.detail);
  check('状态点为琥珀色（warn）', r.symbolClass === 'stat-symbol warn', r.symbolClass);
  check('状态文字为琥珀色（warn）', /warn/.test(r.valueClass), r.valueClass);
}

console.log('');
console.log('=== 3. 后台未连上但有旧数据（真正的“缓存”）===');
{
  // 用 30 分钟（少于 1 小时）才会走“分钟前”这一支
  const r = render({ remoteConnected: false, backendState: 'unknown', dataReady: true, lastScanAt: new Date(Date.now() - 30 * 60000).toISOString() });
  console.log('    ' + r.value + ' / ' + r.detail);
  check('这才叫“缓存”', r.value === '缓存', r.value);
  check('没有催用户重新登录', !/relogin/.test(r.detail), r.detail);
  check('状态点为中性灰（idle）', r.symbolClass === 'stat-symbol idle', r.symbolClass);
  check('给出了数据有多旧（分钟）', /分钟前/.test(r.detail), r.detail);
}

console.log('');
console.log('=== 4. 什么都没连上 ===');
{
  const r = render({ remoteConnected: false, backendState: 'unknown', dataReady: false, lastScanAt: null });
  console.log('    ' + r.value + ' / ' + r.detail);
  check('文案为“等待”', r.value === '等待', r.value);
  check('状态点为中性灰', r.symbolClass === 'stat-symbol idle', r.symbolClass);
  check('没有多余的括号说明', !/（/.test(r.detail), r.detail);
}

console.log('');
console.log('=== 5. 旧数据时长换算 ===');
{
  const cases = [
    { ms: 5 * 60000, want: '5 分钟前' },
    { ms: 3 * 3600000, want: '3 小时前' },
    { ms: 2 * 86400000, want: '2 天前' }
  ];
  for (const c of cases) {
    const r = render({ remoteConnected: false, backendState: 'auth_required', dataReady: true, lastScanAt: new Date(Date.now() - c.ms).toISOString() });
    check(c.want, r.detail.includes(c.want), r.detail);
  }
}

console.log('');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
