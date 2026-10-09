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
const TAG = process.argv[3] || 'v1.0.0';
const ZIP = 'weiyang-monitor-github.zip';

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
  'tools/check-icons.js',
  'tools/publish-to-github.js',

  // 运行脚本（PowerShell / cmd）
  'scripts/install-startup.ps1',
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
  // —— 0. 前置检查
  for (const f of FILES) {
    if (!fs.existsSync(path.join(ROOT, f.split('/').join(path.sep)))) {
      console.error('缺少文件: ' + f); process.exit(1);
    }
  }
  if (!fs.existsSync(path.join(ROOT, ZIP))) { console.error('缺少压缩包: ' + ZIP); process.exit(1); }
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
  const treeRes = await api('POST', '/repos/' + REPO + '/git/trees', { tree });
  console.log('  tree: ' + treeRes.sha);

  // —— 4. 建 commit（以占位/现有提交为父，保证是正常前进而非改写历史）
  console.log('');
  console.log('=== 4. 创建 commit ===');
  const commit = await api('POST', '/repos/' + REPO + '/git/commits', {
    message: '未央成长活动提醒：活动积分监测器 v1.0.0\n\n'
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
  const notes = [
    '未央成长活动提醒 / 活动积分监测器 首个发布版。',
    '',
    '## 这个包能做什么',
    '',
    '- 定时抓取未央雨课堂的活动列表与个人积分，在本地面板上展示正在报名中的活动',
    '- 显示可获得积分与当前累计积分，点「去报名」直接跳转活动页面',
    '- 发现新活动时弹 Windows 桌面通知，扫描频率可调（15 / 30 / 60 分钟）',
    '- 后台用无头 Edge / Chrome 复用已登录会话，不保存密码',
    '',
    '## 怎么用',
    '',
    '源码方式（推荐，便于按自己情况改选择器）：',
    '',
    '```powershell',
    'npm install',
    'npm run install-browser',
    'npm run login',
    'npm start',
    '```',
    '',
    '面板地址 <http://127.0.0.1:8787/>。详细步骤见仓库 README。',
    '',
    '想直接跑：下载本 Release 里的 `weiyang-monitor-github.zip`，解压后双击 `run-monitor.cmd`。',
    '',
    '## 说明',
    '',
    '- 数据源固定为未央雨课堂个人主页，页面没提供的字段保持为空，不做推测。',
    '- 仓库不含登录态、Cookie 或任何 token。',
    '- 需要在 Windows 上运行；开机自启与桌面通知依赖 Windows 自带组件。'
  ].join('\n');

  let release;
  try {
    release = await api('POST', '/repos/' + REPO + '/releases', {
      tag_name: TAG,
      target_commitish: commit.sha,
      name: '未央成长活动提醒 v1.0.0',
      body: notes,
      draft: false,
      prerelease: false
    });
    console.log('  release: ' + release.html_url);
  } catch (e) {
    // 已存在同 tag 时，复用它（避免重复发布失败）
    if (!/-> 422/.test(e.message)) throw e;
    console.log('  tag 已存在，复用现有 Release');
    release = await api('GET', '/repos/' + REPO + '/releases/tags/' + TAG);
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
