// 计算 styles.css 里淡化的实际生效值，验证“点过报名”一定能看出变淡。
//
// 为什么需要这个：这两条规则的选择器权重完全相同
//   .activity-row.registered{opacity:.45}
//   .activity-row.satisfied {opacity:.78}
// 权重相同时**后写的赢**。这一点肉眼看不出来，只有算一遍才知道谁生效——
// 这正是“多彩未央那一行点了不变暗”的原因（它同时带两个类，被 .satisfied 盖住）。
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

const ROOT = path.join(__dirname, '..');
const cssRaw = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\r\n?/g, '\n');
// 必须先去掉注释：否则注释文字会被当成选择器的一部分（例如 "……*/ 换行
// .activity-row.registered{…}" 会被解析成一个以 "/*" 开头的选择器而被跳过），
// 结果基础规则全部漏掉、只剩 :hover 那种逗号后半段，得出完全错误的结论。
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

// 抽出所有 .activity-row 相关的 opacity 规则
const rules = [];
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
let order = 0;
while ((m = re.exec(css)) !== null) {
  const selector = m[1].trim();
  const body = m[2];
  const om = body.match(/opacity\s*:\s*([\d.]+)/);
  if (!om) continue;
  if (!selector.includes('.activity-row')) continue;
  order += 1;
  // 一条规则可能逗号分隔多个选择器（:hover 与 :focus-within 写在一起）
  for (const one of selector.split(',')) {
    const sel = one.trim();
    if (!sel.startsWith('.activity-row')) continue;
    const classes = [...sel.matchAll(/\.activity-row\.([\w-]+)/g)].map((x) => x[1]);
    const stateful = /:hover|:focus-within/.test(sel);
    if (!classes.length) continue;
    rules.push({ classes, stateful, value: Number(om[1]), order });
  }
}

// 计算某组类在某状态下的最终 opacity：
// 只看匹配的规则，比重高者胜；比重相同看先后。
function resolve(classNames, hovering) {
  const has = new Set(classNames);
  const candidates = rules.filter((r) => {
    if (!r.classes.every((c) => has.has(c))) return false;
    if (r.stateful && !hovering) return false;
    return true;
  }).map((r) => {
    // 权重：类数 + 伪类数
    const specificity = r.classes.length + (r.stateful ? 1 : 0);
    return { ...r, specificity };
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.specificity - b.specificity) || (a.order - b.order));
  return candidates[candidates.length - 1];
}

const fmt = (r) => (r ? r.value + '（来自 .activity-row.' + r.classes.join('.') + (r.stateful ? ':state' : '') + '，权重 ' + r.specificity + '）' : '无规则');

console.log('  解析到 ' + rules.length + ' 条 opacity 规则');
console.log('');

const cases = [
  { name: '普通行', classes: [], wantBase: null, wantHover: null },
  { name: '只点过报名', classes: ['registered'], wantBase: 0.45, wantHover: 0.75 },
  { name: '只板块达标', classes: ['satisfied'], wantBase: 0.78, wantHover: 1 },
  // 用户截图就是这一种：多彩未央，既点过报名、板块也已达标
  { name: '点过报名 + 板块达标', classes: ['registered', 'satisfied'], wantBase: 0.45, wantHover: 0.75 }
];

for (const c of cases) {
  const base = resolve(c.classes, false);
  const hover = resolve(c.classes, true);
  console.log('  ' + c.name + '（.activity-row' + (c.classes.length ? '.' + c.classes.join('.') : '') + '）');
  console.log('    常态: ' + fmt(base));
  console.log('    悬停: ' + fmt(hover));
  if (c.wantBase !== null) {
    check('  常态应为 ' + c.wantBase, base && base.value === c.wantBase, '实际 ' + (base && base.value));
  }
  if (c.wantHover !== null) {
    check('  悬停应为 ' + c.wantHover, hover && hover.value === c.wantHover, '实际 ' + (hover && hover.value));
  }
}

console.log('');
// 核心断言：点过报名的行必须比“仅板块达标”更淡，否则点了看不出变化
const bothBase = resolve(['registered', 'satisfied'], false);
const satBase = resolve(['satisfied'], false);
check('“点过报名+板块达标”比“仅板块达标”更淡（点了能看出来）',
  bothBase && satBase && bothBase.value < satBase.value,
  '两者都是 ' + (bothBase && bothBase.value));
check('“点过报名”的常态确实是 .45',
  bothBase && bothBase.value === 0.45,
  '实际 ' + (bothBase && bothBase.value));

console.log('');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
