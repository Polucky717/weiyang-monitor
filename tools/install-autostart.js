// 安装 / 移除 Windows 开机自启（未央观察站）。
//
// 为什么启动项是一个 .lnk（而不是把 .cmd 直接放进去）— 这是实测换来的结论：
//
//  A) 把 .cmd 直接放进启动文件夹：批处理里的中文路径必须靠 %~dp0 或 set 得到。
//     - set "VAR=D:\工程文件\..." 实测会把路径写坏（变量回显成乱码，
//       之后所有 if exist "%VAR%..." 失败，表现为双击毫无反应、无任何日志）。
//     - %~dp0 在启动文件夹里指向启动文件夹本身，而项目在 D:\ 盘，
//       两者没有父子关系（启动文件夹的上一级是 Programs\），所以
//       "pushd .." 到不了项目根 —— 这个坑我踩过一次。
//
//  B) 用 .lnk：快捷方式内部以 UTF-16 / ANSI 保存目标路径，cmd 完全不需要
//     从文件内容里解码中文，因此不受代码页影响。这里用 Windows 自己的
//     WScript.Shell COM 接口创建（不是手写二进制 —— 手写过一版，Windows
//     解析不出目标，双击完全无反应）。
//
//  C) .lnk 的目标指向项目根的 start-autostart.cmd，工作目录设为项目根。
//     该 .cmd 在项目根内部用 %~dp0 定位自己，全程可靠，并负责写
//     startup.log，所以每一步都有审计痕迹。
//
// 用法:
//   node tools\install-autostart.js           安装 / 重新安装 / 刷新
//   node tools\install-autostart.js --remove  关闭开机自启
//   node tools\install-autostart.js --check   只检查状态
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET_CMD = path.join(ROOT, 'start-autostart.cmd');
const STARTUP_DIR = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LNK_NAME = '未央观察站.lnk';
const LNK_PATH = path.join(STARTUP_DIR, LNK_NAME);
// 历史上出现过、需要一并清理的自启项
const LEGACY = ['start-autostart.cmd', '未央雨课堂活动提醒.lnk', 'launch-monitor.vbs'];
const DESCRIPTION = '后台启动未央观察站，不打开终端或网页';

const mode = process.argv.includes('--remove') ? 'remove'
  : process.argv.includes('--check') ? 'check'
    : 'install';

// 通过 PowerShell 调用 WScript.Shell COM 接口读写 .lnk。
// 用 -EncodedCommand（UTF-16LE base64）传脚本，彻底避开命令行中文编码问题。
//
// 读回时有个坑：PowerShell 5.1 写管道用系统 ANSI(GBK)，而 Node 按 UTF-8 解码，
// 中文会变乱码。所以让 PowerShell 用 ConvertTo-Json 输出（非 ASCII 转义成
// \uXXXX），并且“路径是否存在”也在 PowerShell 侧判断（它拿到的才是正确的
// Unicode 路径）——否则 Node 会拿着乱码路径去 existsSync，误报不存在。
function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    return execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded
    ], { encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) {
    throw new Error('无法启动 powershell.exe（' + (e.code || e.message) + '）——'
      + '请在一个普通（非受限沙箱）终端里运行本脚本。');
  }
}

const psLiteral = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function createShortcut() {
  const script = [
    '$sh = New-Object -ComObject WScript.Shell',
    '$sc = $sh.CreateShortcut(' + psLiteral(LNK_PATH) + ')',
    '$sc.TargetPath = ' + psLiteral(TARGET_CMD),
    '$sc.WorkingDirectory = ' + psLiteral(ROOT),
    '$sc.Description = ' + psLiteral(DESCRIPTION),
    '$sc.WindowStyle = 7',
    '$sc.Save()',
    'Write-Output "SAVED"'
  ].join('; ');
  return runPowerShell(script);
}

function readShortcut() {
  const script = [
    '$sh = New-Object -ComObject WScript.Shell;',
    '$sc = $sh.CreateShortcut(' + psLiteral(LNK_PATH) + ');',
    '$o = [ordered]@{',
    '  target = $sc.TargetPath;',
    '  workdir = $sc.WorkingDirectory;',
    '  desc = $sc.Description;',
    '  targetExists = [bool]($sc.TargetPath -and (Test-Path -LiteralPath $sc.TargetPath));',
    '  workdirExists = [bool]($sc.WorkingDirectory -and (Test-Path -LiteralPath $sc.WorkingDirectory));',
    '};',
    '$o | ConvertTo-Json -Compress'
  ].join(' ');
  let out;
  try { out = runPowerShell(script); } catch (e) { return { unavailable: e.message }; }
  const line = out.split(/\r?\n/).filter(Boolean).pop() || '{}';
  try { return JSON.parse(line); } catch (e) { return { parseError: e.message, raw: out }; }
}

function report() {
  console.log('启动文件夹: ' + STARTUP_DIR);
  if (!fs.existsSync(STARTUP_DIR)) { console.log('  (不存在)'); return; }
  const items = fs.readdirSync(STARTUP_DIR).filter((f) => f !== 'desktop.ini');
  if (!items.length) { console.log('  (没有自启项)'); return; }
  for (const f of items) {
    const st = fs.statSync(path.join(STARTUP_DIR, f));
    console.log('  ' + f.padEnd(26) + st.size + ' 字节  ' + st.mtime.toLocaleString());
  }
}

function checkShortcut() {
  console.log('');
  console.log('目标快捷方式: ' + LNK_PATH);
  console.log('  存在: ' + fs.existsSync(LNK_PATH));
  if (fs.existsSync(LNK_PATH)) {
    console.log('  大小: ' + fs.statSync(LNK_PATH).size + ' 字节');
    const info = readShortcut();
    if (info.unavailable) {
      console.log('  无法读回验证: ' + info.unavailable);
    } else if (info.parseError) {
      console.log('  解析输出失败: ' + info.parseError);
      console.log('  原始输出: ' + info.raw);
    } else {
      console.log('  Windows 解析结果:');
      console.log('    目标    : ' + info.target);
      console.log('              -> 存在: ' + info.targetExists);
      console.log('    工作目录: ' + info.workdir);
      console.log('              -> 存在: ' + info.workdirExists);
      console.log('    描述    : ' + info.desc);
    }
  }
  console.log('');
  console.log('被指向的批处理存在: ' + fs.existsSync(TARGET_CMD));
  console.log('  ' + TARGET_CMD);
  console.log('scripts\\start-edge-monitor.ps1 存在: ' + fs.existsSync(path.join(ROOT, 'scripts', 'start-edge-monitor.ps1')));
  console.log('startup.log 存在: ' + fs.existsSync(path.join(ROOT, 'startup.log')));
}

console.log('=== 当前状态 ===');
report();

if (mode === 'check') {
  checkShortcut();
  process.exit(0);
}

if (mode === 'remove') {
  let n = 0;
  for (const f of [LNK_NAME, ...LEGACY]) {
    const p = path.join(STARTUP_DIR, f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('  已删除 ' + f); n += 1; }
  }
  console.log('');
  console.log(n ? '已关闭开机自启（删除 ' + n + ' 项）' : '没有找到需要删除的自启项');
  console.log('后台与监测浏览器不会被停止，需要的话手动关闭即可。');
  process.exit(0);
}

// ---- 安装 ----
console.log('');
console.log('=== 安装前检查 ===');
if (!fs.existsSync(TARGET_CMD)) { console.error('找不到 ' + TARGET_CMD); process.exit(1); }
if (!fs.existsSync(STARTUP_DIR)) { console.error('启动文件夹不存在: ' + STARTUP_DIR); process.exit(1); }
let nonAscii = 0;
for (const b of fs.readFileSync(TARGET_CMD)) if (b > 127) nonAscii += 1;
console.log('  批处理: ' + TARGET_CMD);
console.log('    大小 ' + fs.statSync(TARGET_CMD).size + ' 字节, 非 ASCII 字节 ' + nonAscii + (nonAscii === 0 ? '  ✓ 纯 ASCII' : '  ✗ 含非 ASCII'));

// 清理会重复启动的旧自启项
for (const f of LEGACY) {
  const p = path.join(STARTUP_DIR, f);
  if (fs.existsSync(p)) {
    try { fs.copyFileSync(p, path.join(ROOT, f + '.retired.bak')); } catch (e) { /* 忽略 */ }
    fs.unlinkSync(p);
    console.log('  已移出旧自启项 ' + f + '（备份到项目根）');
  }
}
for (const f of ['AUTOSTART-FAILED.txt']) {
  const p = path.join(STARTUP_DIR, f);
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('  已清理过期的 ' + f); }
}

console.log('');
console.log('=== 创建快捷方式（WScript.Shell COM，非手写二进制）===');
console.log('  ' + createShortcut());
console.log('  大小: ' + fs.statSync(LNK_PATH).size + ' 字节');

console.log('');
console.log('=== 用 Windows 自己的解析器读回验证 ===');
const info = readShortcut();
if (info.unavailable) {
  console.log('  ! 无法验证: ' + info.unavailable);
  console.log('  （快捷方式已写出，但没能读回确认；请用 --check 复查）');
} else if (info.parseError) {
  console.log('  ✗ 解析失败: ' + info.parseError);
  console.log('  原始输出: ' + info.raw);
  process.exit(1);
} else {
  console.log('  目标    : ' + info.target);
  console.log('            -> 存在: ' + info.targetExists);
  console.log('  工作目录: ' + info.workdir);
  console.log('            -> 存在: ' + info.workdirExists);
  console.log('  描述    : ' + info.desc);
  const ok = info.targetExists === true && info.workdirExists === true;
  console.log('');
  console.log('  ' + (ok
    ? '✓ 快捷方式有效：Windows 解析出目标与工作目录，且两者都存在'
    : '✗ 快捷方式无效：目标或工作目录不存在'));
}

console.log('');
console.log('=== 安装后的启动文件夹 ===');
report();
console.log('');
console.log('验证（不必重启）：双击启动文件夹里的快捷方式，然后看项目根 startup.log');
console.log('是否新增 autostart-enter / autostart-launched 两行。');
console.log('真正的验证是重启一次。关闭自启: node tools\\install-autostart.js --remove');
