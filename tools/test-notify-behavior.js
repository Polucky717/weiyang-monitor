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
check('关闭时记录原因（自动超时 / 手动）', /自动超时/.test(ps1) && /手动关闭或点了立刻报名/.test(ps1));

console.log('');
console.log('=== 4. 登录失效提醒保持 20 秒自动关闭 ===');
// 这条是“必须重登才能消掉”的状态，长期占屏反而烦人，所以保留自动关闭
check('登录失效提醒传 20', /'未央观察站：登录已失效'[\s\S]{0,400}?\n\s*20,/.test(server));
check('注释说明了 0 与正数的区别', /0 现在的含义是“永不自动关闭”/.test(server));

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
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
