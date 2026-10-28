// 回归测试：提醒窗口的“必须看得见、不能自己消失、不能带空控制台”。
//
// 这一轮踩到两个坑，都是“日志说弹了、用户却什么都没看到”：
//   1) 窗口 60 秒自动关闭 —— 用户离开一会儿就永久错过，而新活动只提醒一次；
//   2) spawn(windowsHide: true) 虽然去掉了空的黑色控制台，却会通过 STARTUPINFO
//      传 SW_HIDE，把进程**第一次** ShowWindow 覆盖成隐藏，于是窗口"已显示"
//      但屏幕上看不见。必须在 Shown 里再显式 ShowWindow(SW_SHOW) 一次。
//
// 注意：本文件做的是**结构/契约检查**（源码里必须存在哪些写法）。
// 真实可见性靠实际弹窗 + 截屏验证过（见 logs/notify-trace.log 的
// “已强制显示窗口（SW_SHOW）” 与截图），静态检查无法替代那一步。
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
const ps1Path = path.join(ROOT, 'scripts', 'windows-notify.ps1');
const ps1 = fs.readFileSync(ps1Path, 'utf8');

console.log('=== 1. 不能带出空的黑色控制台窗口 ===');
check('spawn 使用 windowsHide: true', /windowsHide:\s*true/.test(server));
check('没有残留 windowsHide: false', !/windowsHide:\s*false/.test(server));

console.log('');
console.log('=== 2. 隐藏控制台后必须强制把窗口显示出来 ===');
// 这一条是本次最重要的修复：只设 windowsHide 会让窗口隐形
check('调用了 ShowWindow', /ShowWindow\(\$form\.Handle,\s*5\)/.test(ps1));
check('调用了 SetForegroundWindow', /SetForegroundWindow\(\$form\.Handle\)/.test(ps1));
check('强制显示写在 Shown 事件里', /\$form\.Add_Shown\(\{[\s\S]*?ShowWindow/.test(ps1));
check('有对应的轨迹日志便于事后查证', /已强制显示窗口/.test(ps1));
check('失败时会记日志而不是静默', /强制显示窗口失败/.test(ps1));

console.log('');
console.log('=== 3. 活动提醒窗口不能自动关闭 ===');
check('server 给活动提醒传 0', /notifyWindows\('未央雨课堂活动提醒',\s*notificationMessage\(firstNew\),\s*0,/.test(server));
check('0 被解释为“不自动关闭”', /\$autoClose\s*=\s*\$DurationSeconds\s*-gt\s*0/.test(ps1));
check('计时器只在自动关闭模式下启动', /\$autoClose\s*\)\s*\{\s*\$timer\.Start\(\)/.test(ps1));
check('不再有把 0 变成 1 秒的旧写法', !/\[Math\]::Max\(1,\s*\$DurationSeconds\)/.test(ps1));
check('日志区分“计划显示”与“不自动关闭”', /不自动关闭（等用户手动关闭）/.test(ps1));
check('关闭时记录原因（自动超时 / 手动 / 稍后提醒）',
  /自动超时/.test(ps1) && /设置了稍后提醒/.test(ps1) && /手动关闭（确认\/关闭按钮）/.test(ps1));

console.log('');
console.log('=== 4. 登录失效提醒：不自动关闭，且会反复提醒 ===');
// 这条是"必须重登才能消掉"的状态。原来给 20 秒自动关闭 + 只弹一次，
// 用户不在的时候照样错过（和活动提醒同一个教训）。
check('登录失效提醒传 0（不自动关闭）', /'未央观察站：登录已失效'[\s\S]{0,700}?\n\s*0,/.test(server));
check('定义了重复提醒间隔（3 小时）', /const AUTH_REMIND_INTERVAL_MS = 3 \* 60 \* 60 \* 1000;/.test(server));
// 节奏统一由 authNextRemindAt 一个时间点驱动：没弹过立刻弹，弹过写到 +3 小时，
// 用户点“稍后提醒我”则改写成他选的时间。用两个字段容易互相打架。
check('由单一时间点 authNextRemindAt 驱动', /Date\.now\(\) >= Number\(lastState\.backend\?\.authNextRemindAt \|\| 0\)/.test(server));
check('弹过之后写“现在 + 间隔”', /authNextRemindAt: next/.test(server) && /const next = Date\.now\(\) \+ AUTH_REMIND_INTERVAL_MS;/.test(server));
check('默认状态里有 authNextRemindAt 字段', /authNextRemindAt: null/.test(server));
check('文案指向 relogin-monitor.cmd', server.includes('请双击 relogin-monitor.cmd 重新登录'));

console.log('');
console.log('=== 4b. 登录失效窗口的两个按钮 + 悬停时间菜单 ===');
check('窗口脚本有 -Mode 参数（activity / auth）', /\[ValidateSet\('activity', 'auth'\)\]\[string\]\$Mode = 'activity'/.test(ps1));
check('server 给登录失效提醒传 auth', /'auth'\s*\n\s*\)\.then/.test(server));
check('“确认”按钮复用关闭逻辑', /\$close\.Text = '确认'/.test(ps1));
check('登录失效时不显示“查看目前积分/立刻报名”', /\$points\.Visible = \$false/.test(ps1) && /\$signup\.Visible = \$false/.test(ps1));
check('有“稍后提醒我”按钮', /稍后提醒我/.test(ps1));
check('悬停展开时间菜单', /\$snooze\.Add_MouseEnter\(\{/.test(ps1));
check('菜单有 15/30/60/120 分钟四档', /@\(15, '15 分钟后（默认）'\)/.test(ps1) && /@\(30, '30 分钟后'\)/.test(ps1) && /@\(60, '1 小时后'\)/.test(ps1) && /@\(120, '2 小时后'\)/.test(ps1));
check('直接点是 15 分钟', /\$snoozeDefaultMinutes = 15/.test(ps1) && /\$snooze\.Add_Click\(\{ Invoke-Snooze \$snoozeDefaultMinutes \}\)/.test(ps1));
check('稍后提醒会 POST 到 /api/auth/snooze', /api\/auth\/snooze/.test(ps1) && /api\/auth\/snooze/.test(server));
check('不再写“怎么点稍后提醒”的操作说明行', !ps1.includes('点“稍后提醒我”可推迟'));

console.log('');
console.log('=== 4c. 后台的稍后提醒接口 ===');
check('默认 15 分钟常量', /const AUTH_SNOOZE_DEFAULT_MINUTES = 15;/.test(server));
check('非法/缺省值回落默认', /Number\.isFinite\(wanted\) && wanted >= 1 && wanted <= 24 \* 60/.test(server));
check('写入下次提醒时间并落盘', /authNextRemindAt: remindAt/.test(server) && /persistState\(\)/.test(server));
check('到点由定时器触发而不是等下一轮扫描', /scheduleAuthReminder\(remindAt\)/.test(server));
check('已重新登录时忽略稍后提醒', /当前并非失效状态，已忽略/.test(server));

console.log('');
console.log('=== 5. 测试入口与真实提醒行为一致 ===');
check('测试通知也用 0', /notifyWindows\('未央雨课堂活动提醒测试',\s*notificationMessage\(activity\),\s*0,/.test(server));

console.log('');
console.log('=== 6. 活动判定过程必须留痕（这次只能靠翻旧日志才查清）===');
check('记录抓到的活动数', /\[活动\] 抓到 \$\{activitiesWithRegistration\.length\} 个/.test(server));
check('记录本轮新活动及标题', /\[活动\] 本轮新出现 \$\{newCount\} 个/.test(server));
check('记录即将弹窗', /\[通知\] 活动提醒：即将弹出/.test(server));
check('记录启动成功', /\[通知\] 活动提醒：窗口已启动/.test(server));
check('记录启动失败', /\[通知\] 活动提醒：启动失败/.test(server));
check('没有新活动时也记一行', /\[通知\] 活动提醒：本轮没有新活动，不弹窗/.test(server));

console.log('');
console.log('=== 7. 脚本编码（PS 5.1 按 ANSI 读会把这些中文读成乱码）===');
const bytes = fs.readFileSync(ps1Path);
check('windows-notify.ps1 是 UTF-8 带 BOM',
  bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
  '实际前 3 字节: ' + [bytes[0], bytes[1], bytes[2]].map((b) => b.toString(16)).join(' '));
check('脚本里确实有中文（所以 BOM 是必需的）', /[\u4e00-\u9fa5]/.test(ps1));

console.log('');
console.log('=== 8. 稍后提醒接口的真实行为（直接执行 server.js 里那段源码）===');
// 前面都是"源码里有没有这句话"，这一段是把 /api/auth/snooze 的处理代码原样切出来，
// 用假的 request/response 真跑一遍：默认值、越界回落、是否安排定时器都要对。
const vm = require('vm');
const snoozeStart = server.indexOf("if (url.pathname === '/api/auth/snooze'");
const snoozeEnd = server.indexOf("if (url.pathname === '/api/test-notification'");
const snoozeBlock = server.slice(snoozeStart, snoozeEnd);

async function runSnooze(body, authRequired) {
  const calls = { scheduled: [], sent: null, persisted: 0, logs: [] };
  const sandbox = {
    url: { pathname: '/api/auth/snooze' },
    request: { method: 'POST' },
    response: { stub: true },
    readRequestBody: async () => body,
    lastState: { backend: { authRequired } },
    persistState: () => { calls.persisted += 1; },
    logAccess: (tag, line) => calls.logs.push(tag + ' ' + line),
    scheduleAuthReminder: (at) => calls.scheduled.push(at),
    trace: (m) => calls.logs.push(m),
    sendJson: (response, status, payload) => { calls.sent = { status, payload }; },
    AUTH_SNOOZE_DEFAULT_MINUTES: 15,
    JSON, Number, Date, Math, Boolean, console
  };
  vm.createContext(sandbox);
  await vm.runInContext('(async () => {\n' + snoozeBlock + '\n})()', sandbox);
  return { calls, backend: sandbox.lastState.backend };
}

(async () => {
  const before = Date.now();
  const empty = await runSnooze('', true);
  check('请求体为空时按 15 分钟', empty.calls.sent?.payload?.minutes === 15, String(empty.calls.sent?.payload?.minutes));
  check('空请求也返回 ok', empty.calls.sent?.payload?.ok === true);
  check('写入了下次提醒时间', typeof empty.backend.authNextRemindAt === 'number');
  check('睡了状态（persistState 被调用）', empty.calls.persisted > 0);
  check('安排了定时器', empty.calls.scheduled.length === 1);

  const thirty = await runSnooze(JSON.stringify({ minutes: 30 }), true);
  check('按请求的 30 分钟生效', thirty.calls.sent?.payload?.minutes === 30);
  check('下次提醒时间≈现在+30 分钟',
    Math.abs(thirty.backend.authNextRemindAt - (Date.now() + 30 * 60000)) < 5000,
    String(thirty.backend.authNextRemindAt - Date.now()));

  const zero = await runSnooze(JSON.stringify({ minutes: 0 }), true);
  check('0 分钟非法，回落到 15', zero.calls.sent?.payload?.minutes === 15);

  const huge = await runSnooze(JSON.stringify({ minutes: 5000 }), true);
  check('超过一天回落到 15', huge.calls.sent?.payload?.minutes === 15);

  const garbage = await runSnooze('不是 JSON', true);
  check('请求体不是 JSON 时回落到 15', garbage.calls.sent?.payload?.minutes === 15);

  const healthy = await runSnooze(JSON.stringify({ minutes: 30 }), false);
  check('登录已恢复时不安排提醒', healthy.calls.scheduled.length === 0);
  check('登录已恢复时仍然落盘', healthy.calls.persisted > 0);

  console.log('');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
