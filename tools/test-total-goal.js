// 验证“当前累计积分”卡片的总积分目标进度（目标 25 分）。
//
// 这条要求是用户后加的：所有板块加起来的积分要达到 25。关键是要区分两套口径：
//   pointThresholds（板块达标）→ 决定还提不提醒，达标板块之和只有 1+5+5+5+5=21
//   totalPointTarget（整体目标）→ 25，纯展示
// 所以这里要固定住 21 分时仍然“还差 4 分”，不能因为板块全满就误判成已达成。
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

function extract(name) {
  const at = appSrc.indexOf(`function ${name}(`);
  if (at < 0) throw new Error('找不到 ' + name);
  const rest = appSrc.slice(at);
  const m = rest.match(/\n(?:function |\/\/ ={3,}|\$\()/);
  return m ? rest.slice(0, m.index) : rest;
}

const els = {};
function el(selector) {
  const id = String(selector).replace(/^#/, '');
  if (!els[id]) {
    els[id] = {
      id, textContent: '', innerHTML: '', className: '', style: {},
      classList: { toggle() {}, add() {}, remove() {} }
    };
  }
  return els[id];
}

const sandbox = {
  console, Date, Set, Number, String, Object, Array, Math, JSON,
  remoteConnected: true, backendState: 'online', dataReady: true, lastScanAt: new Date().toISOString(),
  totalPointTarget: 25,
  profile: { name: 'x', meta: '', avatar: '', totalPoints: 16, recentPoints: 2, recentActivity: 'a' },
  $: el
};
vm.createContext(sandbox);
vm.runInContext([
  extract('staleNote'),
  extract('renderTotalGoal'),
  extract('renderProfile'),
  'this.__goal = renderTotalGoal; this.__render = renderProfile;'
].join('\n'), sandbox);

const run = (points, target) => {
  sandbox.profile.totalPoints = points;
  if (target !== undefined) sandbox.totalPointTarget = target;
  sandbox.__goal();
  const bar = el('goalTrack');
  return {
    hint: el('goalHint').textContent,
    hintClass: el('goalHint').className,
    width: el('goalFill').style.width,
    barClass: bar.className,
    symbol: el('goalSymbol').className
  };
};

console.log('=== 1. 当前真实值：16 / 25 ===');
{
  const r = run(16);
  console.log('    ' + r.hint + '   进度条=' + r.width + '   条类=' + r.barClass);
  check('提示写明目标与差额', r.hint === '目标 25 分 · 还差 9 分', r.hint);
  check('进度为 64%', r.width === '64%', r.width);
  check('未达标时不加 reached', r.barClass === 'goal-track', r.barClass);
  check('提示为灰色 muted', r.hintClass === 'stat-foot muted', r.hintClass);
  check('未达标时符号用中性灰', r.symbol === 'stat-symbol idle', r.symbol);
}

console.log('');
console.log('=== 2. 板块全满也只有 21 分，仍应显示还差 4 分 ===');
{
  const r = run(21);
  console.log('    ' + r.hint + '   进度条=' + r.width);
  check('21 分仍算未达成', r.hint === '目标 25 分 · 还差 4 分', r.hint);
  check('进度 84%', r.width === '84%', r.width);
  check('未加 reached 类', !/reached/.test(r.barClass), r.barClass);
}

console.log('');
console.log('=== 3. 刚好 25 分 ===');
{
  const r = run(25);
  console.log('    ' + r.hint + '   进度条=' + r.width + '   条类=' + r.barClass);
  check('提示改为已达成', r.hint === '已达成 25 分目标', r.hint);
  check('进度 100%', r.width === '100%', r.width);
  check('进度条变绿（reached）', /reached/.test(r.barClass), r.barClass);
  check('提示文字变绿', r.hintClass === 'stat-foot goal-reached', r.hintClass);
  check('符号变绿', r.symbol === 'stat-symbol green', r.symbol);
}

console.log('');
console.log('=== 4. 超过目标（26 分）不能画超宽 ===');
{
  const r = run(26);
  console.log('    ' + r.hint + '   进度条=' + r.width);
  check('已达成', /已达成/.test(r.hint), r.hint);
  check('宽度封顶 100%', r.width === '100%', r.width);
}

console.log('');
console.log('=== 5. 还没有积分数据 ===');
{
  const r = run(null);
  console.log('    ' + r.hint + '   进度条=' + r.width);
  check('只显示目标值', r.hint === '目标 25 分', r.hint);
  check('进度为 0', r.width === '0%', r.width);
  check('不显示 reached', !/reached/.test(r.barClass), r.barClass);
}

console.log('');
console.log('=== 6. 目标可配置（改成 30 分）===');
{
  const r = run(16, 30);
  console.log('    ' + r.hint + '   进度条=' + r.width);
  check('差额按新目标算', r.hint === '目标 30 分 · 还差 14 分', r.hint);
  check('进度 53%', r.width === '53%', r.width);
}

console.log('');
console.log('=== 7. renderProfile 会连带渲染目标 ===');
{
  sandbox.totalPointTarget = 25;
  sandbox.profile.totalPoints = 16;
  sandbox.__render();
  check('renderProfile 后提示已更新', el('goalHint').textContent === '目标 25 分 · 还差 9 分', el('goalHint').textContent);
}

console.log('');
// 后端契约：默认目标必须是 25，且非法配置要回落
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
console.log('=== 8. 后端默认值与回落 ===');
check('readConfig 里默认 totalPointTarget: 25', /totalPointTarget:\s*25/.test(serverSrc));
check('存在 totalPointTarget() 取值函数', /function totalPointTarget\(\)/.test(serverSrc));
check('非法值回落到 25', /Number\.isFinite\(value\) && value > 0 \? value : 25/.test(serverSrc));
check('成功状态里带上了目标', /totalPointTarget: totalPointTarget\(\)/.test(serverSrc));
check('启动状态里也带上了目标', /backend: \{ status: 'starting'[\s\S]{0,200}totalPointTarget: totalPointTarget\(\)/.test(serverSrc));

const exampleJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'monitor.config.example.json'), 'utf8'));
check('示例配置里有 totalPointTarget=25', exampleJson.totalPointTarget === 25, String(exampleJson.totalPointTarget));

console.log('');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
