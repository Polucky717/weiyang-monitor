// 检查四张统计卡片的布局约束。
//
// 这几条要求都是用户明确提出的，改动很容易互相踩：
//   1) “监测状态”的“在线”必须和“16分”“6分”这些数字**同等字号**（继承 .stat-value）；
//   2) 目标进度条放在数字**下方**；
//   3) “当前累计积分”卡片的小字**不要求**与其他卡对齐（它比别的卡高，接受）；
//   4) “在线”“6分”这类短卡的小字仍要同基线，所以 .status-value 的上边距要和数字一致；
//   5) 数字与小字之间不能出现大片空白（曾因 .stat-foot 用 margin-top:auto 把
//      小字全部推到底部而产生）。
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
  .replace(/\r\n?/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const rule = (sel) => (css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')) || [, ''])[1];

console.log('=== 1. 四张卡片各自都有底部小字 ===');
const cards = [...html.matchAll(/<article class="stat-card">[\s\S]*?<\/article>/g)].map((m) => m[0]);
check('找到 4 张卡片', cards.length === 4, '实际 ' + cards.length);
check('每张卡片恰好 1 条底部小字', cards.every((c) => (c.match(/class="stat-foot/g) || []).length === 1));

console.log('');
console.log('=== 2. “在线”与数字同字号 ===');
const statusRule = rule('.status-value');
check('存在 .status-value 规则', Boolean(statusRule));
check('没有单独指定 font-size（继承 .stat-value 的 29px）', !/font-size/.test(statusRule), statusRule);
check('.stat-value 是 29px', /font-size:\s*29px/.test(rule('.stat-value')), rule('.stat-value'));
// 状态元素同时带 stat-value 和 status-value 两个类，继承才生效
check('index.html 里状态元素同时带两个类', /class="stat-value status-value" id="monitorStatusValue"/.test(html));

console.log('');
console.log('=== 3. 进度条在数字下方 ===');
const pointCard = cards.find((c) => c.includes('dashboardTotalPoints')) || '';
check('第三张卡存在', Boolean(pointCard));
check('卡内有进度条容器 goalTrack', pointCard.includes('goalTrack'));
check('卡内有目标提示 goalHint', pointCard.includes('goalHint'));
check('进度条排在数字之后', pointCard.indexOf('dashboardTotalPoints') < pointCard.indexOf('goalTrack'));
check('提示排在进度条之后', pointCard.indexOf('goalTrack') < pointCard.indexOf('goalHint'));
check('没有被包进并列行（stat-value-row 已废弃）', !pointCard.includes('stat-value-row') && !/\.stat-value-row\{/.test(css));
{
  const trackRule = rule('.goal-track');
  check('存在 .goal-track 规则', Boolean(trackRule));
  check('高度 4px', /height:\s*4px/.test(trackRule), trackRule);
  check('上下都有间距（在数字下方独立成条）', /margin:\s*6px 0 7px/.test(trackRule), trackRule);
}

console.log('');
console.log('=== 4. 数字与小字之间不能有大片空白 ===');
const footRule = rule('.stat-foot');
check('存在 .stat-foot 规则', Boolean(footRule));
// margin-top:auto 会在卡片被拉高时把整行小字推到卡片底部，正是“空白太多”的成因
check('没有用 margin-top:auto 贴底', !/margin-top:\s*auto/.test(footRule), footRule);
check('卡片不是 flex 纵向布局（不需要贴底对齐）', !/flex-direction:\s*column/.test(rule('.stat-card')), rule('.stat-card'));

console.log('');
console.log('=== 5. 短卡之间小字仍同基线 ===');
{
  const valueRule = rule('.stat-value');
  const valueTop = (valueRule.match(/margin:\s*(\d+)px/) || [, ''])[1];
  const statusTop = (statusRule.match(/margin-top:\s*(\d+)px/) || [, ''])[1];
  check('.stat-value 上边距为 7px', valueTop === '7', valueRule);
  check('.status-value 上边距与之一致', statusTop === valueTop, statusTop + ' vs ' + valueTop);
  check('两处都不再用固定行高 hack', !/line-height/.test(valueRule) && !/line-height/.test(statusRule));
}

console.log('');
console.log('=== 6. 第四张卡保留状态小字（要对齐的那条）===');
const statusCard = cards.find((c) => c.includes('monitorStatusValue')) || '';
check('第四张卡存在', Boolean(statusCard));
check('卡内有 monitorStatusDetail 小字', statusCard.includes('monitorStatusDetail'));
check('状态小字用 stat-foot 类', /class="stat-foot[^"]*" id="monitorStatusDetail"/.test(statusCard));

console.log('');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
