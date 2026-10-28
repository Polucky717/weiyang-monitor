// 把项目源码推到新建的 GitHub 仓库，并把发布用的 zip 作为 Release 附件上传。
//
// 为什么不用 git 命令：git 推送要么把 token 写进 .git/config 或命令行（会被
// 进程列表/配置文件留存），要么依赖 credential helper。这里改用 GitHub 的
// Git Data API（blob -> tree -> commit -> ref），一次提交全部文件，token 只
// 从环境变量读、只在请求头里出现。
//
// token 从 GH_TOKEN 读。用法：
//   node publish-to-github.js <owner/repo> [tag]
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(1); }

const REPO = process.argv[2];
if (!REPO || !REPO.includes('/')) { console.error('用法: node publish-to-github.js <owner/repo> [tag]'); process.exit(1); }
const TAG = process.argv[3] || 'v1.1.0';
const ZIP = 'weiyang-monitor-github.zip';
// 默认不推送 README.md：这份文件在 GitHub 网页上被手工维护过（改截图、改段落），
// 而本脚本是**整份清单覆盖式**上传 —— 一推就会把网页上的改动悄悄回滚掉，
// 用户只有在打开仓库时才会发现。需要刻意覆盖时才显式加 --include-readme。
// 不推送 README 不影响 Release：zip 附件仍按本地 README 打包，用户下载到手是完整的。
const INCLUDE_README = process.argv.includes('--include-readme');
// 只更新 Release 说明，不产生新提交、不动附件。改完说明用这个开关即可，
// 否则为了改几行字要重新推一遍全部文件、多出一个没有意义的提交。
const NOTES_ONLY = process.argv.includes('--notes-only');

// Release 说明（发布页上显示的内容）。每次发版按实际情况改这里；
// 面向使用者，写清楚"这一版变了什么"，不写实现细节。
const RELEASE_NOTES = [
  '## 更新内容',
  '',
  '- **完善积分目标标准**：所有板块总积分目标定为 25 分，「当前累计积分」卡片直接显示整体进度、已得多少、还差几分。',
  '- **修复若干问题**',
  '  - 桌面提醒不再连带弹出一个空的黑色命令行窗口。',
  '  - 提醒窗口不再 60 秒自己消失（人离开一会儿就再也看不到同一条提醒）。',
  '  - 「在线 / 缓存 / 登录失效」的判定更准确，数据停在旧时间会直接标出停了多少。',
  '  - 登录态失效后会主动提醒，不再静默停止更新。',
  '- **优化排版**：累计积分卡片改为「数字 + 进度条 + 目标提示」，状态与数值对齐更整齐。',
  '- 登录失效提醒支持「确认」与「稍后提醒我」，后者可悬停选择 15 分钟 / 30 分钟 / 1 小时 / 2 小时后再说。',
  '',
  '## 怎么用',
  '',
  '1. 下载本 Release 的 `weiyang-monitor-github.zip` 并解压。',
  '2. 双击 `run-monitor.cmd`，首次会自动安装依赖并打开登录窗口。',
  '3. 面板地址 <http://127.0.0.1:8787/>。',
  '',
  '从旧版升级：覆盖文件后双击 `restart-monitor.cmd`，再双击 `relogin-monitor.cmd` 重新登录一次。',
  '',
  '## 说明',
  '',
  '- 数据源固定为未央雨课堂个人主页，页面没提供的字段保持为空，不做推测。',
  '- 仓库不含登录态、Cookie 或任何 token。',
  '- 仅支持 Windows；开机自启与桌面提醒依赖 Windows 自带组件。'
].join('\n');

const ROOT = path.join(__dirname, '..');

// 要推送的文件（相对项目根，正斜杠）。与 build-release-zip.js 保持同一份清单：
// 排除 node_modules、登录态(.weiyang-state.json)、浏览器配置、日志、备份文件。
const FILES = [
  // 根目录入口（保持平铺：用户从这里双击 / 执行 npm）
  '.gitignore',
  'README.md',
  'package.json',
  'package-lock.json',
  'run-monitor.cmd',
  'restart-monitor.cmd',
  'relogin-monitor.cmd',
  'verify-session.cmd',
  'start-autostart.vbs',
  'start-autostart.cmd',
  'scripts/run-monitor.cmd',
  'monitor.config.example.json',

  // 面板静态文件（须与 index.html 同级）
  'index.html',
  'app.js',
  'styles.css',
  'icon-assets.js',
  'sheep-icon.js',

  // 后台
  'src/server.js',

  // 图标资源与构建工具
  'assets/lectern.png',
  'assets/magnifier.png',
  'assets/sheep.png',
  'tools/build-icon-assets.js',
  'tools/build-release-zip.js',
  'tools/check-file-lists.js',
  'tools/check-icons.js',
  'tools/check-scope.js',
  'tools/fix-ps1-encoding.js',
  'tools/install-autostart.js',
  'tools/publish-to-github.js',
  'tools/restart-and-verify.ps1',
  'tools/relogin-and-verify.ps1',
  'tools/test-check-scope.js',
  'tools/test-session-state.js',
  'tools/test-activity-row.js',
  'tools/test-activity-dim.js',
  'tools/test-status-label.js',
  'tools/test-total-goal.js',
  'tools/test-stat-cards.js',
  'tools/test-notify-behavior.js',
  'tools/test-publish-safety.js',
  'tools/verify-session-restore.ps1',

  // 运行脚本（PowerShell / cmd）
  'scripts/ensure-node.ps1',
  'scripts/find-node.cmd',
  'scripts/log-startup-event.ps1',
  'scripts/run-connected-monitor.ps1',
  'scripts/run-monitor.ps1',
  'scripts/start-edge-monitor.ps1',
  'scripts/start-monitor.ps1',
  'scripts/test-live-notification.ps1',
  'scripts/windows-notify.ps1',
  'scripts/wrap-npm-start.ps1',

  // Windows 启动器（vbs）
  'launchers/launch-chrome-login.vbs',
  'launchers/launch-chrome-monitor.vbs',
  'launchers/launch-monitor-ui.vbs',
  'launchers/launch-monitor.vbs',
  'launchers/setup-chrome-startup.vbs',
  'launchers/setup-desktop.vbs',
  'launchers/test-desktop-notification.vbs',
  'launchers/windows-dialog.vbs',
  'launchers/windows-notify.vbs'
];

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'weiyang-monitor-publisher',
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + TOKEN,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(method + ' ' + apiPath + ' -> ' + res.statusCode + ' ' + JSON.stringify(parsed).slice(0, 400)));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 上传 Release 附件：走 uploads.github.com，body 是原始字节
function uploadAsset(uploadUrl, name, filePath) {
  return new Promise((resolve, reject) => {
    const data = fs.readFileSync(filePath);
    const u = new URL(uploadUrl.replace('{?name,label}', ''));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + '?name=' + encodeURIComponent(name),
      method: 'POST',
      headers: {
        'User-Agent': 'weiyang-monitor-publisher',
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + TOKEN,
        'Content-Type': 'application/zip',
        'Content-Length': data.length
      }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(out));
        else reject(new Error('上传附件 -> ' + res.statusCode + ' ' + out.slice(0, 300)));
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  // —— 只更新 Release 说明（--notes-only）：不建 commit、不动附件。
  if (NOTES_ONLY) {
    console.log('=== 只更新 Release ' + TAG + ' 的说明 ===');
    const existing = await api('GET', '/repos/' + REPO + '/releases/tags/' + TAG);
    const updated = await api('PATCH', '/repos/' + REPO + '/releases/' + existing.id, {
      name: '未央成长活动提醒 ' + TAG,
      body: RELEASE_NOTES
    });
    console.log('  已更新: ' + updated.html_url);
    console.log('  说明字数: ' + RELEASE_NOTES.length);
    return;
  }
  // —— 0. 前置检查
  for (const f of FILES) {
    if (!fs.existsSync(path.join(ROOT, f.split('/').join(path.sep)))) {
      console.error('缺少文件: ' + f); process.exit(1);
    }
  }
  if (!fs.existsSync(path.join(ROOT, ZIP))) { console.error('缺少压缩包: ' + ZIP); process.exit(1); }
  // README.md 默认跳过（见文件开头的说明）。这里就地过滤，后面创建 blob、
  // 建 tree、统计个数都用同一份，避免"清单说推了 N 个、实际只推了 N-1 个"。
  if (!INCLUDE_README) {
    const at = FILES.indexOf('README.md');
    if (at >= 0) FILES.splice(at, 1);
    console.log('跳过 README.md：它在 GitHub 网页上手工维护过，本次不覆盖（要覆盖请加 --include-readme）');
  } else {
    console.log('注意：本次会覆盖 GitHub 上的 README.md（--include-readme）');
  }
  console.log('待推送文件: ' + FILES.length + ' 个');
  console.log('Release 附件: ' + ZIP + '  (' + (fs.statSync(ZIP).size / 1024).toFixed(1) + ' KB)');

  // —— 1. 仓库信息
  console.log('');
  console.log('=== 1. 读取仓库 ===');
  const repo = await api('GET', '/repos/' + REPO);
  console.log('  ' + repo.full_name + '  private=' + repo.private + '  默认分支=' + repo.default_branch);
  const branch = repo.default_branch || 'main';

  // 空仓库的 Git Data API 不能建 blob（会返回 409 "Git Repository is empty."），
  // 所以先用 Contents API 放一个占位提交把仓库「激活」，之后再用 tree/commit
  // 一次性覆盖成完整内容（这样历史里只有两个提交：占位 + 正式）。
  let baseCommit = null;
  try {
    const ref = await api('GET', '/repos/' + REPO + '/git/ref/heads/' + branch);
    baseCommit = ref.object.sha;
    console.log('  分支 ' + branch + ' 已有提交: ' + baseCommit.slice(0, 8));
  } catch (e) {
    if (!/-> (404|409)/.test(e.message)) throw e;
    console.log('  仓库为空，先用 Contents API 激活（占位 README）');
    const boot = await api('PUT', '/repos/' + REPO + '/contents/.bootstrap', {
      message: '初始化仓库',
      content: Buffer.from('placeholder\n', 'utf8').toString('base64')
    });
    baseCommit = boot.commit.sha;
    console.log('  占位提交: ' + baseCommit.slice(0, 8));
  }

  // —— 2. 逐个文件建 blob
  console.log('');
  console.log('=== 2. 创建 blob（' + FILES.length + ' 个）===');
  const tree = [];
  for (const f of FILES) {
    const buf = fs.readFileSync(path.join(ROOT, f.split('/').join(path.sep)));
    const blob = await api('POST', '/repos/' + REPO + '/git/blobs', {
      content: buf.toString('base64'),
      encoding: 'base64'
    });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  ' + f.padEnd(36) + (buf.length / 1024).toFixed(1) + ' KB  ' + blob.sha.slice(0, 8));
  }

  // —— 3. 建 tree
  console.log('');
  console.log('=== 3. 创建 tree ===');
  // base_tree 不能省：Git Data API 建出来的 tree 是**完整快照**，不传 base_tree
  // 就等于"仓库里只剩下面这些文件"，清单之外的一切（README.md、用户后来在网页上
  // 加的任何文件）都会被删除。实测踩过一次：为了不覆盖 README 而把它从清单里去掉，
  // 结果直接把 README 从仓库里删掉了。带上 base_tree 才能做到"只增改、不删除"。
  const treeRes = await api('POST', '/repos/' + REPO + '/git/trees', { tree, base_tree: baseCommit });
  console.log('  tree: ' + treeRes.sha);

  // —— 4. 建 commit（以占位/现有提交为父，保证是正常前进而非改写历史）
  console.log('');
  console.log('=== 4. 创建 commit ===');
  const commit = await api('POST', '/repos/' + REPO + '/git/commits', {
    message: `未央成长活动提醒：活动积分监测器 ${TAG}\n\n`
      + '- 后台用 Playwright 连接无头 Edge/Chrome，定时抓取未央雨课堂活动与个人积分\n'
      + '- 前端展示正在报名中的活动、可获得积分与累计积分，支持报名跳转与桌面通知\n'
      + '- 板块图标：矢量线稿 + 手绘线稿位图（绵羊/演讲台/放大镜）\n'
      + '- 含开机自启、Edge/Chrome 会话复用与通知测试脚本',
    tree: treeRes.sha,
    parents: [baseCommit]
  });
  console.log('  commit: ' + commit.sha);

  // —— 5. 把分支指向该 commit
  console.log('');
  console.log('=== 5. 更新分支 ' + branch + ' ===');
  await api('PATCH', '/repos/' + REPO + '/git/refs/heads/' + branch, { sha: commit.sha, force: false });
  console.log('  ' + baseCommit.slice(0, 8) + ' -> ' + commit.sha.slice(0, 8));

  // —— 6. 建 Release
  console.log('');
  console.log('=== 6. 创建 Release ' + TAG + ' ===');
  const notes = RELEASE_NOTES;

  let release;
  try {
    release = await api('POST', '/repos/' + REPO + '/releases', {
      tag_name: TAG,
      target_commitish: commit.sha,
      name: '未央成长活动提醒 ' + TAG,
      body: notes,
      draft: false,
      prerelease: false
    });
    console.log('  release: ' + release.html_url);
  } catch (e) {
    // 已存在同 tag 时复用它，并把说明/标题更新成当前的，避免发布页停留在旧文案。
    if (!/-> 422/.test(e.message)) throw e;
    console.log('  tag 已存在，复用现有 Release 并更新说明');
    const current = await api('GET', '/repos/' + REPO + '/releases/tags/' + TAG);
    release = await api('PATCH', '/repos/' + REPO + '/releases/' + current.id, {
      name: '未央成长活动提醒 ' + TAG,
      body: notes
    });
  }

  // —— 7. 上传 zip 附件
  console.log('');
  console.log('=== 7. 上传附件 ===');
  const existing = (release.assets || []).find((a) => a.name === ZIP);
  if (existing) {
    await api('DELETE', '/repos/' + REPO + '/releases/assets/' + existing.id);
    console.log('  已删除同名旧附件');
  }
  const asset = await uploadAsset(release.upload_url, ZIP, path.join(ROOT, ZIP));
  console.log('  ' + asset.name + '  ' + (asset.size / 1024).toFixed(1) + ' KB');
  console.log('  下载地址: ' + asset.browser_download_url);

  // —— 8. 清掉激活仓库用的占位文件（正式树里没有它，但父提交里有，需显式删掉）
  console.log('');
  console.log('=== 8. 清理占位文件 ===');
  try {
    const cur = await api('GET', '/repos/' + REPO + '/contents/.bootstrap?ref=' + branch);
    const del = await api('DELETE', '/repos/' + REPO + '/contents/.bootstrap', {
      message: '移除初始化占位文件',
      sha: cur.sha,
      branch
    });
    console.log('  已删除 .bootstrap（提交 ' + del.commit.sha.slice(0, 8) + '）');
  } catch (e) {
    if (/-> 404/.test(e.message)) console.log('  占位文件不存在，无需清理');
    else throw e;
  }

  console.log('');
  console.log('=== 完成 ===');
  console.log('  仓库:    https://github.com/' + REPO);
  console.log('  发布页:  ' + release.html_url);
  console.log('  源码:    https://github.com/' + REPO + '/tree/' + branch);
})().catch((e) => { console.error('发布失败:', e.message); process.exit(1); });
