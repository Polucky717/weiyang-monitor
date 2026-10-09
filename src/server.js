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
  // 积分优先取简介里的“N积分 / N个单位活动积分”；简介没写时再看详情页
  // （详情页课程条目会显示“2学时 2积分”，例如 Agent 入门精讲）。
  const pointsPattern = /(\d+(?:\.\d+)?)\s*(?:个\s*)?(?:单位\s*)?(?:活动\s*)?积分/;
  const descPoints = description.match(pointsPattern);
  const detailPoints = descPoints ? null : (String(detailText || '').match(pointsPattern) || null);
  const pointsMatch = descPoints || detailPoints;
  return {
    id: `train-${index}-${title}`,
    url: detailUrl || 'https://weiyang.yuketang.cn/pro/portal/trainclasslist',
    detailUrl,
    title,
    description,
    // 页面分类标签偶尔不渲染；接口的 tags 是同一套板块名，可直接用。
    // 多标签活动（如“先进制造 + 微沙龙讲座”）优先取五大积分板块。
    section: resolveSection(tagList, firstTag, activityForm),
    type: firstTag || activityForm || '',
    points: pointsMatch ? Number(pointsMatch[1]) : null,
    meta: [clean(signUp.class_time), clean(signUp.sign_up_time)].filter(Boolean).join(' · '),
    status: statusLabel || (Number(signUp.status) === SIGNUP_OPEN_STATUS ? '立即报名' : ''),
    canRegister: Number(signUp.status) === SIGNUP_OPEN_STATUS
  };
}

// 有的活动把积分只写在详情页上（简介完全没提）。这类活动同样值得提醒，
// 因此只为“开放报名、但简介里没有积分”的记录补开一次详情页，读它的可见文本。
// 只对开放报名的活动做这件事，数量很少（通常个位数），不会拖慢扫描。
async function fillPointsFromDetailPages(page, records) {
  const targets = records.filter((record) => {
    const sign = String(record.sign || '').trim();
    if (!sign) return false;
    if (Number(record?.sign_up?.status) !== SIGNUP_OPEN_STATUS) return false;
    const description = String(record.description || '');
    return !/(\d+(?:\.\d+)?)\s*(?:个\s*)?(?:单位\s*)?(?:活动\s*)?积分/.test(description);
  });
  const filled = new Map();
  for (const record of targets) {
    const url = `https://weiyang.yuketang.cn/pro/portal/projectdetail/${String(record.sign).trim()}/`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.body.innerText || '');
      filled.set(String(record.train_class_id || record.sign), text);
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
  // 简介里没写积分的“开放报名”活动，逐个补开详情页把积分读出来。
  const detailTexts = await fillPointsFromDetailPages(page, apiActivities).catch(() => new Map());
  // 接口侧的统一结构：它是全量活动的权威来源，能覆盖页面第一页之外的其余活动
  // （页面只渲染 10 张卡片，接口里有 200 多条）。
  const apiBuilt = apiActivities.map((record, index) => activityFromApiRecord(
    record,
    index,
    detailTexts.get(String(record.train_class_id || record.sign)) || ''
  )).filter((item) => item.title);
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
  const activities = [...merged.values()].map(({ index, ...rest }) => rest);

  const sections = await page.$$eval('.filter-item-option', (nodes) => [...new Set(nodes
    .filter((node) => node.closest('.filter-item')?.querySelector('.title')?.textContent?.includes('分类标签'))
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter((text) => text && text !== '全部'))]).catch(() => []);
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

async function extractScoreProgress(page) {
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    let currentSection = '';
    const rows = [...document.querySelectorAll('.my-score .el-table__body-wrapper tbody tr')].map((row) => {
      const sectionCell = row.querySelector('td.el-table_1_column_2:not(.is-hidden)');
      if (sectionCell) currentSection = clean(sectionCell.textContent);
      const activityCell = row.querySelector('td.el-table_1_column_3:not(.is-hidden)');
      const scoreCell = row.querySelector('td.el-table_1_column_7:not(.is-hidden)');
      const activity = clean(activityCell?.textContent);
      const scoreText = clean(scoreCell?.textContent);
      const score = scoreText.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
      return { section: currentSection, activity, current: score ? Number(score[1]) : null, maximum: score ? Number(score[2]) : null };
    }).filter((row) => row.section && Number.isFinite(row.current));
    const summary = clean(document.querySelector('.my-score .shadow-box')?.textContent);
    const totalMatch = summary.match(/获得\s*(\d+(?:\.\d+)?)\s*积分/);
    // 摘要区域的选择器可能随页面版本变化，取不到时退回到整页文本里找
    // “获得 N 积分 / 累计 N 积分 / 共 N 积分”。仍然取不到就交给调用方用
    // 各板块之和作为累计积分。
    const pageText = clean(document.body?.innerText || '').slice(0, 4000);
    const fallbackMatch = totalMatch
      || pageText.match(/(?:获得|累计|共)\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*积分/);
    // scraped 表示“积分页确实渲染出来了”。登录态失效时页面会被跳回主页，
    // 此时既没有表格也没有摘要，必须与“页面在但确实 0 分”区分开，
    // 否则会把 0 当成真实分数覆盖掉已知的累计积分。
    const scraped = Boolean(document.querySelector('.my-score'))
      || Boolean(document.querySelector('.el-table__body-wrapper'))
      || Boolean(totalMatch);
    return { rows, totalPoints: fallbackMatch ? Number(fallbackMatch[1]) : null, scraped };
  }).catch(() => ({ rows: [], totalPoints: null, scraped: false }));
  const grouped = new Map();
  for (const row of result.rows) {
    const current = grouped.get(row.section) || { section: row.section, current: 0, target: thresholdFor(row.section), tone: toneFor(row.section) };
    current.current += row.current;
    grouped.set(row.section, current);
  }
  return {
    points: [...grouped.values()],
    rows: result.rows,
    totalPoints: Number.isFinite(result.totalPoints) ? result.totalPoints : null,
    scraped: Boolean(result.scraped),
    recentPoints: result.rows.length ? result.rows[0].current : null,
    recentActivity: result.rows[0]?.activity || ''
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
    await page.goto(SCORE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1200);
    const scoreData = await extractScoreProgress(page);
    // 积分页偶尔会被登录跳转拦回主页，导致拿不到板块数据。记录真实落点与行数，
    // 便于对照日志判断“累计积分为 0”是页面没抓到，还是本来就真的没有积分。
    console.log(`[积分页] 落点=${page.url()} 板块数=${scoreData.points.length} 页面总分=${scoreData.totalPoints} 明细行=${scoreData.rows?.length ?? '-'}`);
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
    const pointsSum = scoreData.points.reduce((sum, item) => sum + (Number.isFinite(item.current) ? item.current : 0), 0);
    const explicitTotal = scoreData.totalPoints ?? profileData.totalPoints ?? null;
    // 登录态失效时积分页会被跳回主页：抓不到任何板块，页面总分也读成 0。
    // 这种“页面没抓到东西”的情况下必须沿用上一次已知的分数，不能把 0 当真写下去，
    // 否则只要会话过期一次，累计积分就会从 14 掉成 0。
    const scorePageUsable = scoreData.points.length > 0 || scoreData.scraped === true;
    const totalPoints = scoreData.points.length
      ? pointsSum
      : (scorePageUsable && Number.isFinite(explicitTotal)
        ? explicitTotal
        : (previousProfile.totalPoints ?? (Number.isFinite(explicitTotal) ? explicitTotal : null)));
    console.log(`[积分] 板块合计=${pointsSum} 页面总分=${explicitTotal} 采用=${totalPoints}（${scoreData.points.length} 个板块，积分页可用=${scorePageUsable}）`);
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
    const mergedPoints = scoreData.points.length ? scoreData.points : (lastState.points || []);
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
    const newCount = hasBaseline ? activitiesWithRegistration.filter((item) => item.points > 0 && !item.registeredAt && !previousIds.has(`${item.section}|${item.type}|${item.title}`)).length : 0;
    lastState = { backend: { status: 'online', lastScan: now(), authRequired: false, error: null, newCount, scanSuccessful: true }, ...data, activities: activitiesWithRegistration, points: mergedPoints, profile: mergedProfile };
    persistState();
    if (newCount > 0) {
      const firstNew = activitiesWithRegistration.find((item) => item.points > 0 && !item.registeredAt && !previousIds.has(`${item.section}|${item.type}|${item.title}`));
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
