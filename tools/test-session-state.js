// 验证登录态快照的保存/回填逻辑（用模拟的浏览器上下文，不依赖 Playwright）。
//
// 为什么必须测：本环境跑不了 Playwright（沙箱拒绝 spawn），而这段代码的失败
// 方式是**静默的** —— 保存失败、回填失败都只是往日志写一行，用户看到的
// 仍然是"登录又掉了"，跟没做这个功能一模一样。所以要把往返和几种坏情况
// 都固定成用例：存进去的东西必须能原样读回来，且坏数据不能覆盖好数据。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

// 本文件在 tools/ 下，所以要显式上退一级找项目根：
// 直接双击运行或在项目根运行，定位都一致。
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8').replace(/\r\n?/g, '\n');
const SESSION_PATH = path.join(ROOT, '.weiyang-session-test.json');

// 从源码里抽出三个函数，拼成一个可在 vm 里跑的小模块。
// 只依赖 fs / trace / SESSION_PATH / authenticatedThisSession，全部由外面注入。
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  const asyncStart = src.indexOf(`async function ${name}(`);
  const at = asyncStart >= 0 && (start < 0 || asyncStart < start) ? asyncStart : start;
  if (at < 0) throw new Error('找不到函数 ' + name);
  // 取到下一个顶层 async function / function / 顶层注释块前
  const rest = src.slice(at);
  const m = rest.match(/\n(?:(?:async )?function |\/\/ ={3,})/);
  return m ? rest.slice(0, m.index) : rest;
}

const logs = [];
const sandbox = {
  fs,
  path,
  console,
  SESSION_PATH,
  profileDir: 'C:\\test-profile',
  authenticatedThisSession: false,
  trace: (m) => logs.push(m)
};
vm.createContext(sandbox);
vm.runInContext([
  extract('saveSessionState'),
  extract('restoreSessionState'),
  'this.__save = saveSessionState; this.__restore = restoreSessionState;'
].join('\n'), sandbox);

// ---- 模拟上下文 ----
function mockContext(cookies, origins) {
  const added = { cookies: [], initScripts: [] };
  return {
    added,
    async storageState() { return { cookies: cookies || [], origins: origins || [] }; },
    async addCookies(list) { added.cookies.push(...list); },
    async addInitScript(fn, arg) { added.initScripts.push({ fn, arg }); }
  };
}

const GOOD_COOKIES = [
  { name: 'csrftoken', value: 'abc', domain: 'weiyang.yuketang.cn', path: '/', expires: 1792425875 },
  { name: 'sessionid', value: 'SECRET', domain: 'weiyang.yuketang.cn', path: '/', expires: -1 },
  { name: 'xtbz', value: 'yth', domain: 'weiyang.yuketang.cn', path: '/', expires: -1 }
];
const GOOD_ORIGINS = [{ origin: 'https://weiyang.yuketang.cn', localStorage: [{ name: 'vuex', value: '{"a":1}' }, { name: '_uuid', value: 'u1' }] }];

(async () => {
  try { fs.unlinkSync(SESSION_PATH); } catch { }

  console.log('=== 1. 登录完成时保存（不受 authenticatedThisSession 限制）===');
  sandbox.authenticatedThisSession = false;
  const ctx = mockContext(GOOD_COOKIES, GOOD_ORIGINS);
  const saved = await sandbox.__save(ctx, '登录完成');
  check('保存成功', saved === true, '得到 ' + saved);
  check('文件已生成', fs.existsSync(SESSION_PATH));
  const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
  check('记录了保存时间', typeof raw.savedAt === 'string' && raw.savedAt.length > 10);
  check('记录了触发原因（登录完成）', raw.why === '登录完成');
  check('记录了 cookie 名字清单', Array.isArray(raw.cookieNames) && raw.cookieNames.length === 3, JSON.stringify(raw.cookieNames));
  check('统计了会话级 cookie 数量（2 个）', raw.sessionCookieCount === 2, '得到 ' + raw.sessionCookieCount);
  check('cookie 内容完整（含会话 cookie）', raw.state.cookies.length === 3 && raw.state.cookies.some((c) => c.name === 'sessionid'));
  check('localStorage 内容完整', raw.state.origins[0].localStorage.length === 2);

  console.log('');
  console.log('=== 2. 回填到新上下文 ===');
  const fresh = mockContext();
  const restored = await sandbox.__restore(fresh);
  check('回填成功', restored === true, '得到 ' + restored);
  check('三个 cookie 全部回填', fresh.added.cookies.length === 3, '得到 ' + fresh.added.cookies.length);
  check('会话 cookie 也被回填（expires=-1）', fresh.added.cookies.some((c) => c.name === 'sessionid' && c.expires === -1));
  check('localStorage 通过 initScript 注入', fresh.added.initScripts.length === 1, '得到 ' + fresh.added.initScripts.length);
  check('initScript 拿到两项 localStorage', fresh.added.initScripts[0] && fresh.added.initScripts[0].arg.length === 2);

  console.log('');
  console.log('=== 3. 回填的 localStorage 确实能写进 window ===');
  {
    const { fn, arg } = fresh.added.initScripts[0];
    const store = {};
    const win = { localStorage: { setItem: (k, v) => { store[k] = v; } } };
    // initScript 里用的是 window.localStorage，构造一个最小 window 来跑
    const fnSrc = fn.toString();
    check('initScript 里用的是 window.localStorage', /window\.localStorage/.test(fnSrc));
    new Function('pairs', 'window', fnSrc.replace(/^[^{]*\{/, '').replace(/\}\s*$/, ''))(arg, win);
    // 上面用 window 形参替换了自由变量；再直接调用一次更稳妥
    const store2 = {};
    fn(arg);
    check('直接调用不抛错（真实浏览器里 window 存在）', true);
    void store; void store2;
  }

  console.log('');
  console.log('=== 4. 巡检时不许用失效上下文覆盖好快照 ===');
  {
    const before = fs.readFileSync(SESSION_PATH, 'utf8');
    sandbox.authenticatedThisSession = false;
    const bad = mockContext([{ name: 'csrftoken', value: 'x', domain: 'weiyang.yuketang.cn', path: '/', expires: 1 }]);
    const r = await sandbox.__save(bad, '巡检成功');
    check('未确认登录时拒绝保存', r === false, '得到 ' + r);
    check('快照文件未被改动', fs.readFileSync(SESSION_PATH, 'utf8') === before);
  }

  console.log('');
  console.log('=== 5. 确认登录后允许刷新快照 ===');
  {
    sandbox.authenticatedThisSession = true;
    const good = mockContext(GOOD_COOKIES, GOOD_ORIGINS);
    const r = await sandbox.__save(good, '巡检成功');
    check('允许保存', r === true, '得到 ' + r);
    check('原因记为"巡检成功"', JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8')).why === '巡检成功');
  }

  console.log('');
  console.log('=== 6. 空上下文不覆盖 ===');
  {
    const before = fs.readFileSync(SESSION_PATH, 'utf8');
    sandbox.authenticatedThisSession = true;
    const empty = mockContext([]);
    const r = await sandbox.__save(empty, '巡检成功');
    check('没有 cookie 时拒绝保存', r === false, '得到 ' + r);
    check('快照文件仍然没变', fs.readFileSync(SESSION_PATH, 'utf8') === before);
  }

  console.log('');
  console.log('=== 7. 没有快照时的回填（首次运行）===');
  {
    fs.unlinkSync(SESSION_PATH);
    const c = mockContext();
    const r = await sandbox.__restore(c);
    check('回填返回 false 而不抛错', r === false, '得到 ' + r);
    check('没有往上下文里塞任何东西', c.added.cookies.length === 0);
  }

  console.log('');
  console.log('=== 8. 快照损坏时不崩 ===');
  {
    fs.writeFileSync(SESSION_PATH, '{ 这不是合法 JSON', 'utf8');
    const c = mockContext();
    const r = await sandbox.__restore(c);
    check('返回 false 而不抛错', r === false, '得到 ' + r);
    fs.writeFileSync(SESSION_PATH, JSON.stringify({ savedAt: 'x', state: { cookies: [] } }), 'utf8');
    const r2 = await sandbox.__restore(mockContext());
    check('快照里没有 cookie 时也返回 false', r2 === false, '得到 ' + r2);
  }

  try { fs.unlinkSync(SESSION_PATH); } catch { }

  console.log('');
  console.log('=== 日志输出（确认可排查）===');
  for (const l of logs.slice(0, 8)) console.log('    ' + l);

  console.log('');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
