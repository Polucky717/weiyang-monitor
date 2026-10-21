// 直接求值 app.js 里渲染单行的模板字符串，证明：
//   1) 已报名的行不再出现“已报名”字样；
//   2) 淡化类 registered 仍然保留（用户之前要的是“变暗”）；
//   3) 板块已达标的 done-tag 不受影响。
const fs = require('fs');
const path = require('path');
// 本文件在 tools/ 下，显式上退一级定位项目根
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\r\n?/g, '\n');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

// 抓取 <article ...> ... </article>` 这一段模板。
// 注意模板本身以反引号开头，且内部还有嵌套反引号（`+${activity.points}`），
// 所以必须把开头的反引号一起截进来，不能自己再包一层反引号。
const m = src.match(/<article class="activity-row\$\{[\s\S]*?<\/article>`/);
if (!m) { console.log('  找不到行模板'); process.exit(1); }
const template = src.slice(src.lastIndexOf('`', m.index), m.index + m[0].length);
check('模板里没有“已报名”字样', !template.includes('已报名'));
check('模板里没有 registered-tag', !template.includes('registered-tag'));
check('模板里保留了 registered 淡化类', template.includes("activity.registeredAt ? ' registered' : ''"));
check('模板里保留了 done-tag（板块已达标）', template.includes('done-tag'));
check('模板里保留了 points-pill（积分）', template.includes('points-pill'));

// 求值：template 已经自带反引号，直接作为表达式返回
const fn = new Function('activity', 'iconFor', 'isSectionSatisfied',
  'return ' + template + ';');

const registered = {
  id: 'x1', title: '能源动力专业：认知、选择与成长漫谈', description: 'd',
  section: '能源电力', tone: 'blue', points: 2, registeredAt: '2026-10-21T07:24:53.273Z'
};
const plain = { id: 'x2', title: '未点过的活动', description: 'd', section: '能源电力', tone: 'blue', points: 2, registeredAt: undefined };
const sat = { ...registered, id: 'x3', __sat: true };

const htmlReg = fn(registered, () => '<svg/>', (a) => a.__sat === true);
const htmlPlain = fn(plain, () => '<svg/>', (a) => a.__sat === true);
const htmlSat = fn(sat, () => '<svg/>', (a) => a.__sat === true);

console.log('');
console.log('  已报名行的 HTML:');
console.log('    ' + htmlReg.replace(/\s+/g, ' ').slice(0, 200));
console.log('  普通行的 HTML:');
console.log('    ' + htmlPlain.replace(/\s+/g, ' ').slice(0, 200));
console.log('');

check('已报名行不含“已报名”', !htmlReg.includes('已报名'));
check('已报名行带 registered 类（会变暗）', /class="activity-row registered/.test(htmlReg));
check('已报名行仍显示板块名', htmlReg.includes('能源电力'));
check('已报名行仍显示积分 +2', htmlReg.includes('+2'));
check('已报名行仍有“去报名”按钮', htmlReg.includes('去报名'));
check('普通行不带 registered 类', !/class="activity-row registered/.test(htmlPlain));
check('达标的已报名行同时带 registered 和 satisfied', /class="activity-row registered satisfied/.test(htmlSat));
check('达标行显示“板块已达标”', htmlSat.includes('板块已达标'));
check('达标行也不含“已报名”', !htmlSat.includes('已报名'));

// 顺手确认 CSS 里淡化规则还在、标签规则已删
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
check('CSS 保留 .activity-row.registered 淡化', /\.activity-row\.registered\{opacity/.test(css));
check('CSS 已无 .registered-tag 规则', !css.includes('.registered-tag{'));
check('CSS 保留 .done-tag', css.includes('.done-tag{'));

console.log('');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
