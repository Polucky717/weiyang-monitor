const activities = [];
const points = [];
const availableSections = [];

const profile = {
  name: '', meta: '', avatar: '', totalPoints: null, recentPoints: null, recentActivity: ''
};

let currentFilter = '全部板块';
let monitorPaused = false;
let scanCount = 0;
let scanTimer;
let remoteConnected = false;
let lastNewCount = 0;
let backendState = '未连接';
let dataReady = false;
let stateSyncTimer;
const $ = (selector) => document.querySelector(selector);

// 左侧图标按板块区分，方便一眼认出活动属于哪一类。
// 图标是自绘简笔线稿（不用 emoji：emoji 是彩色位图风格，和侧边栏那套
// 细线图标不统一，且在字号偏小时容易糊成一团）。画法沿用侧边栏图标的约定：
// 24 视窗、fill:none、stroke 取 currentColor，颜色由 .activity-icon 的 tone 决定。
// 板块名以服务端返回为准（实测为：先进制造、能源电力、微沙龙讲座、资源环境、
// 多彩未央、信息工业、比赛培训），未收录的板块回退到通用图标。
const SECTION_ICONS = {
  // 先进制造：齿轮（8 齿 + 轮心）。试过机械臂和“厂房+齿轮”，前者缩小后
  // 关节糊成一团、后者笔画重叠显脏，单独的齿轮最干净也最好认。
  先进制造: '<circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.7"/>'
    + '<path d="M12 3.2v3.6M12 17.2v3.6M3.2 12h3.6M17.2 12h3.6'
    + 'M5.8 5.8l2.5 2.5M15.7 15.7l2.5 2.5M18.2 5.8l-2.5 2.5M8.3 15.7l-2.5 2.5"/>',
  // 电脑：显示器 + 支架
  信息工业: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6"/><path d="M12 17v4"/>',
  // 花草：枝干 + 左右叶片
  资源环境: '<path d="M12 21v-8"/><path d="M12 13C12 9 9.5 6.5 5.5 6.2 5.2 10.2 7.8 12.8 12 13Z"/>'
    + '<path d="M12 15c0-3.4 2.2-5.6 5.8-5.9.3 3.6-2 6-5.8 5.9Z"/>',
  // 火焰：外焰 + 内焰
  能源电力: '<path d="M12 3c3.2 4 5.6 6.6 5.6 10.2A5.6 5.6 0 0 1 12 21a5.6 5.6 0 0 1-5.6-7.8C6.4 9.6 8.8 7 12 3Z"/>'
    + '<path d="M12 12.4c1.2 1.6 1.8 2.6 1.8 3.8a1.8 1.8 0 1 1-3.6 0c0-1.2.6-2.2 1.8-3.8Z"/>',
  // 绵羊：这是【位图羊出错时】的矢量兜底（正常看不到）。
  // 既然用户选定了位图，这里就不再精修，直接用 30 单位那套坐标。
  多彩未央: '<path d="M10 26Q10.9 28.2 12.5 26.2Q14 28.2 15.6 26.2Q17.1 28.2 18.6 26.2'
    + 'Q20.1 28.2 21.6 26.2Q23.6 27.6 24.2 24.6Q26 23.2 24.4 21Q25.8 18.6 23.2 17'
    + 'Q23.8 14 20.6 13.2Q19.8 10.6 16.6 11.4Q14.6 9.8 11.8 11.8Q9 11.4 8.2 14.2'
    + 'Q5.6 15.4 7.4 18Q6 20.2 7.8 22Q6.6 24.4 8.4 26.2"/>'
    + '<path d="M3.4 15.6Q-.4 14 -1.4 16.8Q-.4 19.2 3.2 18.6Z" fill="#fff"/>'
    + '<path d="M13.2 15.6Q16.8 14 17.8 16.6Q17 19.4 13.4 18.8Z" fill="#fff"/>'
    + '<ellipse cx="8.4" cy="19.4" rx="5.6" ry="6.6" fill="#fff"/>'
    + '<path d="M3.2 10.6A2.8 2.8 0 0 1 1.2 6.2A3.2 3.2 0 0 1 5.4 3.6'
    + 'A3.3 3.3 0 0 1 11.4 4.2A3.1 3.1 0 0 1 14.4 7.2A2.9 2.9 0 0 1 13 10.4Z" fill="#fff"/>'
    + '<circle cx="6.8" cy="17.9" r=".65" fill="currentColor" stroke="none"/>'
    + '<circle cx="11.2" cy="17.9" r=".65" fill="currentColor" stroke="none"/>'
    + '<path d="M7.6 21.5q1.2 1.3 2.4 0"/>'
    + '<circle cx="25.6" cy="22.8" r="1.5"/>'
    + '<path stroke-width="1.1" d="M12.6 26.2v3M15.6 26.2v3M19.6 26.2v3M22 26.2v3"/>',
  // 演讲台：斜面台面 + 支柱 + 底座（首版把话筒画在台面正中，缩小后像“天线盒子”）
  微沙龙讲座: '<path d="M7 10.4h10l-1.4 3.6H8.4Z"/><path d="M12 10.4V7.8"/>'
    + '<circle cx="12" cy="6" r="1.6"/><path d="M10 14v5"/><path d="M14 14v5"/><path d="M7.6 19h8.8"/>',
  // 棋子：圆头 + 束颈 + 喇叭形底座（关键是底座比头部宽，否则读起来像奖杯）
  比赛培训: '<circle cx="12" cy="5.6" r="2.4"/><path d="M10.6 11.6c0-1.7 2.8-1.7 2.8 0"/>'
    + '<path d="M10.6 11.6 9.4 15h5.2l-1.2-3.4Z"/><path d="M7.4 18.6h9.2L15.4 15H8.6Z"/>'
};

// 未收录板块的兜底图标（图钉）
const DEFAULT_ICON = '<path d="M12 21v-6"/><path d="M8.4 3h7.2l-1 6 2.2 2.4H7.2L9.4 9Z"/>';

// 除绵羊外的板块图标共用这一个外壳：24 视窗，描边样式在 CSS 里统一给。
function iconSvg(paths) {
  return `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${paths}</svg>`;
}

// 绵羊是在 30x30 画布上画的（部位多、坐标需要余量），等比缩到 24 视窗（0.8 倍）
// 并平移 -3 居中。描边宽度写在 CSS 上，会被 scale(0.8) 一并缩小，
// 所以按 1/0.8 反向补偿（1.5 / 0.8 = 1.875）。
// 这只是【位图出错时的兜底】，正常显示的是用户提供的位图，见 sheepIconMarkup()。
function sheepFallbackSvg(paths) {
  return '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">'
    + '<g transform="translate(-3 -3) scale(0.8)" stroke-width="1.875">' + paths + '</g></svg>';
}

// 有些板块的图标改用用户提供的蓝色线稿位图（不是矢量画的）：
// 多彩未央 = 绵羊，微沙龙讲座 = 演讲台。
// 位图由 build-icon-assets.js 预处理（裁白边 + 白底转透明 + 缩到 128px）
// 并内嵌在 icon-assets.js 里，所以不发网络请求、也不怕文件路径变。
// 着色：index.html 的 #sheepTint 滤镜把图里的蓝映射成图标配色。
const BITMAP_ICON_KEYS = { 多彩未央: 'sheep', 微沙龙讲座: 'lectern' };
const bitmapIconCache = {};

function bitmapIconMarkup(section) {
  const key = BITMAP_ICON_KEYS[section];
  const url = (window.__ICON_ASSETS || {})[key];
  // 位图没有（脚本没加载出来）就退回矢量图标，至少不会显示成破图
  if (!url) return sheepFallbackSvg(SECTION_ICONS[section]);
  if (!bitmapIconCache[key]) {
    // onerror：万一位图解码失败，就地换成矢量版。
    // 兜底那段 SVG 要嵌进内联属性里，所以外层用【单引号】包住——
    // 用双引号会被 SVG 自己的双引号提前截断，导致属性断在中间、
    // 剩下的字符变成文字节点漏在图标框里（已经踩过一次）。
    const fallback = sheepFallbackSvg(SECTION_ICONS[section]);
    bitmapIconCache[key] = '<img class="tinted-icon" src="' + url + '" alt="" aria-hidden="true"'
      + " onerror='this.outerHTML=" + JSON.stringify(fallback) + "'>";
  }
  return bitmapIconCache[key];
}

// 板块的规范显示顺序。服务端返回的板块顺序会随数据变化，
// 这里固定下来，让筛选下拉和积分列表的顺序始终一致、可预期。
const SECTION_ORDER = ['先进制造', '能源电力', '资源环境', '信息工业', '多彩未央', '微沙龙讲座', '比赛培训'];

function orderIndex(section) {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? SECTION_ORDER.length : index;
}

function sortSections(list) {
  return [...list].sort((a, b) => (orderIndex(a) - orderIndex(b)) || a.localeCompare(b, 'zh-Hans-CN'));
}

function iconFor(activity) {
  const section = activity?.section;
  // 绵羊、演讲台用位图；其余板块都是 24 视窗的矢量图标。
  if (BITMAP_ICON_KEYS[section]) return bitmapIconMarkup(section);
  return iconSvg(SECTION_ICONS[section] || DEFAULT_ICON);
}

function applyRemoteState(state) {
  if (!state || !Array.isArray(state.activities) || !Array.isArray(state.points)) {
    remoteConnected = false;
    return false;
  }
  activities.splice(0, activities.length, ...state.activities);
  points.splice(0, points.length, ...state.points);
  availableSections.splice(0, availableSections.length, ...sortSections(Array.isArray(state.sections) ? state.sections : []));
  if (state.profile) Object.assign(profile, state.profile);
  remoteConnected = state.backend?.status === 'online';
  backendState = state.backend?.status || 'unknown';
  lastNewCount = Number(state.backend?.newCount || 0);
  // 启动扫描尚未完成或临时失败时，也要显示磁盘缓存/上一次成功结果。
  dataReady = remoteConnected || Boolean(
    state.backend?.scanSuccessful || state.profile?.name || state.points.length || state.activities.length
  );
  renderPoints();
  renderActivities();
  renderProfile();
  return true;
}

async function syncRemoteState() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`后台返回 ${response.status}`);
    return applyRemoteState(await response.json());
  } catch (error) {
    remoteConnected = false;
    return false;
  }
}

async function requestRemoteScan() {
  try {
    const response = await fetch('/api/scan', { method: 'POST', cache: 'no-store' });
    if (!response.ok) throw new Error(`后台返回 ${response.status}`);
    return applyRemoteState(await response.json());
  } catch (error) {
    return false;
  }
}

// “正在报名中的活动”列表的筛选规则只有一个：是否开放报名。
// 不再按板块积分是否达标过滤 —— 只要还能报名就展示（用户可能有其他考虑而想报名）。
function qualifies(activity) {
  return Boolean(activity?.canRegister);
}

function renderActivities() {
  const list = $('#activityList');
  renderFilterMenu();
  // 列表只按“是否开放报名”筛选，不看是否点过“去报名”：
  // 只要还在报名期就完整展示，方便随时回去查看或再次进入报名页。
  const visible = activities.filter((activity) => qualifies(activity) && (currentFilter === '全部板块' || activity.section === currentFilter));
  // “待关注活动”计数是另一套口径：只统计还没报名的，报名过的活动不再重复提醒
  // （性能上这也是对账用的数字，与列表长度可以不同，两者是刻意分开的）。
  const pending = visible.filter((activity) => !activity.registeredAt);
  list.innerHTML = visible.map((activity) => `
    <article class="activity-row${activity.registeredAt ? ' registered' : ''}">
      <div class="activity-icon ${activity.tone}">${iconFor(activity)}</div>
      <div class="activity-main"><strong>${activity.title}</strong><p>${activity.description || ''}</p></div>
      <div class="activity-tags"><span class="section-tag ${activity.tone === 'orange' ? 'orange' : activity.tone === 'pink' ? 'pink' : ''}">${activity.section}</span><div class="points-pill">${activity.points == null ? '—' : `+${activity.points}`}<small>${activity.points == null ? '' : '分'}</small></div></div>
      <button class="register-button" data-id="${activity.id}">去报名 <span>↗</span></button>
    </article>`).join('');
  $('#emptyState').classList.toggle('hidden', visible.length > 0);
  // 登录或后台尚未连接时不显示会造成误解的底部说明行。
  $('#emptyHint').classList.toggle('hidden', !remoteConnected || backendState === 'auth_required');
  // 页面始终只呈现当前可报名的活动，不再提供会误导用户的“全部活动”入口。
  $('#allActivitiesButton').classList.add('hidden');
  $('#attentionCount').textContent = dataReady ? pending.length : '—';
  const available = visible.reduce((sum, item) => sum + (Number.isFinite(item.points) ? item.points : 0), 0);
  $('#availablePoints').innerHTML = dataReady ? `${available}<span class="unit">分</span>` : `—<span class="unit">分</span>`;
  $('#activitySourceCount').textContent = dataReady ? `来自 ${visible.length} 个活动` : '等待主页数据';
  $('#newActivityCount').textContent = dataReady ? (lastNewCount ? `↑ ${lastNewCount} 个新活动` : '暂无新活动') : '尚未扫描';
  // 注意：活动 id 是字符串（例如 train-0-活动名），绝不能转成数字。
  // 之前写成 Number(button.dataset.id) 会得到 NaN，openRegistration 里
  // activities.find 永远找不到，函数在第一行就 return —— 表现为点击“去报名”
  // 完全没反应，且不会向后端发出任何请求。
  list.querySelectorAll('.register-button').forEach((button) => button.addEventListener('click', () => openRegistration(button.dataset.id)));
}

function renderFilterMenu() {
  const menu = $('#filterMenu');
  const sections = sortSections([...new Set([...availableSections, ...activities.map((activity) => activity.section).filter(Boolean)])]);
  if (currentFilter !== '全部板块' && !sections.includes(currentFilter)) currentFilter = '全部板块';
  menu.innerHTML = ['全部板块', ...sections].map((section) => `<button data-filter="${section}">${section}</button>`).join('');
}

function renderPoints() {
  $('#pointsList').innerHTML = points.length ? points.map((item) => {
    const percent = Math.min(100, Math.round((item.current / item.target) * 100));
    return `<div class="point-item ${item.tone}"><div class="point-header"><span>${item.section}</span><span><b>${item.current}</b> / ${item.target} 分</span></div><div class="progress-track"><i style="width:${percent}%"></i></div></div>`;
  }).join('') : '<div class="points-empty">等待从未央雨课堂个人主页抓取积分进度</div>';
}

function renderProfile() {
  $('#profileName').textContent = profile.name || '等待主页抓取';
  $('#profileMeta').textContent = profile.meta || '个人信息暂不可用';
  $('#profileAvatar').innerHTML = profile.avatar
    ? `<img src="${profile.avatar}" alt="${profile.name || '个人头像'}" />`
    : '·';
  $('#profileTotalPoints').textContent = profile.totalPoints == null ? '—' : profile.totalPoints;
  $('#profileRecentPoints').textContent = profile.recentPoints == null ? '—' : `+${profile.recentPoints}`;
  $('#profileRecentActivity').textContent = profile.recentActivity || '暂无已抓取记录';
  $('#dashboardTotalPoints').innerHTML = profile.totalPoints == null ? '—<span class="unit">分</span>' : `${profile.totalPoints}<span class="unit">分</span>`;
  $('#monitorStatusValue').textContent = remoteConnected ? '在线' : (dataReady ? '缓存' : '等待');
  $('#monitorStatusDetail').textContent = remoteConnected ? '已同步个人主页' : (backendState === 'auth_required' ? '需要重新登录' : (dataReady ? '显示最近一次抓取结果' : '尚未连接本地后台'));
}

function openRegistration(id) {
  const activity = activities.find((item) => item.id === id);
  if (!activity) return;
  $('#modalTitle').textContent = activity.title;
  $('#modalDesc').textContent = activity.description;
  $('#modalSection').textContent = activity.section;
  // “活动类型”字段已从弹窗移除（与“可获得积分”合并到同一行位置），
  // 因此这里不能再写 #modalType：元素不存在会让整个函数抛错、弹窗打不开。
  $('#modalPoints').textContent = activity.points == null ? '页面未标明' : `+${activity.points} 分`;
  $('#modalBackdrop').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeRegistration() {
  $('#modalBackdrop').classList.add('hidden');
  document.body.style.overflow = '';
}

function showToast(title = '未央主页监测', message = '等待从未央雨课堂个人主页抓取数据') {
  $('#toastTitle').textContent = title;
  $('#toastMessage').textContent = message;
  $('#toast').classList.add('show');
  window.clearTimeout(window.toastTimer);
  window.toastTimer = window.setTimeout(() => $('#toast').classList.remove('show'), 5600);
}

function updateTime() {
  const now = new Date();
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  $('#lastScan').textContent = time;
  $('#footerSync').textContent = time;
}

async function scan() {
  if (monitorPaused) return;
  scanCount += 1;
  updateTime();
  const scanned = await requestRemoteScan();
  if (!scanned) await syncRemoteState();
  renderActivities();
  const title = remoteConnected && lastNewCount > 0 ? `发现 ${lastNewCount} 个新活动` : (remoteConnected ? '扫描完成，暂无新活动' : '发现新的积分活动');
  if (remoteConnected && lastNewCount > 0) showToast(title, '新活动信息来自未央雨课堂主页');
  else if (!remoteConnected) showToast('尚未获取主页数据', '请确认登录状态和主页选择器配置');
}

function resetScanTimer() {
  window.clearInterval(scanTimer);
  const minutes = Number($('#intervalSelect').value);
  scanTimer = window.setInterval(scan, minutes * 60 * 1000);
}

$('#scanButton').addEventListener('click', scan);
$('#toastClose').addEventListener('click', () => $('#toast').classList.remove('show'));
$('#notificationBell').addEventListener('click', () => showToast(remoteConnected ? '待关注活动' : '未连接主页', remoteConnected ? `当前有 ${$('#attentionCount').textContent} 个活动正在报名中` : '暂无从未央雨课堂主页抓取的数据'));
$('#pauseButton').addEventListener('click', (event) => {
  monitorPaused = !monitorPaused;
  event.currentTarget.textContent = monitorPaused ? '恢复监测' : '暂停监测';
  document.querySelector('.live-pulse').style.background = monitorPaused ? '#f0aa58' : '#4bce8c';
  document.querySelector('.status-main strong').textContent = monitorPaused ? '已暂停' : '正在监测';
});
$('#filterButton').addEventListener('click', () => $('#filterMenu').classList.toggle('show'));
$('#filterMenu').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  currentFilter = button.dataset.filter;
  $('#filterButton').innerHTML = `${currentFilter} <span>⌄</span>`;
  $('#filterMenu').classList.remove('show');
  renderActivities();
});
$('#intervalSelect').addEventListener('change', (event) => { $('#intervalLabel').textContent = `${event.target.value} 分钟`; resetScanTimer(); });
$('#allActivitiesButton').addEventListener('click', () => {
  currentFilter = '全部板块';
  $('#filterButton').innerHTML = '全部板块 <span>⌄</span>';
  renderActivities();
  showToast('已显示全部提醒', '可以按板块筛选你想参加的活动');
});
$('#modalClose').addEventListener('click', closeRegistration);
$('#modalBackdrop').addEventListener('click', (event) => { if (event.target === $('#modalBackdrop')) closeRegistration(); });
// 打开活动详情页。两个关键优化：
// 1) 详情页 URL 已在扫描时缓存（activity.detailUrl），此时直接打开，响应时间
//    从 5~7 秒降到几百毫秒；
// 2) 请求期间按钮进入“正在打开中…”状态，避免用户以为点击无效而重复点击。
function setModalSubmitBusy(busy) {
  const button = $('#modalSubmit');
  if (!button) return;
  button.disabled = busy;
  button.style.opacity = busy ? '.65' : '';
  button.style.cursor = busy ? 'progress' : '';
  button.innerHTML = busy ? '正在打开中…' : '打开活动页面 <span>→</span>';
}

$('#modalSubmit').addEventListener('click', () => {
  const activity = activities.find((item) => item.title === $('#modalTitle').textContent);
  // 以前这里直接 return：一旦标题对不上，点击就毫无反应，用户无法判断原因。
  if (!activity) {
    showToast('无法打开报名页面', '当前活动已不在列表中，请等待下一次扫描后重试');
    return;
  }
  // 仅用于在后台打开失败时的前端回退。注意：优先用扫描时缓存好的
  // 详情页地址（activity.detailUrl）；activity.url 在无缓存时会退化成
  // 活动列表页，这里明确排除，避免把用户送到列表页而不是报名页。
  const cachedDetail = activity.detailUrl || (/projectdetail|trainclassdetail/i.test(activity.url || '') ? activity.url : '');
  setModalSubmitBusy(true);
  // 始终通知后台：后台负责用默认浏览器打开活动详情页，并把该活动记为
  // “已报名”（之后不再出现在待关注列表里）。后台不可用时才退回前端自己开。
  const request = fetch(`/api/activity/open?title=${encodeURIComponent(activity.title)}`, { method: 'POST' })
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '活动页面打开失败');
      return result;
    })
    .catch((error) => {
      if (cachedDetail) {
        // 后台暂时不可用，但仍能凭缓存地址打开，不该让用户看到失败。
        console.error('后台打开失败，改用缓存地址:', error.message);
        return { url: cachedDetail, launchedExternally: false, source: 'state-fallback' };
      }
      throw error;
    });
  request
    .then((result) => {
      // 后台已经在用户自己的浏览器里打开了详情页（监测器的 Edge 是无头的，
      // 在无头窗口里新开标签用户看不到）。
      let opened = Boolean(result.launchedExternally);
      let blocked = false;
      if (!opened) {
        // 回退方案：由前端自己新开标签。window.open 返回 null 只说明这个
        // 调用被拦截，并不代表页面没打开（后台可能已经打开了）。
        // 因此返回 null 时给出“请确认”的提示，绝不谎报“无法打开”。
        const popup = window.open(result.url || cachedDetail, '_blank', 'noopener,noreferrer');
        if (popup) { popup.focus(); opened = true; } else { blocked = true; }
      }
      closeRegistration();
      if (blocked) {
        showToast('报名页面已尝试打开', '若未看到新窗口，请允许本站弹出窗口后重新点击');
      } else {
        showToast('已打开报名页面', '报名页已在浏览器中打开，请在新窗口中确认报名信息');
      }
      // 后台已把该活动记为“已报名”，立刻同步一次状态，让它马上从
      // “值得关注的活动”和“待关注活动”计数里消失，不必等下一次轮询。
      syncRemoteState();
    })
    .catch((error) => showToast('无法打开报名页面', error.message))
    .finally(() => setModalSubmitBusy(false));
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeRegistration(); });

$('#allActivitiesButton').classList.add('hidden');
renderPoints();
renderActivities();
renderProfile();
resetScanTimer();
syncRemoteState();
// 后台首次扫描在启动后异步进行，短轮询可让页面在扫描完成后自动显示结果，
// 不需要用户刷新页面，也不会等到下一次长周期扫描。
stateSyncTimer = window.setInterval(() => {
  if (!monitorPaused) syncRemoteState();
}, 3000);
