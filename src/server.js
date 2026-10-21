const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

// server.js 在 src/ 下，而配置、登录态、logs/ 和静态文件都在项目根，
// 所以基准目录要显式上退一级（不能再用 __dirname）。
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'monitor.config.json');
const STATE_PATH = path.join(ROOT, '.weiyang-state.json');
const HOME_URL = 'https://weiyang.yuketang.cn/pro/portal/home/';
const PROFILE_URL = 'https://weiyang.yuketang.cn/pro/trainingproject/mytraining/index';
const SCORE_URL = 'https://weiyang.yuketang.cn/pro/trainingproject/my-score';
// Keep the Chromium profile in an ASCII-only path. This avoids Windows spawn
// failures on machines where the project directory contains Chinese characters.
const PREFERRED_PROFILE_DIR = process.env.WEIYANG_PROFILE_DIR || path.join(process.env.LOCALAPPDATA || '', 'WeiyangMonitor', 'browser-profile');
const FALLBACK_PROFILE_DIR = path.join(os.tmpdir(), 'WeiyangMonitor', 'browser-profile');
const LOGIN_MARKER = path.join(ROOT, '.weiyang-login-complete');
// 登录态快照：把登录成功时的 cookie 与 localStorage 存成 JSON，每次扫描前恢复。
//
// 为什么要这个：站点的登录凭据**只存在于 cookie 里**（实测 localStorage 只有
// _uuid / nhd / vuex / runtime_xtbz，没有任何令牌），而浏览器配置目录里
// exit_type 是 "Crashed" —— 异常退出时 Chromium **不会保存会话 cookie**，
// 于是登录态在重启后就丢了。用户问的"能不能保存登录信息用于重新登录"，
// 能：保存的是登录态本身（不是密码，也不含密码），由浏览器自己导出与回填。
const SESSION_PATH = path.join(ROOT, '.weiyang-session.json');
let profileDir = PREFERRED_PROFILE_DIR;
try {
  const savedLogin = JSON.parse(fs.readFileSync(LOGIN_MARKER, 'utf8'));
  if (savedLogin.profileDir) profileDir = savedLogin.profileDir;
} catch { /* first run */ }
const PORT = Number(process.env.PORT || 8787);
const config = readConfig();
// The monitor intentionally reads only the authenticated homepage requested by
// the user; other URLs cannot become a data source through configuration.
config.siteUrl = HOME_URL;
config.activityUrl = HOME_URL;

let browserContext;
let browserConnection;
let connectedToExternalEdge = false;
let monitorPage;
// 实际启动的浏览器标识（Edge / Chromium）。登录与扫描必须是同一个浏览器，
// 否则 Windows 下 cookie 解不开、登录态读不出来 —— 这个值要写进日志。
let activeBrowserLabel = '';
// 本次运行是否**确认过**登录有效（读到过积分页数据）。
//
// 为什么需要这个标志：巡检成功时要顺手刷新登录态快照（站点会轮换 csrftoken，
// 快照越新越可能保持有效）。但如果巡检时登录已经失效，此刻的上下文里只有
// csrftoken 这类非会话 cookie —— 用它覆盖快照，会把上一份**真正有效**的
// 登录态毁掉，之后连回填都没得回填。所以只有确认已登录才允许刷新。
let authenticatedThisSession = false;
let scanRunning = false;
let notificationTestRunning = false;

// 关键诊断信息要写进**自己控制的文件**，不能只靠 console.log。
//
// 为什么：进程的 stdout 是否进文件，完全取决于启动方式 —— run-monitor.cmd 走
// npm start 时输出只进控制台窗口；只有 start-autostart.cmd / wrap-npm-start.ps1
// 才会重定向到 logs\server.log。结果就是排查“改了代码没生效”时，我一直在读一个
// 早已停止更新的 server.log，据此反复得出错误结论（误判了好几次代码版本）。
// 这里让代码自己落盘到 logs\scan.log，无论怎么启动都能看到运行轨迹。
const SELF_LOG = path.join(ROOT, 'logs', 'scan.log');
function trace(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(SELF_LOG), { recursive: true });
    fs.appendFileSync(SELF_LOG, line + '\n', 'utf8');
  } catch { /* 落盘失败不该影响扫描 */ }
}

// 代码指纹：源文件大小 + 修改时间。
// 它会出现在 /api/state 的 backend.codeVersion 里，因此**不需要读日志**就能确认
// 当前进程加载的是哪一份代码 —— 这是这次排查踩坑最深的地方：日志文件是否更新
// 取决于启动方式，靠日志判断代码版本会得出完全错误的结论。
const CODE_VERSION = (() => {
  try {
    const stat = fs.statSync(__filename);
    return `${stat.size}@${stat.mtime.toISOString()}`;
  } catch { return 'unknown'; }
})();

let lastState = {
  backend: { status: 'starting', lastScan: null, authRequired: false, error: null, newCount: 0, scanSuccessful: false },
  activities: [],
  sections: [],
  points: [],
  profile: { name: '', meta: '', avatar: '', totalPoints: null, recentPoints: null, recentActivity: '' }
};

// 保留最近一次成功抓取的数据，避免后台重启或临时网络错误时界面突然变空。
// 这里只保存页面已经抓到的结果，不写入 Cookie、密码或浏览器会话。
try {
  const cached = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (cached && Array.isArray(cached.activities) && Array.isArray(cached.points)) {
    lastState = {
      ...lastState,
      ...cached,
      backend: {
        ...lastState.backend,
        ...(cached.backend || {}),
        status: 'starting',
        error: null,
        scanSuccessful: Boolean(cached.backend?.scanSuccessful || cached.backend?.lastScan)
      }
    };
  }
} catch { /* 首次运行或缓存损坏时从空状态开始 */ }

function persistState() {
  try {
    const temporary = `${STATE_PATH}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(lastState, null, 2), 'utf8');
    fs.renameSync(temporary, STATE_PATH);
  } catch (error) {
    console.warn(`无法保存最近一次抓取结果：${error.message}`);
  }
}

function readConfig() {
  const example = {
    siteUrl: HOME_URL,
    activityUrl: HOME_URL,
    pollMinutes: 30,
    selectors: {
      activityCard: '[data-activity-id], .activity-card, .project-card, .course-item',
      title: '.activity-title, .project-title, .card-footer, [class*=activityTitle], [class*=projectTitle], [data-activity-title]',
      description: '.activity-description, .project-description, [class*=activityDescription], [class*=projectDescription]',
      section: '.activity-section, .project-section, .section-name, .card-footer, [class*=activitySection], [class*=projectSection]',
      type: '.activity-type, .activity-kind, .event-type, .card-footer, [class*=activity-type], [class*=event-type], [class*=kind]',
      points: '.points, .score, .integral, [class*=point], [class*=score]',
      deadline: '.deadline, .time, [class*=deadline], [class*=time]',
      pointRow: '.point-item, .score-item, [class*=integral-item], [class*=point-item], .score-card',
      profileName: '[data-user-name], .user-name, .profile-name, [class*=userName], [class*=nickname]',
      profileMeta: '.user-meta, .profile-meta, .user-info, [class*=userInfo], [class*=student]',
      profileAvatar: '[data-user-avatar], .user-avatar, [class*=user-avatar]',
      profileTotalPoints: '.total-points, .total-score, .my-score, [class*=totalPoint], [class*=totalScore]',
      profileRecentActivity: '.recent-activity, .last-activity, [class*=recentActivity], [class*=lastActivity]',
      profileRecentPoints: '.recent-points, .last-points, [class*=recentPoint], [class*=lastPoint]',
      profileRecentActivityList: '.recent-activities, .activity-history, [class*=activityHistory], [class*=recentActivities]'
    },
    pointThresholds: { 多彩未央: 1, default: 5 }
  };
  try { return { ...example, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch { return example; }
}

function now() { return new Date().toISOString(); }

function toneFor(section) {
  if (section.includes('学业')) return 'orange';
  if (section.includes('健康') || section.includes('心理')) return 'pink';
  if (section.includes('实践') || section.includes('创新')) return 'green';
  return 'blue';
}

function numberFrom(text) {
  const match = String(text || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function thresholdFor(section) {
  return Number(config.pointThresholds?.[section] ?? config.pointThresholds?.default ?? 5);
}

// 板块积分是否已达标（current >= target）。
//
// 达标的板块不再提醒、也不计入“待关注活动”：那个板块的积分已经拿满，再报名同一板块
// 的活动不会带来额外积分，提醒只会变成噪音。
//
// 注意“数据是否可信”：积分页抓不到东西时（登录态失效会被跳回主页），一定是
// 0 个板块，此时绝不能据此判定“都没达标以外的结论”；反过来也要小心别把
// “旧数据恰好达标”当成当前状态。所以调用方只在本次积分页确实可用时才启用这个过滤
// （见 scanOnce 里的 scorePageUsable）。
//
// 仍然保留在活动列表里展示（前端会打上“板块已达标”标记）——只是不再催你去报名，
// 而不是把活动藏起来：用户可能仍有其他理由想报名。
function satisfiedSections(points) {
  const done = new Set();
  for (const item of Array.isArray(points) ? points : []) {
    const target = Number.isFinite(item?.target) ? item.target : thresholdFor(item?.section);
    const current = Number.isFinite(item?.current) ? item.current : 0;
    if (target > 0 && current >= target) done.add(item.section);
  }
  return done;
}

// 记录用户已经点过“去报名”的活动。无论是从仪表盘点，还是从 Windows 提醒
// 窗口的“立刻报名”点，都会走 /api/activity/open，最终记录在这里。
// 记录进状态文件，因此刷新页面、重启服务后依然有效。
function markActivityRegistered(title) {
  const wanted = String(title || '').trim();
  if (!wanted) return false;
  const found = (lastState.activities || []).find((item) => item.title === wanted);
  if (!found) return false;
  if (!found.registeredAt) {
    found.registeredAt = new Date().toISOString();
    persistState();
  }
  return true;
}

function isActivityRegistered(item) {
  return Boolean(item && item.registeredAt);
}

function notifyWindows(title, message, durationSeconds = 60, activityUrl = '', activityTitle = '') {
  const script = path.join(ROOT, 'scripts', 'windows-notify.ps1');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: '找不到 Windows 通知脚本。' });
  if (process.env.WEIYANG_DISABLE_WINDOWS_NOTIFY === '1') return Promise.resolve({ ok: false, error: 'Windows 通知已通过配置关闭。' });
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // stderr 重定向到日志文件，而不是用管道（'pipe'）。
  // 原因有两条：一是受限环境下创建命名管道会直接 EPERM，提醒会静默失败；
  // 二是即便成功，stderr 里的报错也只在内存里、事后无法排查。
  // 写成 startup 审计日志后，"有没有弹窗、为什么没弹"都能事后查证。
  const stderrLog = path.join(ROOT, 'logs', 'notify.log');
  try { fs.mkdirSync(path.dirname(stderrLog), { recursive: true }); } catch { }
  let stderrFd;
  try { stderrFd = fs.openSync(stderrLog, 'a'); } catch { stderrFd = 'ignore'; }
  let child;
  try {
    child = spawn(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script,
      '-Title', title, '-Message', message, '-ActivityUrl', activityUrl || '',
      '-ActivityTitle', activityTitle || '',
      '-Port', String(PORT),
      '-DurationSeconds', String(durationSeconds)
    ], {
      windowsHide: false,
      detached: false,
      stdio: ['ignore', 'ignore', stderrFd]
    });
  } catch (error) {
    // spawn 同步抛错（例如管道/句柄被策略拒绝）时，不能让扫描流程一起崩掉。
    try { if (typeof stderrFd === 'number') fs.closeSync(stderrFd); } catch { }
    fs.appendFileSync(stderrLog, `[${new Date().toISOString()}] 启动通知进程失败：${error.message}\n`, 'utf8');
    return Promise.resolve({ ok: false, error: error.message });
  }
  try { if (typeof stderrFd === 'number') fs.closeSync(stderrFd); } catch { }
  fs.appendFileSync(stderrLog, `[${new Date().toISOString()}] 已请求提醒窗口：title="${title}" activity="${activityTitle || '(无)'}" url="${activityUrl || '(无)'}"\n`, 'utf8');
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // 修复：原实现无论收到什么都返回 ok:false（连标题都是硬编码的“失败”），
    // 所以调用方永远只能打印“Windows 活动通知失败”。现在按退出码判断。
    child.once('error', (error) => {
      fs.appendFileSync(stderrLog, `[${new Date().toISOString()}] 通知进程出错：${error.message}\n`, 'utf8');
      finish({ ok: false, error: error.message });
    });
    child.once('close', (code) => {
      if (code === 0) return finish({ ok: true });
      fs.appendFileSync(stderrLog, `[${new Date().toISOString()}] 通知进程退出，代码 ${code}（详见本文件上方的 PowerShell 报错）\n`, 'utf8');
      finish({ ok: false, error: `通知窗口进程退出，代码 ${code}。` });
    });
    // 进程能活过这一小段时间就说明窗口已经建起来了（脚本要等窗口关闭才退出）。
    timer = setTimeout(() => finish({ ok: true }), 1200);
  });
}

// The monitor browser runs headless (see start-edge-monitor.ps1 -NoDashboard),
// so anything opened inside it is invisible to the user. To make the dashboard's
// "去报名" button actually usable, the resolved signup URL is handed to Windows
// through Start-Process, which opens it in the user's normal browser window.
function openInUserBrowser(targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { return Promise.resolve(false); }
  if (!/^https?:$/.test(parsed.protocol)) return Promise.resolve(false);
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    // stdio 全部忽略：既不需要读取输出，也避免在受限环境下因管道创建失败
    // 而报 spawn EPERM。成功与否由进程退出码判断。
    const child = spawn(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Start-Process '${parsed.href.replace(/'/g, "''")}'`
    ], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
    setTimeout(() => finish(true), 8000);
  });
}

function notificationMessage(activity) {
  const rawDescription = String(activity?.description || '').replace(/\s+/g, ' ').trim();
  const description = rawDescription
    .replace(/\s*(主题|时间|地点|主讲人|主办单位)\s*[：:]\s*/g, '\n$1：')
    .replace(/\s+(?=自强讲堂|自强书院开放)/g, '\n')
    .replace(/^\s+/, '')
    .trim();
  return [
    `活动：${activity?.title || '未央雨课堂活动'}`,
    `板块：${activity?.section || '未央雨课堂'}`,
    activity?.type && activity.type !== activity.section ? `类型：${activity.type}` : '',
    description ? `项目简介：${description}` : '项目简介：页面未提供'
  ].filter(Boolean).join('\n');
}

async function getPlaywright() {
  try { return require('playwright'); } catch {
    throw new Error('未安装 Playwright。请先运行 npm install，再运行 npm run install-browser。');
  }
}

// The monitor's headless Edge can disappear (crash, or the user closes it).
// Without this the whole monitor stays dead until the next reboot, because
// every scan and every 去报名 click would fail with ECONNREFUSED.
// Recovery: reconnect once, and if the debug port is really gone, relaunch the
// monitor browser through the same launcher the auto-start shortcut uses.
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function launchDetached(executable, args) {
  return new Promise((resolve) => {
    // stdio:'ignore' avoids pipe-creation failures in restricted environments.
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    child.once('error', () => finish());
    child.once('close', () => finish());
    setTimeout(finish, 4000);
  });
}

async function waitForDebugPort(cdpUrl, totalMs = 25_000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

async function ensureBrowserReachable(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) return true;
  } catch { }
  const launcher = path.join(ROOT, 'scripts', 'start-edge-monitor.ps1');
  if (!fs.existsSync(launcher)) return false;
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  console.warn('监测器 Edge 已退出，正在自动重新启动（后台无头模式）…');
  await launchDetached(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcher, '-NoDashboard', '-LoginOnly']);
  const up = await waitForDebugPort(cdpUrl);
  if (up) console.warn('监测器 Edge 已恢复。');
  else console.error('监测器 Edge 自动重启失败，请手动运行 start-edge-monitor.ps1。');
  return up;
}

async function ensureContext(headless = true) {
  if (browserContext && (!monitorPage || !monitorPage.isClosed())) return browserContext;
  if (browserContext) {
    await browserConnection?.close().catch(() => {});
    browserConnection = undefined;
    browserContext = undefined;
    monitorPage = undefined;
    connectedToExternalEdge = false;
  }
  if (process.env.WEIYANG_CDP_URL) {
    const { chromium } = await getPlaywright();
    const cdpUrl = process.env.WEIYANG_CDP_URL;
    // Restore a dead Edge before attempting to attach, so one failed scan does
    // not require a restart of the whole monitor. Failures here must never
    // replace the real connection error below with a recovery error.
    try { await ensureBrowserReachable(cdpUrl); } catch { }
    try {
      // Edge can leave a stale CDP session behind when a previous scan is
      // interrupted. Always bound the attach operation so the first scan
      // cannot block the HTTP server forever.
      browserConnection = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
      browserContext = browserConnection.contexts()[0];
      if (!browserContext) throw new Error('已连接 Edge，但没有可用浏览器上下文。');
      connectedToExternalEdge = true;
      monitorPage = browserContext.pages().find((page) => page.url().includes('weiyang.yuketang.cn')) || browserContext.pages()[0] || await browserContext.newPage();
      return browserContext;
    } catch (error) {
      // Do not reuse a half-attached browser on the next scan. Closing the
      // Playwright wrapper only detaches from Edge; it does not close Edge.
      await browserConnection?.close().catch(() => {});
      browserConnection = undefined;
      browserContext = undefined;
      monitorPage = undefined;
      connectedToExternalEdge = false;
      const detail = String(error?.message || error);
      if (/Timeout/i.test(detail)) {
        throw new Error(`无法连接监测器专用 Edge（${cdpUrl}）。请关闭监测器 Edge 窗口后重新运行 start-edge-monitor.ps1；如果仍失败，请使用 -RefreshProfile 重建隔离配置。`);
      }
      throw new Error(`连接监测器专用 Edge 失败：${detail}`);
    }
  }
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (error) {
    profileDir = FALLBACK_PROFILE_DIR;
    fs.mkdirSync(profileDir, { recursive: true });
    console.warn(`无法使用首选浏览器目录，已回退到：${profileDir}`);
  }
  const { chromium } = await getPlaywright();
  const commonOptions = {
    headless,
    viewport: headless ? { width: 1440, height: 900 } : null,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: headless ? [] : ['--start-maximized']
  };
  const launchAttempts = [];
  // 始终优先用 Edge，**不分有无界面**。
  //
  // 这里踩过一个代价很大的坑：原先只在 `!headless`（有界面）时才优先 Edge，
  // 于是"登录用 Edge、扫描用 Playwright 自带 Chromium"。
  // 而 Windows 上 cookie 是用 DPAPI 加密的，密钥存在各浏览器**自己的**
  // Local State 里 —— Edge 写的登录 cookie，Chromium 读不出来，会被静默丢弃。
  // 表现就是：明明在浏览器里登录成功了，扫描仍然一直返回
  // {"errorcode":10005,"errormsg":"您没有登陆"}，而持久化的 csrftoken 却能读到
  // （它是 Chromium 自己在运行中写的）。
  //
  // 证据：配置目录里的 "Last Version" 是 155.0.4283.62（Edge 的版本号），
  // 说明这个 profile 是 Edge 建的；而扫描进程启动的是 Chromium 1243。
  // 同一个 profile 被两种浏览器交替使用，登录态不可能稳定。
  if (process.platform === 'win32') {
    const edgeCandidates = [
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean);
    const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
    if (edgePath) launchAttempts.push({ ...commonOptions, executablePath: edgePath });
    launchAttempts.push({ ...commonOptions, channel: 'msedge' });
  }
  // 兜底：没装 Edge 时才用自带 Chromium。
  // 注意这会导致"登录/扫描不同浏览器"的老问题，所以放在最后，
  // 并在真的用到时留下痕迹，方便下次直接看出原因。
  launchAttempts.push({ ...commonOptions });

  let lastLaunchError;
  for (let profileAttempt = 0; profileAttempt < 2 && !browserContext; profileAttempt += 1) {
    for (const options of launchAttempts) {
      try {
        browserContext = await chromium.launchPersistentContext(profileDir, options);
        // 记下实际用的是哪个浏览器：登录与扫描必须是同一个，
        // 否则 cookie 加密密钥不同，登录态读不出来（详见上面的注释）。
        activeBrowserLabel = options.executablePath
          ? `Edge(${path.basename(options.executablePath)})`
          : (options.channel ? `channel:${options.channel}` : 'Playwright自带Chromium');
        break;
      } catch (error) {
        lastLaunchError = error;
      }
    }
    if (!browserContext && profileAttempt === 0) {
      profileDir = path.join(os.tmpdir(), 'WeiyangMonitor', `browser-profile-${Date.now()}`);
      fs.mkdirSync(profileDir, { recursive: true });
      console.warn(`浏览器配置目录无法启动，已改用新目录：${profileDir}`);
    }
  }
  if (!browserContext) throw lastLaunchError;
  monitorPage = browserContext.pages()[0] || await browserContext.newPage();
  // 新上下文建好后，把上次保存的登录态回填进去。
  // 失败不影响扫描：回填不了就照常跑，真掉登录时那条"登录已失效"通知会提醒用户。
  await restoreSessionState(browserContext);
  return browserContext;
}

// 把当前上下文的登录态（cookie + localStorage）存到 SESSION_PATH。
// 只存凭据本身，不含账号密码 —— 密码从来没有经过这个程序。
async function saveSessionState(context, why) {
  if (!context) return false;
  // 巡检路径只有在确认登录有效时才刷新快照，避免用失效上下文覆盖掉好数据。
  // 登录流程本身不受这个限制（它就是要保存刚登录的状态）。
  if (why !== '登录完成' && !authenticatedThisSession) {
    trace(`[登录态] 本次未确认登录有效，跳过刷新快照（避免覆盖掉已有的有效快照）`);
    return false;
  }
  try {
    const state = await context.storageState();
    const cookieCount = (state.cookies || []).length;
    const originCount = (state.origins || []).length;
    // 一个 cookie 都没有时不要写：那多半是还没登录的空上下文，
    // 写进去会把上一份好的登录态覆盖掉。
    if (!cookieCount) return false;
    // 会话 cookie 的判定：expires <= 0。
    // 至少要有一个"站点签发的会话 cookie"才值得保存 —— 只有 csrftoken 这类
    // 持久化标识时，说明登录态并不在这份 cookie 里，存了也没用。
    const sessionCookies = (state.cookies || []).filter((cookie) => !(cookie.expires > 0));
    fs.writeFileSync(SESSION_PATH, JSON.stringify({
      savedAt: new Date().toISOString(),
      why,
      profileDir,
      cookieNames: (state.cookies || []).map((cookie) => `${cookie.domain}|${cookie.name}`).sort(),
      sessionCookieCount: sessionCookies.length,
      state
    }, null, 2), 'utf8');
    trace(`[登录态] 已保存（${why}）：cookie ${cookieCount} 个（其中会话级 ${sessionCookies.length} 个），localStorage 来源 ${originCount} 个`);
    return true;
  } catch (error) {
    trace(`[登录态] 保存失败（${why}）：${String(error && error.message || error)}`);
    return false;
  }
}

// 把保存过的登录态回填到新上下文。
async function restoreSessionState(context) {
  if (!context) return false;
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
  } catch {
    trace('[登录态] 没有可用的登录态快照（首次运行属正常）');
    return false;
  }
  const state = saved && saved.state;
  if (!state || !Array.isArray(state.cookies) || !state.cookies.length) {
    trace('[登录态] 快照里没有 cookie，跳过回填');
    return false;
  }
  try {
    // Playwright 的 addCookies 接受 storageState 里的 cookie 形状（含 expires）。
    // 注意 expires 为 -1 表示会话 cookie —— 回填后它同样只在本次运行内有效，
    // 所以每次启动都要重新回填，这也正是本机制存在的意义。
    await context.addCookies(state.cookies);
  } catch (error) {
    trace(`[登录态] 回填 cookie 失败：${String(error && error.message || error)}`);
    return false;
  }
  // localStorage 要在页面脚本执行**之前**写进去，否则 SPA 启动时读不到，
  // 会用默认值把站点配置覆盖掉。所以用 addInitScript 而不是页面里 evaluate。
  let localStorageApplied = 0;
  try {
    for (const origin of (state.origins || [])) {
      if (!origin || !origin.origin || !Array.isArray(origin.localStorage)) continue;
      const entries = origin.localStorage
        .filter((item) => item && typeof item.name === 'string')
        .map((item) => [item.name, String(item.value == null ? '' : item.value)]);
      if (!entries.length) continue;
      localStorageApplied += entries.length;
      await context.addInitScript((pairs) => {
        try {
          for (const [key, value] of pairs) window.localStorage.setItem(key, value);
        } catch { /* 隐私模式等场景下写不进去，忽略 */ }
      }, entries);
    }
  } catch (error) {
    trace(`[登录态] 回填 localStorage 失败：${String(error && error.message || error)}`);
  }
  const savedAt = saved.savedAt || '未知时间';
  trace(`[登录态] 已回填：cookie ${state.cookies.length} 个，localStorage ${localStorageApplied} 项（保存于 ${savedAt}）`);
  return true;
}

async function loginFlow() {
  const context = await ensureContext(false);
  const page = monitorPage || context.pages()[0] || await context.newPage();
  monitorPage = page;
  try {
    await page.goto(config.siteUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    console.warn(`页面暂时无法加载：${error.message}`);
    console.warn('浏览器窗口仍会保持打开，请确认网络后在窗口中访问未央雨课堂。');
  }
  await page.bringToFront().catch(() => {});
  console.log('已打开未央雨课堂，请在浏览器窗口中完成登录。');
  console.log('登录完成后回到终端按 Enter，后台会保存会话并关闭浏览器。');
  await waitForEnter();
  fs.writeFileSync(LOGIN_MARKER, JSON.stringify({ profileDir, completedAt: new Date().toISOString() }, null, 2), 'utf8');
  // 先把登录态导出成快照，再关浏览器。
  //
  // 顺序不能反：上下文一关就取不到 storageState 了。而这一步是**最可靠的**
  // 保存方式 —— 配置目录里 exit_type 是 "Crashed" 时，Chromium 不会把会话
  // cookie 写到磁盘，只依赖配置目录就会丢登录态；导出成快照则不受影响。
  await saveSessionState(context, '登录完成');
  await context.close();
  // 等浏览器进程真正退出再继续。
  // 关键：会话 cookie 是浏览器**在退出过程中**写盘的（正常退出才写），
  // 立刻往下走会在它写完之前就启动新实例，等于白等 —— 这也正是配置目录里
  // 出现 exit_type="Crashed" 的原因之一。
  await waitForBrowserExit();
  browserContext = undefined;
  console.log(`会话已保存到 ${profileDir}`);
  console.log(`登录态快照：${SESSION_PATH}`);
}

// 等浏览器进程退出，最多等 8 秒。进程句柄拿不到时静默跳过（不代表失败）。
async function waitForBrowserExit() {
  const browser = browserContext && browserContext.browser && browserContext.browser();
  if (!browser) { await new Promise((r) => setTimeout(r, 1500)); return; }
  try {
    const closed = new Promise((resolve) => {
      browser.once('disconnected', resolve);
      browserContext.once('close', resolve);
    });
    await Promise.race([closed, new Promise((r) => setTimeout(r, 8000))]);
    // 断开之后再多给一点时间，让 cookie 落盘。
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* 忽略 */ }
}

function waitForEnter() {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => input.question('', () => { input.close(); resolve(); }));
}

async function extractState(page) {
  const selectors = config.selectors;
  if (page.url().includes('/pro/portal/trainclasslist')) return extractActivitiesFromList(page, selectors);
  const activities = await page.$$eval(selectors.activityCard, (cards, selectors) => cards.map((card, index) => {
    const text = (selector) => card.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return {
      id: card.getAttribute('data-activity-id') || `remote-${index}`,
      url: card.querySelector('a[href]')?.href || '',
      title: text(selectors.title),
      description: text(selectors.description),
      section: (text(selectors.section).match(/[“"]?([^“"”"]+?)[”"]?类型活动/) || [])[1] || text(selectors.section),
      type: text(selectors.type).match(/类型活动/)?.[0] || text(selectors.type),
      points: text(selectors.points),
      meta: text(selectors.deadline)
    };
  }), selectors).catch(() => []);

  const pointRows = await page.$$eval(selectors.pointRow, (rows) => rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim() || '')).catch(() => []);
  const points = pointRows.map((text) => {
    const match = text.match(/^\s*(.*?)\s*(?:[:：])?\s*(\d+(?:\.\d+)?)\s*(?:\/|\/\s*\d|分|积分)/);
    const section = match?.[1]?.trim();
    return section ? { section, current: Number(match[2]), target: thresholdFor(section), tone: toneFor(section) } : null;
  }).filter(Boolean);

  const normalizedActivities = activities.map((item) => ({
    ...item,
    points: item.points && /\d/.test(item.points) ? numberFrom(item.points) : null,
    type: item.type,
    // 图标由前端按板块决定（app.js 的 SECTION_ICONS），这里不再下发 icon 字段。
    tone: toneFor(item.section),
    newly: true
  })).filter((item) => item.title && item.section && item.type);
  const sections = new Map(points.map((item) => [item.section, item]));
  const rawProfile = await page.evaluate((selectors) => {
    const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const avatar = document.querySelector(selectors.profileAvatar);
    const avatarText = avatar?.getAttribute('alt') || avatar?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return {
      name: text(selectors.profileName),
      meta: text(selectors.profileMeta),
      avatar: avatarText,
      totalPointsText: text(selectors.profileTotalPoints),
      recentActivity: text(selectors.profileRecentActivity),
      recentPointsText: text(selectors.profileRecentPoints),
      recentActivities: Array.from(document.querySelectorAll(`${selectors.profileRecentActivityList} li, ${selectors.profileRecentActivityList} [data-activity]`)).map((node) => node.textContent?.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5)
    };
  }, selectors).catch(() => ({}));
  const recentPointsMatch = String(rawProfile.recentPointsText || '').match(/\d+(?:\.\d+)?/);
  const profile = {
    name: rawProfile.name || '',
    meta: rawProfile.meta || '',
    avatar: rawProfile.avatar?.slice(0, 1) || '',
    totalPoints: rawProfile.totalPointsText ? numberFrom(rawProfile.totalPointsText) : null,
    recentPoints: recentPointsMatch ? Number(recentPointsMatch[0]) : null,
    recentActivity: rawProfile.recentActivity || rawProfile.recentActivities?.[0] || '',
    recentActivities: rawProfile.recentActivities || []
  };
  return { activities: normalizedActivities, points: [...sections.values()], profile };
}

// 未央的“开放报名”状态由接口 sign_up.status 精确给出，不需要靠页面文案猜：
//   6 = 立即报名（正在报名）   5 = 报名已满   4 = 报名已结束   3 = 报名未开始
// 之前只看卡片上有没有“报名结束”字样，既不精确，也只能覆盖抓到的那些卡片。
const SIGNUP_OPEN_STATUS = 6;

// 只有这五个板块计入积分要求（其余如“微沙龙讲座”“比赛培训”是活动形式，不是积分板块）。
// 一个活动可能同时带多个标签，例如「先进制造 + 微沙龙讲座」「资源环境 + 能源电力」。
// 此时按用户的规则优先取这里的积分板块：否则活动的积分会被算到一个根本不积分的
// 板块上（界面上表现为板块标错、积分进度也不再归位）。
const CORE_POINT_SECTIONS = ['先进制造', '能源电力', '资源环境', '信息工业', '多彩未央'];

// 从活动标签里挑板块：优先五大积分板块，其次退回第一个标签。
function resolveSection(tags, fallbackTag = '', activityForm = '') {
  const names = (Array.isArray(tags) ? tags : [])
    .map((tag) => String((tag && tag.name) || tag || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const core = names.find((name) => CORE_POINT_SECTIONS.includes(name));
  if (core) return core;
  if (names.length) return names[0];
  return fallbackTag || (String(activityForm).includes('微沙龙') ? '微沙龙讲座' : '');
}

// 已知的板块名全集：五大积分板块 + 装修/活动形式类标签（见上面 resolveSection 的注释）。
// 用来从活动文本里认出板块名。
const KNOWN_SECTIONS = [...CORE_POINT_SECTIONS, '微沙龙讲座', '比赛培训', '学业支持', '健康心理', '实践创新'];

// 从活动文本里扫板块名。积分说明句几乎总是把板块名写在引号里且紧挨着"积分"，
// 例如：积分发放：“信息工业”板块2积分，由土木学院发放
// 这种句子是"哪个板块拿分"的明确声明，比接口 tags 更权威 —— 实测有活动的 tags
// 缺失或顺序不对，此时只有文本里能确定板块，活动就会因为 section 为空被丢掉。
//
// 只认引号包裹（“X”/"X"/'X'）或紧邻"板块"二字的写法，避免把正文里偶然出现的
// 板块名当成积分归属。
function sectionFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/积分/.test(line)) continue;
    // 1) 引号里的板块名
    for (const match of line.matchAll(/[“"']([^“"'\r\n]{2,8})[”"']/g)) {
      const name = match[1].trim();
      if (KNOWN_SECTIONS.includes(name)) return name;
    }
    // 2) "X板块" 这种不带引号的写法
    const bare = line.match(/([\u4e00-\u9fff]{2,8})板块/);
    if (bare && KNOWN_SECTIONS.includes(bare[1].trim())) return bare[1].trim();
  }
  return '';
}

// 列表接口的 page_size 上限是 50（传更大也只返回 50），所以取全量活动必须翻页。
// 页面本身只有 22 页 / 212 条，而界面一页只渲染 10 张卡片——只读第一页就会漏掉
// 绝大部分活动。这里按页把所有记录取回来；第一页就失败则返回空数组，
// 调用方退回“只用页面卡片”的旧行为，不会让整次扫描失败。
async function fetchAllActivityRecords(page, baseUrl, headers) {
  const perPage = 50;
  const all = [];
  const seen = new Set();
  let maxPages = 12; // 先给个保守上限，拿到 total 后再按 总条数/50 修正
  const buildUrl = (pageNumber) => {
    try {
      const target = new URL(String(baseUrl || ''));
      target.searchParams.set('page', String(pageNumber));
      target.searchParams.set('page_size', String(perPage));
      return target.toString();
    } catch { return ''; }
  };
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const target = buildUrl(pageNumber);
    if (!target) break;
    let results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await page.evaluate(async ({ url, requestHeaders }) => {
        const res = await fetch(`${url}&monitor_ts=${Date.now()}`, { credentials: 'include', cache: 'no-store', headers: requestHeaders });
        if (!res.ok) return { ok: false, results: [], total: 0 };
        const payload = await res.json();
        return {
          ok: true,
          results: Array.isArray(payload?.data?.results) ? payload.data.results : [],
          total: Number(payload?.data?.total) || 0
        };
      }, { url: target, requestHeaders: headers }).catch(() => ({ ok: false, results: [], total: 0 }));
      if (response.ok) {
        results = response.results;
        if (response.total > 0) maxPages = Math.min(40, Math.ceil(response.total / perPage) + 1);
        break;
      }
      await page.waitForTimeout(400);
    }
    if (!results.length) break; // 末页 / 后端忽略了 page 参数
    let added = 0;
    for (const record of results) {
      const key = String(record.train_class_id || record.sign || record.train_class_name || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(record);
      added += 1;
    }
    if (added === 0) break;
    if (results.length < perPage) break; // 最后一页不满，取完了
  }
  return all;
}

// 把接口记录转成与页面卡片一致的结构。接口是权威来源：它给出精确的报名状态
// （sign_up.status）、板块（tags）、详情页哈希（sign）以及完整简介。
// detailText 是该活动详情页的可见文本，用于补出简介里没写的积分。
// 从任意活动文本里读出「板块名 + 积分数」这两个判定要素。
//
// 积分写法实测有好几种，所以用两条正则、按顺序试：
//   A. 数字在前："1积分"、"2个单位活动积分"、"2学时 2积分"、
//      以及被引号包住的 "积分设置：“1”积分"
//   B. 标签在前："积分发放：“信息工业”板块2积分"（真实观测）、
//      "积分：2"、"可获得积分 2 分"、"奖励积分：2分"
//
// 两条都刻意做成"单行内"匹配，且空白一律用 [ \t] 而不是 \s：
// 详情页文本里有"讲座时间：2026年10月15日 13：30-15：05"这样的行，若允许跨行
// 匹配，B 会从上一行的 "05" 一路吃到下一行的"积分"，把时间读成积分
// （实测确实发生了：同一条文本里读到 05 而不是 2）。所以按行切分后再逐行匹配。
//
// B 的间隔上限 8 个字也必要：否则"积分获取方式"和后面不相干的数字会被连起来。
const POINTS_PATTERNS = [
  /(\d+(?:\.\d+)?)[ \t]*(?:个[ \t]*)?(?:单位[ \t]*)?(?:活动[ \t]*)?[“"']?[ \t]*积分/,
  /积分[^0-9\r\n]{0,8}?(\d+(?:\.\d+)?)[ \t]*(?:个[ \t]*)?(?:单位[ \t]*)?(?:活动[ \t]*)?[ \t]*[“"']?[ \t]*分?/
];

function findPointsInText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const pattern of POINTS_PATTERNS) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return match;
    }
  }
  return null;
}

// 从文本里读出「板块名 + 积分数」。descText/detailText 任一能读出即可。
// 返回的 pointsFrom 说明积分是从哪来的，便于排查。
function readPointsAndSection(descText, detailText = '') {
  const descMatch = findPointsInText(descText);
  const pointsMatch = descMatch || findPointsInText(detailText);
  return {
    points: pointsMatch ? Number(pointsMatch[1]) : null,
    pointsFrom: descMatch ? 'description' : (pointsMatch ? 'detail' : null),
    // 文本里"“信息工业”板块2积分"这类声明是"哪个板块拿分"的明确说法。
    sectionFromText: sectionFromText(descText) || sectionFromText(detailText)
  };
}

// 把接口记录转成与页面卡片一致的结构。接口是权威来源：它给出精确的报名状态
// （sign_up.status）、板块（tags）、详情页哈希（sign）以及完整简介。
// detailText 是该活动详情页的可见文本，用于补出简介里没写的积分。
function activityFromApiRecord(record, index, detailText = '') {
  const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const title = clean(record.train_class_name);
  const description = clean(record.description);
  const signUp = (record.sign_up && typeof record.sign_up === 'object') ? record.sign_up : {};
  const tagList = Array.isArray(record.tags) ? record.tags : [];
  const firstTag = clean(tagList[0] && (tagList[0].name || tagList[0]));
  const activityForm = clean(record.activity_form);
  const sign = clean(record.sign);
  const detailUrl = sign ? `https://weiyang.yuketang.cn/pro/portal/projectdetail/${sign}/` : '';
  const statusLabel = clean(signUp.label);
  const { points, pointsFrom, sectionFromText: textSection } = readPointsAndSection(description, detailText);
  // 板块优先用接口 tags；tags 认不出积分板块时，用文本里"“信息工业”板块2积分"
  // 这类声明补上 —— 实测有活动的 tags 缺失/顺序不对，只有文本能确定板块归属，
  // 否则活动会因为没有 section 被展示过滤器丢掉。
  const taggedSection = resolveSection(tagList, firstTag, activityForm);
  const section = (taggedSection && CORE_POINT_SECTIONS.includes(taggedSection))
    ? taggedSection
    : (textSection || taggedSection);
  return {
    id: `train-${index}-${title}`,
    url: detailUrl || 'https://weiyang.yuketang.cn/pro/portal/trainclasslist',
    detailUrl,
    title,
    description,
    section,
    type: firstTag || activityForm || '',
    points,
    // 记录来源，方便在日志和界面上判断“这个积分是猜的还是读到的”。
    pointsSource: pointsFrom,
    meta: [clean(signUp.class_time), clean(signUp.sign_up_time)].filter(Boolean).join(' · '),
    status: statusLabel || (Number(signUp.status) === SIGNUP_OPEN_STATUS ? '立即报名' : ''),
    canRegister: Number(signUp.status) === SIGNUP_OPEN_STATUS
  };
}

// 有的活动把积分只写在详情页/课程介绍上（简介完全没提）。这类活动同样值得提醒，
// 所以对“简介里读不到积分、而且有详情页地址”的记录补开一次详情页，读它的可见文本。
//
// 为什么由调用方在“按标题去重之后”传进来：同一个标题会有多条期次记录（本期
// “立即报名”+ 往期“报名已结束”），去重时只保留一条。如果在去重之前按记录去抓，
// 保留下来那条可能压根没抓过，积分就丢了 —— 明明详情页写着也读不到。
//
// 这里只处理“可报名 + 积分还读不出来”的那些：
//   * 不可报名的活动会被展示过滤器丢掉，为它们多开一次导航纯属浪费；
//   * 积分已经读出来的不必再跑一趟。
// 详情页导航是本函数里唯一的耗时来源（每条一次 goto + 1.2s 等待），
// 所以这两个条件同时也是性能护栏。
async function fillPointsFromDetailPages(page, targets) {
  const filled = new Map();
  // 同一个 sign 只抓一次，避免重复导航。
  const fetched = new Set();
  for (const record of targets) {
    const sign = String(record.sign).trim();
    if (fetched.has(sign)) continue;
    fetched.add(sign);
    const url = `https://weiyang.yuketang.cn/pro/portal/projectdetail/${sign}/`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.body.innerText || '');
      // 用 sign 做 key：它在本函数里是唯一的，而 train_class_id 可能缺失或为 0，
      // 那样 write/read 两侧的 key 就会不一致，取回来永远是空字符串。
      filled.set(sign, text);
    } catch { /* 单个详情页失败不影响整体扫描 */ }
  }
  return filled;
}

async function extractActivitiesFromList(page, selectors) {
  const activityListUrl = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name)
    .find((url) => url.includes('/train_platform/v1/detail/setting/all_trainclass_list/')) || '')
    || 'https://weiyang.yuketang.cn/train_platform/v1/detail/setting/all_trainclass_list/?page=1&page_size=10&query=&key=up_time&value=-&term=latest&uv_id=2993';
  const cookies = await page.context().cookies(page.url());
  const cookieValue = (name) => cookies.find((cookie) => cookie.name === name)?.value || '';
  // 取全量活动：接口每页上限 50 条、共 200 多条，页面只渲染第一页的 10 张卡片。
  // 只要接口可用就以接口全量记录为准，页面卡片负责补充更丰富的展示字段。
  const apiActivities = await fetchAllActivityRecords(page, activityListUrl, {
    'x-csrftoken': cookieValue('csrftoken'),
    'terminal-type': 'web',
    xtbz: cookieValue('xtbz') || 'training',
    'university-id': cookieValue('university_id') || '2993',
    'platform-id': cookieValue('platform_id') || '8',
    'x-client': 'web',
    accept: 'application/json, text/plain, */*'
  }).catch(() => []);
  // 接口侧的统一结构：它是全量活动的权威来源，能覆盖页面第一页之外的其余活动
  // （页面只渲染 10 张卡片，接口里有 200 多条）。
  const apiBuilt = apiActivities.map((record, index) => activityFromApiRecord(record, index))
    .filter((item) => item.title);
  const apiBuiltByTitle = new Map();
  const apiBuiltByUrl = new Map();
  for (const item of apiBuilt) {
    if (!apiBuiltByTitle.has(item.title)) apiBuiltByTitle.set(item.title, item);
    if (item.detailUrl && !apiBuiltByUrl.has(item.detailUrl)) apiBuiltByUrl.set(item.detailUrl, item);
  }
  // 组件卡片（DOM）只作为接口不可用时的兜底，不再参与合并：
  // 实测卡片上的“是否可报名”判据（有没有“报名结束”字样）与接口状态不一致，
  // 合并时会把接口已确认开放报名的活动覆盖成“不可报名”，导致活动凭空消失。
  // 接口本身就提供了标题、简介、板块（tags）、积分（简介或详情页）、
  // 详情页地址（sign）和精确报名状态（sign_up.status），是唯一权威来源。
  const pageActivities = await page.$$eval('li.list-item', (cards, payload) => {
    const apiRecords = payload.records;
    const apiByTitle = new Map(Object.entries(payload.byTitle));
    const apiByUrl = new Map(Object.entries(payload.byUrl));
    return cards.map((card, index) => {
      const text = (selector) => card.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const title = text('h3.title');
      const detailBtnHref = card.querySelector('.detail-btn')?.href || '';
      const apiBuiltItem = apiByTitle.get(title) || (detailBtnHref ? apiByUrl.get(detailBtnHref) : null) || {};
      return {
        ...apiBuiltItem,
        id: card.getAttribute('data-id') || apiBuiltItem.id || `train-${index}-${title}`,
        title: title || apiBuiltItem.title || '',
        detailUrl: apiBuiltItem.detailUrl || (/^https?:/i.test(detailBtnHref) ? detailBtnHref : '')
      };
    });
  }, { records: apiActivities, byTitle: Object.fromEntries(apiBuiltByTitle), byUrl: Object.fromEntries(apiBuiltByUrl) });


  // 合并：接口全量记录打底，卡片只补接口没覆盖到的标题。
  // 同一个标题会出现在多个期次里（例如“未来新型零碳热力系统的挑战和机遇”既有
  // 本期“立即报名”、也有往期“报名已结束”）。因此按标题去重时必须优先保留
  // 正在报名的那一条，否则往期记录会把本期挤掉，活动就凭空消失了。
  const rankOf = (item, index) => {
    const record = apiActivities[index] || {};
    const recency = Number(record.train_class_id) || 0; // 班级 id 越大越新
    return [item.canRegister ? 1 : 0, recency];
  };
  const isBetter = (candidate, candidateIndex, incumbent, incumbentIndex) => {
    const [candOpen, candRecent] = rankOf(candidate, candidateIndex);
    const [incOpen, incRecent] = rankOf(incumbent, incumbentIndex);
    if (candOpen !== incOpen) return candOpen > incOpen;
    return candRecent > incRecent;
  };
  const merged = new Map();
  apiBuilt.forEach((item, index) => {
    const existing = merged.get(item.title);
    if (!existing || isBetter(item, index, existing, existing.index)) merged.set(item.title, { ...item, index });
  });
  // 卡片数据（接口不可用时的兜底）只在标题完全没被接口覆盖时补上。
  for (const item of pageActivities) {
    if (item.title && !merged.has(item.title)) merged.set(item.title, { ...item, index: -1 });
  }

  // 板块筛选菜单必须在离开列表页之前抓：下面的详情页抓取会导航到别的页面，
  // 之后再查 .filter-item-option 就什么都拿不到了。
  const sections = await page.$$eval('.filter-item-option', (nodes) => [...new Set(nodes
    .filter((node) => node.closest('.filter-item')?.querySelector('.title')?.textContent?.includes('分类标签'))
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter((text) => text && text !== '全部'))]).catch(() => []);

  // 到这里已经确定要保留哪些活动了，再补详情页积分 —— 顺序不能提前：
  // 提前抓的话，去重后可能保留的是另一条期次记录（本期/往期同标题），
  // 那条没抓过详情页，积分就丢了。
  const survivors = [...merged.values()];
  const signOf = (item) => (item.detailUrl ? (item.detailUrl.match(/projectdetail\/([^/]+)/) || [])[1] || '' : '');
  const detailTexts = await fillPointsFromDetailPages(page, survivors
    .filter((item) => signOf(item) && item.canRegister && !(Number.isFinite(item.points) && item.points > 0))
    .map((item) => ({ sign: signOf(item) }))).catch(() => new Map());
  for (const item of survivors) {
    // 只补读不到积分的，不覆盖已经从简介读到的值。
    if (Number.isFinite(item.points) && item.points > 0) continue;
    const text = detailTexts.get(signOf(item)) || '';
    if (!text) continue;
    const { points, sectionFromText: textSection } = readPointsAndSection('', text);
    if (Number.isFinite(points) && points > 0) {
      item.points = points;
      item.pointsSource = 'detail';
    }
    // 详情页若声明了板块，而接口 tags 没给出积分板块，就用详情页的声明。
    if (textSection && !CORE_POINT_SECTIONS.includes(item.section)) item.section = textSection;
  }
  const activities = survivors.map(({ index, ...rest }) => rest);

  const cardSections = [...new Set(activities.map((item) => item.section).filter(Boolean))];
  return {
    // 保留“必须能确定积分、且积分大于 0”这条规则：无法判断积分的活动不展示，
    // 避免出现“+—分”的误导项。是否可报名以接口状态为准。
    activities: activities.map((item) => ({ ...item, tone: toneFor(item.section), newly: true })).filter((item) => item.title && item.section && item.canRegister && Number.isFinite(item.points) && item.points > 0),
    sections: [...new Set([...sections, ...cardSections])],
    points: [],
    profile: { name: '', meta: '', avatar: '', totalPoints: null, recentPoints: null, recentActivity: '' }
  };
}

async function extractPersonalProfile(page) {
  const raw = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const statDescriptions = [...document.querySelectorAll('.statistic .des')].map((node) => clean(node.textContent));
    const pointsText = statDescriptions.find((text) => /积分/.test(text)) || '';
    // 不能用 /(\d+)\s*积分/：“个人积分”这类说明文字会让“0 个人积分”被误读成
    // 总分 0（曾经导致明明有积分却显示“0 分”）。这里排除“个人/单位/活动”等
    // 说明性前缀，只接受“N 积分”“N 个积分”这类计数写法。
    const pointsMatch = pointsText.match(/(\d+(?:\.\d+)?)\s*(?:个|单位|活动)?\s*积分/)
      || (/个人\s*积分/.test(pointsText) ? null : pointsText.match(/(\d+(?:\.\d+)?)\s*积分/));
    const recentActivities = [...document.querySelectorAll('.class_block .item-name')]
      .map((node) => clean(node.textContent)).filter(Boolean).slice(0, 5);
    return {
      name: clean(document.querySelector('.name_text')?.textContent),
      meta: clean(document.querySelector('.position_company')?.textContent),
      avatar: document.querySelector('.avator_box img')?.getAttribute('src') || '',
      totalPoints: pointsMatch ? Number(pointsMatch[1]) : null,
      recentActivity: recentActivities[0] || '',
      recentActivities
    };
  }).catch(() => ({}));
  return {
    name: raw.name || '',
    meta: raw.meta || '',
    avatar: raw.avatar || '',
    totalPoints: Number.isFinite(raw.totalPoints) ? raw.totalPoints : null,
    recentPoints: null,
    recentActivity: raw.recentActivity || '',
    recentActivities: raw.recentActivities || []
  };
}

// 多策略导航到积分页，并顺手把积分相关接口的响应抓下来。
//
// 为什么需要多策略：直接 page.goto(积分页) 有时会被前端路由弹回主页
// （日志里落点是 home/?next=…my-score，且 .my-score 容器都没渲染）。
// 个人页用同样的方式却能正常打开，说明不是登录态问题，而是这条路由对
// “冷启动直连”不友好。所以这里依次尝试：
//   1. 先开主页让 SPA 起来，再导航到积分页
//   2. 若没渲染出内容，退回主页，在站内用 history API 走前端路由
//   3. 若还是不行，直接点页面上指向积分页的链接
// 每条策略之后都等一下表格，任何一条成功就返回。
//
// 同时挂 response 监听收集接口 URL 与 JSON 摘要：即使页面渲染成一具空壳，
// 只要接口把板块数据返回过，下面就能直接解析接口数据，不依赖 DOM。
async function openScorePageAndCapture(page) {
  const apiCalls = [];
  const interesting = /my-?score|score|point|integral|train_platform|trainingproject/i;
  const onResponse = (response) => {
    if (apiCalls.length >= 40) return;
    const url = response.url();
    if (!interesting.test(url)) return;
    if (!/json|\/v\d\/|api/i.test(url) && !/my-?score|score|point|integral/i.test(url)) return;
    const item = { url, status: response.status() };
    apiCalls.push(item);
    // 立刻把正文留下：页面随后可能被导航走，response 就取不到了。
    // 失败的响应也要读 —— 401/403 的正文通常写明原因（未登录？缺头？无权限？），
    // 正是判断“为什么拿不到积分”的关键证据。之前只看状态码，等于把最有用的
    // 信息丢了。
    (async () => {
      try {
        const text = await response.text();
        item.body = text.slice(0, 400);
        try { item.payload = JSON.parse(text); } catch { /* 非 JSON，保留文本 */ }
      } catch { /* 响应已被丢弃 */ }
    })();
  };
  page.on('response', onResponse);

  const ready = async () => {
    // 每条策略最多等 8 秒。四条策略全失败时总耗时上界约 40 秒，
    // 扫描间隔是 30 分钟，这个代价可以接受。
    await page.waitForSelector('.my-score, .el-table__body-wrapper tbody tr', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    return /\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(text);
  };

  const attempts = [
    { name: '直连', run: async () => { await page.goto(SCORE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }); } },
    {
      name: '先主页再直连',
      run: async () => {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(1200);
        await page.goto(SCORE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
    },
    {
      name: '站内前端路由',
      run: async () => {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(1500);
        await page.evaluate((target) => {
          const path = new URL(target).pathname;
          history.pushState({}, '', path);
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        }, SCORE_URL).catch(() => {});
      }
    },
    {
      name: '点击站内链接',
      run: async () => {
        const href = await page.locator('a').evaluateAll((links) => {
          const hit = links.find((node) => /积分|score/i.test(node.textContent || '') && /score/i.test(node.href || ''));
          return hit ? hit.href : '';
        }).catch(() => '');
        if (!href) throw new Error('主页上没有指向积分页的链接');
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
    }
  ];

  const tried = [];
  for (const attempt of attempts) {
    try {
      await attempt.run();
      await page.waitForTimeout(800);
      const ok = await ready();
      tried.push(`${attempt.name}=${ok ? '成功' : '空'}`);
      if (ok) break;
    } catch (error) {
      tried.push(`${attempt.name}=失败(${String(error && error.message || error).slice(0, 40)})`);
    }
  }
  page.off('response', onResponse);

  // 给诊断补三条关键信息：这次页面带了哪些 cookie、统计接口在"补齐活动接口同款请求头"
  // 之后是否还 401、以及活动接口的对照状态。
  //
  // 为什么要对照：活动列表接口在同一个 context 里一直是 200（活动数据能抓到），
  // 说明 cookie 本身有效。如果对照也是 200 而统计接口 401，那问题就锁定在
  // "这个接口要额外的东西"（请求头、uv_id、权限），而不是登录过期 ——
  // 这两条路的修法完全不同：前者补请求头，后者必须让用户重新登录。
  const cookies = await page.context().cookies(SCORE_URL).catch(() => []);
  const cookieNames = cookies.map((cookie) => cookie.name).sort();
  const cookieValue = (name) => cookies.find((cookie) => cookie.name === name)?.value || '';
  // 全量 cookie（不限域）。
  // 之前只查 weiyang.yuketang.cn，看到 5 个非会话 cookie 就以为"没有会话 cookie"，
  // 但登录 cookie 很可能挂在别的域上（.yuketang.cn、changjiang.yuketang.cn、
  // passport 等）。不把全部域列出来，"登录态到底存不存在"这个判断就不成立。
  const allCookies = await page.context().cookies().catch(() => []);
  const cookieDomains = [...new Set(allCookies.map((cookie) => cookie.domain))].sort();
  const cookieBrief = allCookies.map((cookie) => (
    `${cookie.domain}|${cookie.name}${cookie.expires && cookie.expires > 0
      ? '@' + new Date(cookie.expires * 1000).toISOString().slice(0, 10)
      : '@会话'}${cookie.httpOnly ? '|httpOnly' : ''}`
  ));
  const headers = {
    'x-csrftoken': cookieValue('csrftoken'),
    'terminal-type': 'web',
    xtbz: cookieValue('xtbz') || 'training',
    'university-id': cookieValue('university_id') || '2993',
    'platform-id': cookieValue('platform_id') || '8',
    'x-client': 'web',
    accept: 'application/json, text/plain, */*'
  };

  let statsProbe = null;
  // 先把 localStorage 里的可疑凭据读出来，再传进下面的探针。
  // 站点把 token 藏在前端存储里（cookie 只有 csrftoken/xtbz/university_id 这类
  // 平台标识），所以候选鉴权头的内容只能从这里取。
  const storageValues = await page.evaluate(() => {
    const out = {};
    try {
      for (const key of ['nhd', '_uuid', 'runtime_xtbz']) {
        const value = localStorage.getItem(key);
        if (value) out[key] = value;
      }
    } catch { /* 读不到就算了 */ }
    return out;
  }).catch(() => ({}));
  try {
    statsProbe = await page.evaluate(async (h) => {
      const out = {};
      const jsonKeys = (text) => {
        try {
          const value = JSON.parse(text);
          return Object.keys(value || {}).slice(0, 8).join(',') || '(空对象)';
        } catch { return '(非JSON)'; }
      };
      const call = async (label, url, withHeaders) => {
        try {
          const res = await fetch(url, { credentials: 'include', cache: 'no-store', ...(withHeaders ? { headers: h } : {}) });
          const text = await res.text();
          out[label] = { status: res.status, len: text.length, keys: jsonKeys(text), head: text.slice(0, 160) };
        } catch (error) {
          out[label] = { error: String(error && error.message || error).slice(0, 100) };
        }
      };
      const stats = 'https://weiyang.yuketang.cn/train_platform/v1/thu/my/train_statistics/?term=latest&uv_id=2993';
      const acts = 'https://weiyang.yuketang.cn/train_platform/v1/detail/setting/all_trainclass_list/?page=1&page_size=10&query=&key=up_time&value=-&term=latest&uv_id=2993';
      await call('statsPlain', stats, false);
      await call('statsHeaders', stats, true);
      await call('activityHeaders', acts, true);
      // 站点前端可能把 uv_id / 学校信息放在 localStorage 里，统计接口或许只认那个。
      try {
        out.storageKeys = Object.keys(localStorage).slice(0, 20).join(',');
        // 把可疑的鉴权值也 dump 出来（nhd / _uuid / vuex 很可能就是 token 来源）。
        // 只取前 60 字符，够判断格式，不整段复制。
        const picked = {};
        for (const key of ['nhd', '_uuid', 'vuex', 'runtime_xtbz']) {
          try { const v = localStorage.getItem(key); if (v) picked[key] = v.slice(0, 60); } catch { /* 忽略 */ }
        }
        out.storageValues = picked;
        // 整份 localStorage 的规模与逐个键的值（截断）。
        // 为什么全都要：cookie 里只有 csrftoken（持久化）和三个平台标识，
        // **没有任何登录会话 cookie**，所以登录凭据只可能在 localStorage 里。
        // 之前只看了 4 个键，而 vuex 明显是持久化的前端状态，里面很可能就有
        // 用户信息 —— 只有把它整份看清，才能判断"登录到底有没有被保存下来"。
        try {
          const all = {};
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key === null) continue;
            const value = localStorage.getItem(key) || '';
            all[key] = value.length > 200 ? value.slice(0, 200) + '…(共' + value.length + '字)' : value;
          }
          out.storageAll = all;
          out.storageTotal = localStorage.length;
        } catch { out.storageAll = { error: '读不到' }; }
        // 会话存储（sessionStorage）：有些前端把 token 放这里，它随标签页关闭而清空
        // —— 如果登录状态在这里，那"关掉浏览器就掉登录"就完全解释得通。
        try {
          const ss = {};
          for (let i = 0; i < sessionStorage.length; i += 1) {
            const key = sessionStorage.key(i);
            if (key === null) continue;
            const value = sessionStorage.getItem(key) || '';
            ss[key] = value.length > 160 ? value.slice(0, 160) + '…' : value;
          }
          out.sessionAll = ss;
          out.sessionTotal = sessionStorage.length;
        } catch { out.sessionAll = { error: '读不到' }; }
      } catch { out.storageKeys = '(读不到)'; }

      // 逐个试候选鉴权头：实测补上活动接口那套头仍是 401，而站点明确回
      // "您没有登陆"（errorcode 10005）。所以要枚举其它常见位置，确认到底
      // 缺的是哪个头 —— 是"补头能解决"还是"必须重新登录"，结论完全不同。
      //
      // 注意 nhd / _uuid 来自 localStorage（由调用方先读出来传进来），不是 cookie：
      // 整个 cookie 清单里只有 csrftoken / platform_id / platform_type /
      // university_id / xtbz 五项，没有会话 cookie，所以站点要的凭据大概在
      // localStorage 里，由前端拦截器动态加到请求上。
      const base = {
        'x-csrftoken': h['x-csrftoken'], xtbz: h.xtbz, 'terminal-type': 'web',
        'university-id': h['university-id'], 'platform-id': h['platform-id'],
        'x-client': 'web', accept: 'application/json, text/plain, */*'
      };
      const candidates = {
        'plain': {},
        'x-requested-with': { 'x-requested-with': 'XMLHttpRequest' },
        'authorization': { authorization: `Bearer ${h._nhd || ''}` },
        'x-token': { 'x-token': h._nhd || '' },
        'uv-id': { 'uv-id': h.uvId || '2993' },
        'user-id': { 'user-id': h._uuid || '' },
        'referer': { referer: 'https://weiyang.yuketang.cn/pro/trainingproject/my-score' },
        'cookie-xtbz': { 'X-Training-Biz': h.xtbz || '' }
      };
      out.authTries = {};
      for (const [label, extra] of Object.entries(candidates)) {
        const merged = { ...base, ...extra };
        if (!extra.referer) delete merged.referer;
        try {
          const res = await fetch(stats, { credentials: 'include', cache: 'no-store', headers: merged });
          out.authTries[label] = res.status;
        } catch (error) {
          out.authTries[label] = 'ERR';
        }
      }

      // 决定性对照：同时测三个接口，看"要登录"的边界在哪。
      //   user/manager/  —— 返回用户信息（含姓名），必然需要登录
      //   train_statistics —— 板块积分，当前 401
      //   all_trainclass_list —— 活动列表，当前 200
      // 若 user/manager 也 401 而活动列表 200，就说明**活动列表是公开数据、
      // 根本不需要登录**，于是"活动接口能通"完全不能证明会话有效 ——
      // 结论只能是登录已失效。反过来若 user/manager 是 200，则问题局部在积分接口。
      out.endpointCompare = {};
      const compare = {
        'user-manager': 'https://weiyang.yuketang.cn/train_platform/v1/user/manager/?term=latest',
        'train-statistics': stats,
        'activity-list': acts
      };
      for (const [label, url] of Object.entries(compare)) {
        try {
          const res = await fetch(url, { credentials: 'include', cache: 'no-store', headers: base });
          const text = await res.text();
          let who = '';
          try {
            const v = JSON.parse(text);
            // 只在响应里找"姓名"这类登录痕迹，避免把整块数据打出来
            const flat = JSON.stringify(v).slice(0, 300);
            who = flat;
          } catch { who = text.slice(0, 120); }
          out.endpointCompare[label] = { status: res.status, len: text.length, head: who.slice(0, 200) };
        } catch (error) {
          out.endpointCompare[label] = { error: String(error && error.message || error).slice(0, 80) };
        }
      }

      // 页面上有没有登录用户的痕迹：如果连姓名都看不到，页面侧也是未登录状态。
      try {
        const bodyText = document.body ? document.body.innerText : '';
        out.pageHasUserName = bodyText.includes('韩弈超');
        out.pageHasLoginWord = /登录|登陆|扫码/.test(bodyText);
        out.pageUrl = location.href;
      } catch { out.pageHasUserName = '读不到'; }
      return out;
    }, { ...headers, _nhd: storageValues.nhd || '', _uuid: storageValues._uuid || '' });
  } catch (error) {
    statsProbe = { error: String(error && error.message || error).slice(0, 120) };
  }

  // cookie 清单连同过期时间一起记录：如果会话 cookie 已过期，任何请求头都救不了，
  // 必须让用户重新登录 —— 这个判断决定了下一步给用户的指令，不能靠猜。
  const cookieDetail = cookies.map((cookie) => {
    const exp = cookie.expires && cookie.expires > 0
      ? new Date(cookie.expires * 1000).toISOString().slice(0, 16)
      : '会话级';
    return `${cookie.name}(过期=${exp}${cookie.session ? '' : ''})`;
  });

  return { apiCalls, attempts: tried.join(' '), cookieNames, cookieDetail, cookieDomains, cookieBrief, statsProbe };
}

// 从接口响应里找积分数据。
//
// 为什么值得做：积分页的 DOM 抓取依赖 .my-score / el-table_1_column_N 这些
// 具体样式，站点一改就全废，而且这次连页面都没渲染出来。而活动列表早就证明
// “走接口拿数据”是可靠的。这里不硬编码端点，而是在导航积分页时把响应的 JSON
// 按结构筛一遍：只要某个响应里存在“板块 + 数字”的数组，就认为它是积分数据。
// 这样即使站点换了端点名字也能命中。
function extractScoreFromJson(payload) {
  const SECTIONS = ['先进制造', '能源电力', '资源环境', '信息工业', '多彩未央', '微沙龙讲座', '比赛培训', '学业支持', '健康心理', '实践创新'];
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const pickNumber = (node, keys) => {
    for (const key of keys) {
      const value = num(node && node[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const found = [];
  // 活动记录与“板块积分”长得很像：活动列表接口里每条活动同样带 section（'信息工业'）
  // 和 points 字段，光看这两个键会把它误判成板块数据（实测确实误判了，把单条活动的
  // 2 分当成了信息工业板块的总分）。活动记录一定带下面这些活动专有字段，据此排除。
  const ACTIVITY_MARKERS = ['train_class_id', 'train_class_name', 'sign', 'sign_up', 'class_time', 'sign_up_time', 'activity_form', 'deadline'];
  const looksLikeActivity = (entry) => ACTIVITY_MARKERS.some((key) => entry[key] !== undefined && entry[key] !== null && entry[key] !== '');
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || found.length >= 3) return;
    if (Array.isArray(node)) {
      const rows = [];
      for (const entry of node) {
        if (!entry || typeof entry !== 'object') continue;
        if (looksLikeActivity(entry)) continue;
        const name = String(entry.section || entry.module || entry.tag || entry.name || entry.type || '').trim();
        if (!SECTIONS.includes(name)) continue;
        const current = pickNumber(entry, ['current', 'score', 'point', 'points', 'value', 'got', 'gain', 'integral', 'my_score']);
        const target = pickNumber(entry, ['target', 'maximum', 'max', 'full', 'total', 'require', 'need']);
        if (current === null) continue;
        rows.push({ section: name, current, maximum: target });
      }
      if (rows.length) { found.push(rows); return; }
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(payload, 0);
  if (!found.length) return null;
  // 取板块最多的那一组
  return found.sort((a, b) => b.length - a.length)[0];
}

async function extractScoreProgress(page) {
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    // 按“N/M”文本找积分行，而不是靠 .my-score 和 el-table_1_column_N 这类
    // 具体样式名 —— 站点一改样式，绑死选择器的写法就会静默返回 0 行。
    // 同时从同名 class 里读板块名，读不到就看这行里有没有板块关键词。
    const SECTION_NAMES = ['先进制造', '能源电力', '资源环境', '信息工业', '多彩未央', '微沙龙讲座', '比赛培训', '学业支持', '健康心理', '实践创新'];
    const rows = [];
    let lastSection = '';
    // 站点自己写的"总计/合计"值（页面上有的话）。用来对照逐行累加的结果。
    let explicitRowsTotal = null;
    // 只认 <tr>，并且**按元素去重**。
    //
    // 为什么必须去重：原来的选择器是 'tbody tr, .el-table__row, [class*=row]'。
    // 一个 <tr class="el-table__row"> 会同时命中全部三个分支，而
    // querySelectorAll 对同一元素命中多个分支时会**重复返回**它 ——
    // 实测 18 个 tr 被解析成 19 行、每条活动名都出现两次。
    //
    // 这个重复不只是"看着乱"：下面的板块积分是逐行**累加**的（current += row.current），
    // 所以重复行会把分数算成两倍。这是必须堵死的正确性问题。
    const rowElements = [...new Set(document.querySelectorAll('tr, .el-table__row'))];
    const seenRowData = new Set();
    for (const tr of rowElements) {
      // 表头行不是数据：Element UI 的表头也可能是 .el-table__row，
      // 而且它的单元格里带"序号/活动名称/活动课程积分"等列名，会被当成活动名。
      if (tr.closest('.el-table__header-wrapper') || tr.querySelector('th')) continue;
      const text = clean(tr.textContent);
      if (!text || !/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(text)) continue;
      // 整行文字里出现**列名**才算表头行。
      //
      // 这里只能放列名，不能放"讲座""沙龙"这类词 —— 它们会出现在真实活动名里
      // （例如"午餐微沙龙…"），拿来做排除条件会把正常数据行误杀。
      // 判断"是不是表头"另有一条更可靠的依据：表头的单元格数通常和普通行不同，
      // 见下面的 cellCounts 分布。
      if (/序号|活动名称|所属部门|活动时间|活动课程积分|类型名称/.test(text)) continue;
      // 板块名：先看行内元素，再退回整行文本里的关键词
      let section = clean(tr.querySelector('[class*=section], [class*=module], [class*=tag], [class*=cate]')?.textContent);
      if (!SECTION_NAMES.includes(section)) {
        section = SECTION_NAMES.find((name) => text.includes(name)) || '';
      }
      if (!section) {
        // 合并单元格的表格里，板块名可能出现在上一行（rowspan）
        const prev = tr.previousElementSibling;
        if (prev) {
          const prevText = clean(prev.textContent);
          const prevSection = SECTION_NAMES.find((name) => prevText.includes(name));
          if (prevSection) section = prevSection;
        }
      }
      if (!section) section = lastSection;
      if (!section) continue;
      lastSection = section;
      const match = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
      if (!match) continue;
      const current = Number(match[1]);
      const maximum = Number(match[2]);
      // 同一行被多个选择器命中时内容完全一样，用"板块+分数+文字"再挡一道。
      // 元素去重已经能解决重复返回，这里是防止同一行同时是 tr 又嵌套了 tr 的情况。
      const rowKey = `${section}|${current}/${maximum}|${text}`;
      if (seenRowData.has(rowKey)) continue;
      seenRowData.add(rowKey);
      // 另外把"活动名称"单独取出来。
      //
      // 为什么不能用整行 text 当活动名：行的选择器里有 `[class*=row]`，它会命中
      // **包含整张表的外层容器**，那个元素的 textContent 是表头加所有行拼在一起
      // 的一大段（实测拿到的是"序号类型名称活动名称所属部门…1多彩未央软件工程…"）。
      // 之前 recentActivity 直接取 rows[0].text，界面上那段超长文字就是这么来的。
      //
      // 取法：优先按单元格位置猜（活动名称在"类型"之后那一列），拿不到就退回到
      // "行文本里除去板块名和日期后、最长的那一段"—— 活动名通常是最长的。
      // 单元格也要去重：td 和 [class*=cell] 会命中同一个元素。
      const cells = [...new Set(tr.querySelectorAll('td, [class*=cell]'))]
        .map((node) => clean(node.textContent)).filter(Boolean);
      let rowTitle = '';
      const dateLike = (value) => /\d{4}-\d{2}-\d{2}/.test(value);
      if (cells.length >= 3) {
        const byPosition = cells.find((value, index) => (
          index > 0 && !dateLike(value) && value !== section && value.length >= 4
        ));
        if (byPosition) rowTitle = byPosition;
        if (!rowTitle) {
          const longest = cells.filter((value) => !dateLike(value) && value !== section)
            .sort((a, b) => b.length - a.length)[0];
          rowTitle = longest || '';
        }
      }
      if (!rowTitle) {
        // 退化路径：整行文本里去掉板块名、日期时间、积分数字，取最长的一段。
        rowTitle = text
          .replace(new RegExp(section, 'g'), ' ')
          .replace(/\d{4}-\d{2}-\d{2}[^\u4e00-\u9fff]*/g, ' ')
          .replace(/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/g, ' ')
          .split(/\s{2,}/)
          .map((part) => part.trim())
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)[0] || '';
      }
      // "总计/合计"行要单独记下来：它是站点自己给出的权威合计值。
      // 板块积分是**逐行累加**算出来的，一旦行解析多算或漏算，累加值就错了
      // 但我们看不出来 —— 有了站点自己的合计就能直接对照，错了一眼可见。
      // 注意它绝不能当普通行参与累加，否则会重复计算。
      if (/总计|合计|小计/.test(text)) {
        if (explicitRowsTotal === null) explicitRowsTotal = current;
        continue;
      }
      rows.push({ section, current, maximum, text: text.slice(0, 80), title: rowTitle.slice(0, 60), cellCount: cells.length, cells: cells.slice(0, 8) });
    }
    const pageText = clean(document.body && document.body.innerText || '').slice(0, 6000);
    const totalMatch = pageText.match(/(?:获得|累计|共)\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*积分/);
    // 表格规模与分页信息。
    // 为什么需要：板块积分是"逐行累加"得来的，所以必须先确认页面上的明细行
    // **全都被读到了**。如果表格分页（只渲染第一页），累加值就会比真实值小，
    // 而界面上看不出任何异常 —— 必须显式核对行数。
    // 独立重数一遍"看起来像数据行的元素"，用来和真正解析出的行数对照。
    //
    // 两个必须注意的点：
    // 1) 这里的数可能**大于**解析行数，这是正常的 —— 站点把每行渲染了两遍
    //    （同一 <tr class="el-table__row"> 既在 tbody 里又命中 [class*=row]，
    //    且 DOM 里每行确实有重复），去重后行数自然会少。所以两个数不等
    //    **不能**直接判定为异常。
    // 2) 不能用"文字里有没有活动名"来判断一行是不是数据行：活动名恰好包含
    //    "讲座""沙龙"这类词时会被误杀。只按"行内有没有积分进度 N/M"来数。
    let candidateRows = 0;
    for (const node of new Set(document.querySelectorAll('tr, .el-table__row'))) {
      const t = clean(node.textContent);
      if (!t || !/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(t)) continue;
      candidateRows += 1;
    }
    // 每行的单元格个数分布。表头行/总计行的列数通常和普通数据行不同，
    // 这个分布能直接指出"哪一行不是数据行"，比按文字猜可靠得多。
    const cellCounts = {};
    for (const row of rows) {
      const key = String(row.cellCount);
      cellCounts[key] = (cellCounts[key] || 0) + 1;
    }
    const tableInfo = {
      parsedRows: rows.length,
      candidateRows,
      cellCounts,
      tbodyTr: document.querySelectorAll('tbody tr').length,
      elTableRow: document.querySelectorAll('.el-table__row').length,
      rowselectors: document.querySelectorAll('[class*=row]').length,
      pagers: [...document.querySelectorAll('.el-pagination, [class*=pagination], [class*=pager]')]
        .map((node) => clean(node.textContent).slice(0, 70)).filter(Boolean).slice(0, 3),
      totalText: (pageText.match(/共\s*\d+\s*条/) || pageText.match(/共\s*\d+\s*页/) || [''])[0]
    };
    // scraped 表示“这次真的从积分页读到了数据”。绝不能只看容器元素在不在：
    // 积分页是 SPA，.my-score / .el-table__body-wrapper 是空壳容器，数据靠接口
    // 异步填进去。曾经用“元素存在”当判据，把页面上的“0 积分”当成真实总分采纳，
    // 把已知的 14 分覆盖成 0（日志证据：采用=0，积分页可用=true）。
    const scraped = rows.length > 0 || Boolean(totalMatch);
    const hasMyScore = Boolean(document.querySelector('.my-score'));
    const hasTable = Boolean(document.querySelector('.el-table__body-wrapper'));
    const rawRowCount = document.querySelectorAll('tbody tr').length;
    const headings = [...document.querySelectorAll('.my-score .el-table__header-wrapper th, .el-table__header-wrapper th')]
      .map((node) => clean(node.textContent)).filter(Boolean).slice(0, 10);
    return {
      rows,
      tableInfo,
      rowsTotal: explicitRowsTotal,
      totalPoints: totalMatch ? Number(totalMatch[1]) : null,
      totalRead: Boolean(totalMatch),
      scraped,
      diagnostics: {
        hasMyScore, hasTable, rawRowCount, headings,
        url: location.href,
        title: document.title || '',
        textStart: pageText.slice(0, 160)
      }
    };
  }).catch((error) => ({
    rows: [], totalPoints: null, totalRead: false, scraped: false, diagnostics: null, evaluateError: String(error && error.message || error)
  }));

  if (result.evaluateError) trace(`[积分页-诊断] 页面脚本执行失败：${result.evaluateError}`);

  const grouped = new Map();
  for (const row of result.rows || []) {
    const current = grouped.get(row.section) || { section: row.section, current: 0, target: thresholdFor(row.section), tone: toneFor(row.section) };
    current.current += row.current;
    grouped.set(row.section, current);
  }
  return {
    points: [...grouped.values()],
    rows: result.rows || [],
    // 首行原始文本与单元格，供诊断对照 —— 只看 text 无法判断提取对不对，
    // 这次"整张表文字当成活动名"就是靠对照 cells 才定位到的。
    firstRowText: (result.rows || [])[0]?.text || '',
    firstRowCells: (result.rows || [])[0]?.cells || [],
    totalPoints: Number.isFinite(result.totalPoints) ? result.totalPoints : null,
    totalRead: Boolean(result.totalRead),
    // 站点自己给出的明细合计（"总计"行）。null 表示页面上没有这一行。
    rowsTotal: Number.isFinite(result.rowsTotal) ? result.rowsTotal : null,
    tableInfo: result.tableInfo || null,
    scraped: Boolean(result.scraped),
    diagnostics: result.diagnostics || null,
    recentPoints: (result.rows || []).length ? result.rows[0].current : null,
    recentActivity: (result.rows || [])[0]?.title || ''
  };
}

// 判断一段文字是否"不像活动名"，从而拒绝把它显示为"最近活动"。
//
// 为什么必须挡一道：recentActivity 会被直接塞进个人卡片的 DOM，一旦拿到整张
// 表格的文字，那串几百字的拼接文本会把卡片撑爆、盖住整个界面（实测发生过）。
// 取数逻辑再稳也不该让界面承担这个风险，所以在写回状态之前再校验一次。
function looksLikeActivityTitle(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.length > 60) return false;                                  // 真活动名没这么长
  if (/序号|活动名称|所属部门|活动课程|活动时间|类型名称/.test(text)) return false;  // 表头
  if (/\d{4}-\d{2}-\d{2}/.test(text)) return false;                    // 日期
  const sectionHits = ['先进制造', '能源电力', '资源环境', '信息工业', '多彩未央']
    .filter((name) => text.includes(name)).length;
  if (sectionHits >= 2) return false;                                  // 多板块名 = 拼接文本
  return true;
}

async function openActivityListFromHome(page) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(700);
  const listHref = await page.locator('a').evaluateAll((links) => {
    const link = links.find((node) => /活动报名/.test(node.textContent || '') && /trainclasslist/.test(node.href || ''))
      || links.find((node) => /trainclasslist/.test(node.href || ''));
    return link?.href || '';
  }).catch(() => '');
  // The homepage sometimes renders the shortcut asynchronously. The list URL
  // is the real activity endpoint linked by that shortcut, so use it as a
  // fallback instead of making notification testing depend on the dashboard.
  if (!listHref) return page.goto('https://weiyang.yuketang.cn/pro/portal/trainclasslist', { waitUntil: 'domcontentloaded', timeout: 45_000 }).then(() => page.waitForTimeout(1500));
  await page.goto(listHref, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1500);
}

async function scan() {
  if (scanRunning || notificationTestRunning) return lastState;
  scanRunning = true;
  try {
    const context = await ensureContext(true);
    const page = monitorPage || context.pages()[0] || await context.newPage();
    monitorPage = page;
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1000);
    const profileData = await extractPersonalProfile(page);
    // 积分页：多策略导航（直连 / 先主页再直连 / 站内路由 / 点链接），
    // 同时收集积分相关接口的响应，供 DOM 抓不到时兜底。
    const scoreNav = await openScorePageAndCapture(page);
    let scoreData = await extractScoreProgress(page);
    if (scoreData.points.length === 0) {
      // DOM 没给出板块时，看这次导航里有没有积分接口响应可以直接解析。
      // 这条路径不依赖任何样式名，站点改版也还能用。
      for (const call of scoreNav.apiCalls) {
        if (!call.payload) continue;
        const fromApi = extractScoreFromJson(call.payload);
        if (!fromApi || !fromApi.length) continue;
        const grouped = new Map();
        for (const row of fromApi) {
          const current = grouped.get(row.section) || { section: row.section, current: 0, target: thresholdFor(row.section), tone: toneFor(row.section) };
          current.current += row.current;
          grouped.set(row.section, current);
        }
        scoreData = {
          ...scoreData,
          points: [...grouped.values()],
          rows: fromApi,
          scraped: true,
          recentPoints: fromApi[0]?.current ?? null,
          apiSource: call.url
        };
        trace(`[积分页] 改从接口取到 ${fromApi.length} 个板块：${call.url.slice(0, 120)}`);
        break;
      }
    }
    // 记录真实落点、行数与各策略结果，便于对照日志判断失败原因。
    trace(`[积分页] 落点=${page.url()} 板块数=${scoreData.points.length} 页面总分=${scoreData.totalPoints} 明细行=${scoreData.rows?.length ?? '-'} 策略[${scoreNav.attempts}] 接口候选=${scoreNav.apiCalls.length}`);
    const diag = scoreData.diagnostics;
    if (scoreData.points.length === 0) {
      trace(`[积分页-诊断] 根容器=${diag?.hasMyScore} 表格容器=${diag?.hasTable} 原始行数=${diag?.rawRowCount} 标题=${JSON.stringify(diag?.title)} 表头=[${(diag?.headings || []).join(' | ')}]`);
      trace(`[积分页-诊断] 页面开头=${JSON.stringify((diag?.textStart || '').slice(0, 120))}`);
      trace(`[积分页-诊断] cookie=[${(scoreNav.cookieNames || []).join(',')}]`);
      trace(`[积分页-诊断] 全部 cookie 域=[${(scoreNav.cookieDomains || []).join(', ')}]（共 ${(scoreNav.cookieBrief || []).length} 个）`);
      trace(`[积分页-诊断] 本次扫描用的浏览器=${activeBrowserLabel || '未记录'}`);
      for (const brief of (scoreNav.cookieBrief || []).slice(0, 20)) trace(`[积分页-诊断]   cookie ${brief}`);
      for (const call of scoreNav.apiCalls.slice(0, 12)) {
        trace(`[积分页-诊断] 接口 ${call.status} ${call.url.slice(0, 120)}`);
        // 失败响应必须打出正文：它写明原因（未登录 / 缺头 / 无权限），
        // 是决定“让用户重新登录”还是“补齐请求头”的唯一依据。
        if (call.status >= 400 && call.body) trace(`[积分页-诊断]   ↑返回=${JSON.stringify(call.body.slice(0, 220))}`);
      }
      if (!scoreNav.apiCalls.length) trace('[积分页-诊断] 这次导航没有捕获到任何接口响应（页面可能压根没发起请求）');
      const probe = scoreNav.statsProbe;
      if (probe) {
        if (probe.error) {
          trace(`[积分页-诊断] 探针执行失败: ${probe.error}`);
        } else {
          const fmt = (label, r) => r && !r.error
            ? `${label}=${r.status}(len=${r.len} keys=${r.keys})`
            : `${label}=错误(${r ? r.error : '无结果'})`;
          trace(`[积分页-诊断] 探针 ${fmt('统计接口裸请求', probe.statsPlain)} ${fmt('统计接口+请求头', probe.statsHeaders)} ${fmt('活动接口+请求头[对照]', probe.activityHeaders)}`);
          if (probe.statsHeaders && probe.statsHeaders.status >= 400 && probe.statsHeaders.head) {
            trace(`[积分页-诊断]   统计接口返回正文=${JSON.stringify(probe.statsHeaders.head.slice(0, 160))}`);
          }
          if (probe.storageKeys) trace(`[积分页-诊断] localStorage keys=[${probe.storageKeys}]`);
          if (probe.storageAll) {
            trace(`[积分页-诊断] localStorage 共 ${probe.storageTotal} 项：`);
            for (const [key, value] of Object.entries(probe.storageAll)) {
              trace(`[积分页-诊断]   ${key} = ${JSON.stringify(String(value).slice(0, 160))}`);
            }
          }
          if (probe.sessionAll) {
            const keys = Object.keys(probe.sessionAll);
            trace(`[积分页-诊断] sessionStorage 共 ${probe.sessionTotal} 项${keys.length ? '：' : '（空）'}`);
            for (const [key, value] of Object.entries(probe.sessionAll)) {
              trace(`[积分页-诊断]   ${key} = ${JSON.stringify(String(value).slice(0, 160))}`);
            }
          }
          if (probe.storageValues && Object.keys(probe.storageValues).length) {
            const shown = Object.entries(probe.storageValues).map(([k, v]) => `${k}=${JSON.stringify(String(v).slice(0, 40))}`).join(' ');
            trace(`[积分页-诊断] localStorage 凭据候选 ${shown}`);
          }
          if (probe.authTries) {
            trace(`[积分页-诊断] 逐个试鉴权头 ${Object.entries(probe.authTries).map(([k, v]) => `${k}=${v}`).join(' ')}`);
          }
          if (probe.endpointCompare) {
            const rows = Object.entries(probe.endpointCompare)
              .map(([k, v]) => (v && !v.error ? `${k}=${v.status}(len=${v.len})` : `${k}=错误`))
              .join(' ');
            trace(`[积分页-诊断] 接口对照 ${rows}`);
            // 用户信息接口返回的正文里带姓名，是判断"会话是否有效"最直接的证据。
            const um = probe.endpointCompare['user-manager'];
            if (um && um.head) trace(`[积分页-诊断]   user/manager 返回=${JSON.stringify(um.head.slice(0, 150))}`);
          }
          if (probe.pageHasUserName !== undefined) {
            trace(`[积分页-诊断] 页面上有登录用户姓名=${probe.pageHasUserName} 页面出现登录字样=${probe.pageHasLoginWord}`);
          }
          if (scoreNav.cookieDetail) trace(`[积分页-诊断] cookie 明细 ${scoreNav.cookieDetail.join(' ')}`);
        }
      }
    }
    await openActivityListFromHome(page);
    const loginRequired = /login|signin|passport/i.test(page.url());
    if (loginRequired) throw Object.assign(new Error('登录态已失效，请运行 npm run login 重新登录。'), { authRequired: true });
    // 数据层的登录检测：站点在登录失效时**不会**跳转登录页 —— 页面照旧停在
    // my-score 上、HTML 照样返回 200，只有接口静默返回 401
    // {"errorcode":10005,"errormsg":"您没有登陆"}。所以上面那个"URL 里有没有
    // login"的判断根本抓不到，程序会误报"扫描成功"，还把上一次的旧积分当正常值
    // 显示（用户会以为数据是最新的）。实测这个误判让排查绕了好几轮。
    //
    // 判据用站点自己的错误码，而不是"有没有 401"：活动列表是公开接口，
    // 未登录也能 200，而 user/manager 与 train_statistics 必须登录。
    // 只有明确出现 10005 / "您没有登陆" 才判定失效，避免把偶发 401 误报成登录过期。
    const authFailure = (scoreNav.apiCalls || []).find((call) => (
      call.status === 401
      && (Number(call.payload && call.payload.errorcode) === 10005
        || /没有登[录陆]|未登录/.test(String(call.body || '') + String(call.payload && call.payload.errormsg || '')))
    ));
    if (authFailure) {
      trace(`[登录] 检测到登录已失效（接口 ${authFailure.status}）：${String(authFailure.payload && authFailure.payload.errormsg || authFailure.body || '').slice(0, 60)}`);
      throw Object.assign(new Error('登录态已失效，请运行 npm run login 重新登录。'), { authRequired: true });
    }
    const data = await extractState(page);
    // 空列表也是有效的扫描结果：页面当前可能没有开放报名的活动。
    // 不要用示例数据填充，也不要把“没有活动”误报成后台错误。
    // 个人页/积分页是异步渲染的，偶尔会在首屏尚未完成时返回空结果。
    // 空结果不代表用户积分变成 0，因此保留上一次已确认的真实数据。
    const previousProfile = lastState.profile || {};
    // 累计积分 = 各板块当前积分之和。
    // 为什么以“各板块之和”为准：该值由积分页每一条明细逐行累加得到，最可靠。
    // 而“明确总分”并不可靠 —— 主页统计文案里含“个人积分”这类字样，正则会把
    // “0 个人积分”误抓成总分 0，于是明明有积分却显示“0 分”。
    // 因此优先级：各板块之和 > 页面明确总分 > 上一次的值。
    // 本次实际采用的板块数据：抓到了就用新的，抓不到就沿用上一次的。
    // 下方写回状态时用的也是这一份（points: effectivePoints），
    // 保证“界面上的进度条”和“大字累计积分”永远出自同一组数字。
    const effectivePoints = scoreData.points.length ? scoreData.points : (lastState.points || []);
    const effectiveSum = effectivePoints.reduce((sum, item) => sum + (Number.isFinite(item.current) ? item.current : 0), 0);
    // 只用于日志对照：本次真正抓到多少（scoreData.points 为空时它是 0）。
    const pointsSum = scoreData.points.reduce((sum, item) => sum + (Number.isFinite(item.current) ? item.current : 0), 0);
    const explicitTotal = scoreData.totalPoints ?? profileData.totalPoints ?? null;
    // “积分页这次到底读没读到东西”。scraped 现在只认“解析出明细行”或“摘要里读到
    // 获得 N 积分”，不再认容器元素是否存在（SPA 空壳阶段容器已在、数据还没到）。
    const scorePageUsable = scoreData.points.length > 0 || scoreData.scraped === true;
    const keptTotal = Number.isFinite(previousProfile.totalPoints) ? previousProfile.totalPoints : null;
    // 累计积分的取值顺序（必须与板块数据同源，否则会出现“进度条显示 14、
    // 大字显示 0”的自相矛盾）：
    //   1. 有板块数据（本次抓到的，或上一次保留下来的）→ 用各板块之和
    //   2. 页面明确读到过“获得 N 积分”且 N>0 → 用页面总分
    //   3. 沿用上一次已知的值
    //   4. 确实什么都没有 → 页面读到的值（可能为 null）
    //
    // 为什么第 1 步要接受“上一次保留的板块数据”：mergedPoints 就是这么兜底的
    // （抓不到就沿用 lastState.points），所以进度条会一直显示 14 分。如果这里
    // 反而退回 0，同一张卡片上就会出现互相矛盾的 14 和 0。
    //
    // 为什么“页面明确总分”只认大于 0 的：个人主页那个元素的实际文案是
    // “0 个人积分”，正则会把 0 读成总分；它证明不了用户真的是 0 分。
    const explicitTrustworthy = scoreData.totalRead && Number.isFinite(explicitTotal) && explicitTotal > 0;
    let totalPoints;
    let totalSource;
    if (effectivePoints.length) {
      totalPoints = effectiveSum;
      totalSource = scoreData.points.length ? '板块之和' : '板块之和(沿用上次板块)';
    } else if (explicitTrustworthy) {
      totalPoints = explicitTotal;
      totalSource = '页面总分';
    } else if (Number.isFinite(keptTotal)) {
      totalPoints = keptTotal;
      totalSource = '沿用上一次';
    } else {
      totalPoints = Number.isFinite(explicitTotal) ? explicitTotal : null;
      totalSource = Number.isFinite(explicitTotal) ? '页面总分(未确认)' : '无可用数据';
    }
    trace(`[积分] 板块合计=${pointsSum} 有效板块之和=${effectiveSum}(${effectivePoints.length} 个) 页面总分=${explicitTotal} 采用=${totalPoints} 来源=${totalSource} 积分页可用=${scorePageUsable} 读到总分文字=${scoreData.totalRead} 上次已知=${keptTotal}`);
    // 诊断：把首行的原始文本与拆分出的单元格打出来。
    // "整张表文字被当成活动名"就是靠对照这两者才定位到的 —— 只打 text 看不出
    // 它其实是整表，只有看到 cells 才知道正确取法。
    if (scoreData.firstRowText || scoreData.firstRowCells?.length) {
      trace(`[积分页] 首行 text=${JSON.stringify(scoreData.firstRowText.slice(0, 90))}`);
      trace(`[积分页] 首行 cells(${scoreData.firstRowCells.length})=${JSON.stringify(scoreData.firstRowCells.slice(0, 8))}`);
    }
    // 逐行打出"板块 当前/上限 活动名"，方便和站点积分页的明细表逐条对齐核对。
    // 光有"板块之和=34"看不出对不对，必须能对上每一行才行。
    if (scoreData.rows?.length) {
      trace(`[积分页] 明细共 ${scoreData.rows.length} 行（与站点表格核对用）：`);
      for (const row of scoreData.rows.slice(0, 14)) {
        trace(`[积分页]   ${row.section} ${row.current}/${row.maximum}  ${JSON.stringify(String(row.title || '').slice(0, 40))}`);
      }
      if (scoreData.rows.length > 14) trace(`[积分页]   …还有 ${scoreData.rows.length - 14} 行`);
    }
    trace(`[积分页] 取到的活动名=${JSON.stringify(scoreData.recentActivity || '')}`);
    // 表格规模核对：板块积分靠逐行累加，所以必须确认明细行全都读到了。
    // 若站点分页而这里只读到第一页，累加值会偏小却看不出异常。
    if (scoreData.tableInfo) {
      const t = scoreData.tableInfo;
      trace(`[积分页] 表格规模 解析行=${t.parsedRows} 命中行=${t.candidateRows} tbodyTr=${t.tbodyTr} elTableRow=${t.elTableRow} [class*=row]=${t.rowselectors}${t.totalText ? ' ' + t.totalText : ''}`);
      if (t.cellCounts) trace(`[积分页] 每行单元格数分布=${JSON.stringify(t.cellCounts)}`);
      if (t.pagers?.length) trace(`[积分页] 分页控件=${JSON.stringify(t.pagers)}`);
      // 命中行数 > 解析行数不代表有问题：站点把每行渲染了两遍，去重后必然更少。
      // 真正值得警觉的是**解析行数远多于命中行数**（说明有重复累加的风险）。
      if (t.parsedRows > t.candidateRows) {
        trace(`[积分页] 注意：解析出 ${t.parsedRows} 行但只命中 ${t.candidateRows} 个元素，可能存在重复累加。`);
      }
    }
    // 用站点自己的"总计"核对逐行累加的结果。
    // 这是唯一能发现"行解析多算/漏算"的办法：累加值偏大或偏小，
    // 界面上都看不出异常，只有和站点给的合计对照才能发现。
    if (Number.isFinite(scoreData.rowsTotal)) {
      const diff = scoreData.rowsTotal - pointsSum;
      trace(`[积分页] 站点明细合计=${scoreData.rowsTotal} 逐行累加=${pointsSum} 差额=${diff}${diff === 0 ? ' ✓ 一致' : ' ← 不一致，需排查'}`);
    }
    // 活动名要做一次校验后再用：脏数据会把个人卡片撑爆（实测）。
    // 优先用积分页首行取到的活动名（那才是"最近获得积分的那次活动"），
    // 它不可信时退回活动列表的首项（是干净的活动名），最后才用上一次的值。
    const candidateTitles = [
      scoreData.recentActivity,
      (profileData.recentActivities || [])[0],
      (previousProfile.recentActivities || [])[0],
      previousProfile.recentActivity
    ];
    const recentActivity = candidateTitles.find((value) => looksLikeActivityTitle(value)) || '';
    if (scoreData.recentActivity && !looksLikeActivityTitle(scoreData.recentActivity)) {
      trace(`[积分页] 活动名不可信，已丢弃：${JSON.stringify(String(scoreData.recentActivity).slice(0, 70))}`);
    }
    const mergedProfile = {
      ...previousProfile,
      ...profileData,
      name: profileData.name || previousProfile.name || '',
      meta: profileData.meta || previousProfile.meta || '',
      avatar: profileData.avatar || previousProfile.avatar || '',
      totalPoints,
      recentPoints: scoreData.recentPoints ?? profileData.recentPoints ?? previousProfile.recentPoints ?? null,
      recentActivity,
      recentActivities: profileData.recentActivities?.length ? profileData.recentActivities : (previousProfile.recentActivities || [])
    };
    const hasBaseline = lastState.backend.lastScan !== null;
    const previousIds = new Set(lastState.activities.map((item) => `${item.section}|${item.type}|${item.title}`));
    // 新扫描出来的卡片本身不含“已报名”标记，必须从上一份状态里继承回来，
    // 否则每次扫描都会把用户的报名记录清掉，活动会重新出现在待关注列表里。
    const registeredAtByTitle = new Map((lastState.activities || [])
      .filter((item) => item.registeredAt)
      .map((item) => [item.title, item.registeredAt]));
    const activitiesWithRegistration = (data.activities || []).map((item) => (
      registeredAtByTitle.has(item.title) ? { ...item, registeredAt: registeredAtByTitle.get(item.title) } : item
    ));
    // 本次积分页确实可用时才启用“板块已达标就不提醒”的过滤。见 satisfiedSections 的注释。
    const satisfied = scorePageUsable ? satisfiedSections(effectivePoints) : new Set();
    const isDone = (item) => satisfied.has(item.section);
    const needsAttention = (item) => item.points > 0 && !item.registeredAt && !isDone(item);
    const newCount = hasBaseline ? activitiesWithRegistration.filter((item) => needsAttention(item) && !previousIds.has(`${item.section}|${item.type}|${item.title}`)).length : 0;
    if (satisfied.size) {
      const list = [...satisfied].join('、');
      const skipped = activitiesWithRegistration.filter((item) => item.points > 0 && !item.registeredAt && isDone(item)).length;
      trace(`[达标] 已满分板块：${list}（因此不再提醒其中的 ${skipped} 个活动）`);
    }
    lastState = {
      backend: { status: 'online', lastScan: now(), authRequired: false, error: null, newCount, scanSuccessful: true, sectionsSatisfied: [...satisfied], codeVersion: CODE_VERSION },
      ...data,
      activities: activitiesWithRegistration,
      points: effectivePoints,
      profile: mergedProfile
    };
    persistState();
    // 走到这里说明本次确实读到了站点数据 = 登录有效。
    // 记下这个事实，并顺手把登录态快照刷新一份（站点会轮换 csrftoken）。
    // 标志必须在 saveSessionState 之前置位，否则刷新会被自己挡掉。
    authenticatedThisSession = true;
    if (scorePageUsable) {
      saveSessionState(browserContext, '巡检成功').catch(() => {});
    }
    if (newCount > 0) {
      const firstNew = activitiesWithRegistration.find((item) => needsAttention(item) && !previousIds.has(`${item.section}|${item.type}|${item.title}`));
      // 提醒窗口的“立刻报名”会回调 /api/activity/open 并附上活动标题，
      // 因此从提醒窗口报名的活动同样会被记为“已报名”。优先给它详情页地址。
      notifyWindows('未央雨课堂活动提醒', notificationMessage(firstNew), 60, firstNew.detailUrl || firstNew.url || '', firstNew.title || '').then((result) => {
        if (!result.ok) console.error(`Windows 活动通知失败：${result.error}`);
      });
    }
    return lastState;
  } catch (error) {
    if (connectedToExternalEdge) {
      await browserConnection?.close().catch(() => {});
      browserConnection = undefined;
      browserContext = undefined;
      monitorPage = undefined;
      connectedToExternalEdge = false;
    }
    // 扫描失败时保留上一次成功抓取的活动、积分和个人信息，只更新后台错误状态。
    const wasAuthRequired = lastState.backend?.authRequired === true;
    lastState = { ...lastState, backend: { ...lastState.backend, status: error.authRequired ? 'auth_required' : 'error', lastScan: lastState.backend.lastScan, authRequired: Boolean(error.authRequired), error: error.message, scanSuccessful: Boolean(lastState.backend.scanSuccessful), codeVersion: CODE_VERSION } };
    trace(`扫描失败：${error.message}`);
    // 登录失效**必须主动提醒**。
    //
    // 以前只把状态改成 auth_required 就结束了，没有任何通知 —— 于是登录态
    // 静默失效，用户只能靠自己发现界面上的积分不再更新（实测就是这个后果：
    // 会话掉了之后没人知道）。这类"需要用户动手才能恢复"的故障，
    // 一定要推到他面前。
    //
    // 只在"从正常变成失效"这一刻提醒一次：否则每 30 分钟一轮询就弹一次，
    // 很快就会被用户当成噪音无视。
    if (error.authRequired && !wasAuthRequired) {
      notifyWindows(
        '未央观察站：登录已失效',
        '监测已暂停（积分不再更新）。请双击 relogin-monitor.cmd 重新登录。',
        // 不能用 0：windows-notify.ps1 里是 [Math]::Max(1, $DurationSeconds)，
        // 传 0 会变成只显示 1 秒，等于没提醒。
        20,
        '',
        ''
      ).then((result) => {
        if (!result.ok) console.error(`Windows 登录失效通知失败：${result.error}`);
      });
    }
    return lastState;
  } finally {
    scanRunning = false;
  }
}

// 找出某个活动可用的详情页 URL。优先用扫描时缓存的 detailUrl（秒开），
// 只有缓存缺失、或缓存显示该活动已不能报名时，才回退到打开浏览器点击的慢路径。
// 这样既能秒开，又不会把用户直接送到一个报名已截止的详情页。
function cachedActivity(title) {
  const wanted = String(title || '').trim();
  if (!wanted) return null;
  const found = (lastState.activities || []).find((item) => item.title === wanted);
  if (!found) return null;
  if (found.canRegister === false) return null;
  return found;
}

function cachedDetailUrl(title) {
  const found = cachedActivity(title);
  return String(found?.detailUrl || '').trim();
}

async function resolveActivityDetailUrl(title, { store = true } = {}) {
  const context = await ensureContext(true);
  const page = monitorPage || context.pages()[0] || await context.newPage();
  monitorPage = page;
  await openActivityListFromHome(page);
  const card = page.locator('li.list-item').filter({ has: page.locator('h3.title', { hasText: title }) }).first();
  if (!(await card.count())) throw new Error('活动已从未央雨课堂活动列表中消失。');
  const canRegister = await card.evaluate((node) => {
    const text = node.textContent?.replace(/\s+/g, ' ').trim() || '';
    const m = text.match(/剩余名额\s*[：:]\s*(\d+)/);
    return !text.includes('报名结束') && (!m || Number(m[1]) > 0 || text.includes('不限制名额'));
  });
  if (!canRegister) throw new Error('该活动已不能报名。');
  // 可报名的卡片渲染的是“去报名”（a.application-btn），点击后打开
  // projectdetail 详情页；.detail-btn（“查看详情”）只出现在其他状态的卡片上，
  // 早期代码固定点 .detail-btn，在这些卡片上永远 30 秒超时并返回 409。
  const detail = card.locator('a.application-btn, .detail-btn').first();
  const clickable = (await detail.count()) > 0 ? detail : card.locator('a').first();
  if ((await clickable.count()) === 0) throw new Error('该活动卡片上没有可点击的报名入口。');
  const fallbackUrl = 'https://weiyang.yuketang.cn/pro/portal/trainclasslist';
  const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await clickable.click({ timeout: 15_000 });
  const detailPage = await popupPromise;
  if (detailPage) await detailPage.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  await (detailPage || page).waitForTimeout(600);
  const resolvedUrl = (detailPage || page).url();
  const url = /projectdetail|trainclassdetail/i.test(resolvedUrl) ? resolvedUrl : (resolvedUrl || fallbackUrl);
  // 详情页是点击后新开的弹窗页。用完即关，避免无头浏览器里不断堆积标签页
  // （堆积会拖慢并最终压垮监测器 Edge，导致后续点击报 ECONNREFUSED）。
  if (detailPage && detailPage !== page) {
    await detailPage.close().catch(() => {});
  }
  // 把解析结果补进当前状态，同一活动的下一次点击就能走秒开路径。
  if (store) {
    const found = (lastState.activities || []).find((item) => item.title === title);
    if (found && /projectdetail|trainclassdetail/i.test(url)) {
      found.detailUrl = url;
      found.url = url;
      try { fs.writeFileSync(STATE_PATH, JSON.stringify(lastState, null, 2), 'utf8'); } catch { }
    }
  }
  return url;
}

// 打开活动报名详情页：直接从缓存 URL 打开，避免每次点击都跑一次浏览器导航。
async function openActivity(title) {
  const cached = cachedDetailUrl(title);
  if (cached) {
    const launched = await openInUserBrowser(cached);
    if (launched) return { url: cached, title, launchedExternally: true, source: 'cache', ms: 0 };
  }
  const startedAt = Date.now();
  const url = await resolveActivityDetailUrl(title);
  // 必须显式在用户自己的浏览器中打开：监测器专用的 Edge 是无头实例，
  // 在里面打开的页面用户看不到，这正是“去报名”点了没反应的原因之一。
  const launched = await openInUserBrowser(url);
  return { url, title, launchedExternally: launched, source: 'live', ms: Date.now() - startedAt };
}

async function testWindowsNotification() {
  if (notificationTestRunning) throw new Error('已有测试提醒正在处理，请稍后再试。');
  notificationTestRunning = true;
  try {
    while (scanRunning) await new Promise((resolve) => setTimeout(resolve, 100));
    return await createWindowsNotificationTest();
  } finally {
    notificationTestRunning = false;
  }
}

async function createWindowsNotificationTest() {
  // 测试必须实时读取活动报名页，不能使用缓存或预先写好的占位内容。
  let activity;
  try {
    const context = await ensureContext(true);
    const page = monitorPage || context.pages()[0] || await context.newPage();
    monitorPage = page;
    await openActivityListFromHome(page);
    const card = page.locator('li.list-item').first();
    if (!(await card.count())) throw new Error('未央雨课堂活动报名页没有活动卡片。');
    activity = await card.evaluate((card) => ({
      title: card.querySelector('h3.title')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      url: card.querySelector('.detail-btn')?.href || 'https://weiyang.yuketang.cn/pro/portal/trainclasslist',
      section: card.querySelectorAll('.tag-item')[0]?.textContent?.replace(/\s+/g, ' ').trim() || '',
      type: card.querySelectorAll('.tag-item')[1]?.textContent?.replace(/\s+/g, ' ').trim() || '',
      points: Number((card.textContent?.match(/(\d+(?:\.\d+)?)\s*个?积分/) || [])[1]),
      description: card.querySelector('.intro')?.textContent?.replace(/\s+/g, ' ').trim() || ''
    }));
    if (!activity.title) throw new Error('活动报名页未返回活动名称。');
  } catch (error) {
    throw new Error(`无法从未央雨课堂活动报名页实时抓取：${error.message}`);
  }
  const notification = await notifyWindows('未央雨课堂活动提醒测试', notificationMessage(activity), 60, activity.url || '', activity.title || '');
  if (!notification.ok) throw new Error(`活动已抓取，但 Windows 通知窗口启动失败：${notification.error}`);
  return activity;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

// 读取 POST 请求体（上限 64KB，足够放一个活动标题）。Windows 提醒窗口用
// Invoke-RestMethod 发 JSON，仪表盘用查询参数，两种都要支持。
// 必须按字节收集再统一 UTF-8 解码：中文标题是多字节的，若按 chunk.toString()
// 逐块拼接，多字节字符一旦跨块就会被拆坏，JSON 随之解析失败。
function readRequestBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65_536) { resolve(''); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(''));
  });
}

// Lightweight access log for the two user-triggered endpoints. This is what
// makes "I clicked and nothing happened" diagnosable after the fact: the log
// shows whether the click reached the backend at all, and what it answered.
function logAccess(kind, detail) {
  try {
    const line = `[${new Date().toISOString()}] ${kind} ${detail}\n`;
    fs.appendFileSync(path.join(ROOT, 'logs', 'access.log'), line, 'utf8');
  } catch { }
}

function serveStatic(response, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(ROOT, `.${safePath}`);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendJson(response, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  // no-store：页面脚本每次刷新都取最新版本。否则浏览器会启发式缓存 app.js，
  // 修复过的前端逻辑要等到缓存过期才生效（表现为“改了代码但按钮还是老行为”）。
  response.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store, must-revalidate' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/api/state') return sendJson(response, 200, lastState);
  if (url.pathname === '/api/scan' && request.method === 'POST') return sendJson(response, 200, await scan());
  if (url.pathname === '/api/activity/open' && request.method === 'POST') {
    // 标题可以来自查询参数（仪表盘用这种），也可以来自 JSON 请求体
    // （Windows 提醒窗口的“立刻报名”用这种，PowerShell 用 Invoke-RestMethod 发 JSON）。
    // 注意：不能用 decodeURIComponent 去解查询参数——new URL() 已经解码过一次，
    // 再解一次会把标题里的“%”等内容弄坏；下面只在兜底分支里解一次。
    const encodedTitle = url.searchParams.get('title') || '';
    let requestedTitle = encodedTitle;
    if (!requestedTitle) {
      try {
        const raw = await readRequestBody(request);
        if (raw) requestedTitle = String(JSON.parse(raw).title || '').trim();
      } catch { /* 请求体为空或不是合法 JSON：按缺少标题处理 */ }
    }
    const startedAt = Date.now();
    try {
      const result = await openActivity(requestedTitle);
      // 只要用户点过“去报名”（仪表盘或提醒窗口），就记为已报名：
      // 之后它不再出现在“值得关注的活动”和“待关注活动”计数里。
      // 必须在 openActivity 成功之后才记录，避免打开失败也把它算作已报名。
      const registered = markActivityRegistered(requestedTitle);
      // 记录是否真的把页面交给了用户的默认浏览器（externally=true 表示后台已代为打开，
      // 前端不应再自行 window.open，否则会被拦截并误报“无法打开报名页面”）。
      logAccess('activity-open', `ok ${Date.now() - startedAt}ms externally=${result.launchedExternally} source=${result.source || '?'} registered=${registered} url=${result.url} title="${requestedTitle}"`);
      return sendJson(response, 200, { ...result, registered });
    } catch (error) {
      logAccess('activity-open', `error ${Date.now() - startedAt}ms title="${requestedTitle || encodedTitle}" error=${String(error.message).replace(/\s+/g, ' ')}`);
      return sendJson(response, 409, { error: error.message });
    }
  }
  if (url.pathname === '/api/test-notification' && request.method === 'POST') {
    try { return sendJson(response, 200, await testWindowsNotification()); }
    catch (error) { return sendJson(response, 409, { error: error.message }); }
  }
  serveStatic(response, url.pathname);
});

async function shutdown() {
  if (connectedToExternalEdge && browserConnection) browserConnection.close().catch(() => {});
  else if (browserContext) await browserContext.close().catch(() => {});
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (process.argv.includes('--login')) {
  loginFlow().catch((error) => { console.error(error.message); process.exitCode = 1; });
} else {
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`监测后台已经在 http://127.0.0.1:${PORT} 运行，本次不重复启动。`);
      process.exit(0);
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(PORT, '127.0.0.1', () => {
    // 启动时把“本次加载的是哪份代码”写进自己控制的日志与 /api/state。
    // stdout 是否进文件取决于启动方式（npm start 只进控制台窗口），所以既落盘
    // 到 logs\scan.log，也通过 backend.codeVersion 暴露出来。
    trace(`未央观察站后台已启动：http://127.0.0.1:${PORT}`);
    trace(`[启动] 已加载代码：${__filename}`);
    trace(`[启动] 代码指纹：${CODE_VERSION}`);
    trace(`[启动] PID=${process.pid} 积分页抓取=多策略 接口兜底=extractScoreFromJson 日志=logs/scan.log`);
  });
  scan();
  scan();
  setInterval(scan, Math.max(1, config.pollMinutes) * 60 * 1000);
}
