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
let scanRunning = false;
let notificationTestRunning = false;
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
  if (!headless && process.platform === 'win32') {
    const edgeCandidates = [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean);
    const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
    if (edgePath) launchAttempts.push({ ...commonOptions, executablePath: edgePath });
    launchAttempts.push({ ...commonOptions, channel: 'msedge' });
  }
  launchAttempts.push({ ...commonOptions });

  let lastLaunchError;
  for (let profileAttempt = 0; profileAttempt < 2 && !browserContext; profileAttempt += 1) {
    for (const options of launchAttempts) {
      try {
        browserContext = await chromium.launchPersistentContext(profileDir, options);
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
  return browserContext;
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
  await context.close();
  browserContext = undefined;
  console.log(`会话已保存到 ${profileDir}`);
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
    apiCalls.push({ url, status: response.status() });
    // 立刻把 JSON 正文留下：页面随后可能被导航走，response 就取不到了。
    response.json().then((payload) => {
      const item = apiCalls[apiCalls.length - 1];
      if (item && item.url === url) item.payload = payload;
    }).catch(() => {});
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
  return { apiCalls, attempts: tried.join(' ') };
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
    for (const tr of document.querySelectorAll('tbody tr, .el-table__row, [class*=row]')) {
      const text = clean(tr.textContent);
      if (!text || !/\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/.test(text)) continue;
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
      rows.push({ section, current: Number(match[1]), maximum: Number(match[2]), text: text.slice(0, 80) });
    }
    const pageText = clean(document.body && document.body.innerText || '').slice(0, 6000);
    const totalMatch = pageText.match(/(?:获得|累计|共)\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*积分/);
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

  if (result.evaluateError) console.log(`[积分页-诊断] 页面脚本执行失败：${result.evaluateError}`);

  const grouped = new Map();
  for (const row of result.rows || []) {
    const current = grouped.get(row.section) || { section: row.section, current: 0, target: thresholdFor(row.section), tone: toneFor(row.section) };
    current.current += row.current;
    grouped.set(row.section, current);
  }
  return {
    points: [...grouped.values()],
    rows: result.rows || [],
    totalPoints: Number.isFinite(result.totalPoints) ? result.totalPoints : null,
    totalRead: Boolean(result.totalRead),
    scraped: Boolean(result.scraped),
    diagnostics: result.diagnostics || null,
    recentPoints: (result.rows || []).length ? result.rows[0].current : null,
    recentActivity: (result.rows || [])[0]?.text || ''
  };
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
        console.log(`[积分页] 改从接口取到 ${fromApi.length} 个板块：${call.url.slice(0, 120)}`);
        break;
      }
    }
    // 记录真实落点、行数与各策略结果，便于对照日志判断失败原因。
    console.log(`[积分页] 落点=${page.url()} 板块数=${scoreData.points.length} 页面总分=${scoreData.totalPoints} 明细行=${scoreData.rows?.length ?? '-'} 策略[${scoreNav.attempts}] 接口候选=${scoreNav.apiCalls.length}`);
    const diag = scoreData.diagnostics;
    if (scoreData.points.length === 0) {
      console.log(`[积分页-诊断] 根容器=${diag?.hasMyScore} 表格容器=${diag?.hasTable} 原始行数=${diag?.rawRowCount} 标题=${JSON.stringify(diag?.title)} 表头=[${(diag?.headings || []).join(' | ')}]`);
      console.log(`[积分页-诊断] 页面开头=${JSON.stringify((diag?.textStart || '').slice(0, 120))}`);
      for (const call of scoreNav.apiCalls.slice(0, 12)) {
        console.log(`[积分页-诊断] 接口 ${call.status} ${call.url.slice(0, 130)}${call.payload ? ' 已有JSON' : ''}`);
      }
    }
    await openActivityListFromHome(page);
    const loginRequired = /login|signin|passport/i.test(page.url());
    if (loginRequired) throw Object.assign(new Error('登录态已失效，请运行 npm run login 重新登录。'), { authRequired: true });
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
    console.log(`[积分] 板块合计=${pointsSum} 有效板块之和=${effectiveSum}(${effectivePoints.length} 个) 页面总分=${explicitTotal} 采用=${totalPoints} 来源=${totalSource} 积分页可用=${scorePageUsable} 读到总分文字=${scoreData.totalRead} 上次已知=${keptTotal}`);
    const mergedProfile = {
      ...previousProfile,
      ...profileData,
      name: profileData.name || previousProfile.name || '',
      meta: profileData.meta || previousProfile.meta || '',
      avatar: profileData.avatar || previousProfile.avatar || '',
      totalPoints,
      recentPoints: scoreData.recentPoints ?? profileData.recentPoints ?? previousProfile.recentPoints ?? null,
      recentActivity: scoreData.recentActivity || profileData.recentActivity || previousProfile.recentActivity || '',
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
      console.log(`[达标] 已满分板块：${list}（因此不再提醒其中的 ${skipped} 个活动）`);
    }
    lastState = {
      backend: { status: 'online', lastScan: now(), authRequired: false, error: null, newCount, scanSuccessful: true, sectionsSatisfied: [...satisfied] },
      ...data,
      activities: activitiesWithRegistration,
      points: effectivePoints,
      profile: mergedProfile
    };
    persistState();
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
    lastState = { ...lastState, backend: { ...lastState.backend, status: error.authRequired ? 'auth_required' : 'error', lastScan: lastState.backend.lastScan, authRequired: Boolean(error.authRequired), error: error.message, scanSuccessful: Boolean(lastState.backend.scanSuccessful) } };
    console.error(`[${now()}] 扫描失败：${error.message}`);
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
  server.listen(PORT, '127.0.0.1', () => console.log(`未央观察站后台已启动：http://127.0.0.1:${PORT}`));
  scan();
  setInterval(scan, Math.max(1, config.pollMinutes) * 60 * 1000);
}
