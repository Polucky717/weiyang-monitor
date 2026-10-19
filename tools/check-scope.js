// 静态检查 src/*.js 里“使用了但从未声明”的标识符。
//
// 为什么需要这个工具：`node --check` 只做语法解析，`pointsMatch is not defined`
// 这种作用域错误完全合法、能通过语法检查，只有真正执行到那一行才抛。
// 本工具诞生的直接原因：重构 readPointsAndSection 时，server.js 的返回对象里
// 残留了已删除的 pointsMatch，导致每次扫描都在最后一步抛异常 —— 活动列表照常
// 更新，但累计积分再也不会被刷新，界面上一直显示旧值（真实故障）。
//
// 用法: node tools\check-scope.js [文件...]      缺省检查 src/server.js
//
// 已知局限（重要，别把它当编译器）：
//   1. 声明收集是**全文件**作用域的，不区分函数。所以如果同一个名字在别的函数里
//      有合法声明，本工具在另一个函数里把它写错也抓不到。真实故障那次能抓住，
//      是因为 pointsMatch 在改动后全文件只剩那一处引用（对应的声明已被删除）。
//   2. 数组解构、解构重命名（{ a: b }）、with/标签语句等只做了粗略处理，可能漏报。
//   3. 模板串整体被抹掉，所以模板里的 ${...} 表达式不参与检查。
// 它的定位是"改名/删除声明后漏改"的第二道网，用来补 node --check 的盲区，
// 不能替代真实运行。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 语言内置与宿主全局名。刻意保守：宁可漏报，也不要满屏噪音。
const GLOBALS = new Set(('globalThis global process console require module exports __dirname __filename ' +
  'Buffer URL URLSearchParams TextEncoder TextDecoder AbortController AbortSignal ' +
  'setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask ' +
  'structuredClone fetch Headers Request Response FormData Blob File crypto performance ' +
  'JSON Math Date Number String Boolean Array Object Map Set WeakMap WeakSet ' +
  'Promise Symbol BigInt RegExp Error TypeError RangeError SyntaxError ReferenceError ' +
  'EvalError URIError AggregateError Proxy Reflect Intl Function Infinity NaN ' +
  'undefined null true false this super arguments eval isNaN isFinite ' +
  'parseInt parseFloat encodeURI encodeURIComponent decodeURI decodeURIComponent ' +
  'ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray ' +
  'Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array ' +
  'BigInt64Array BigUint64Array Atomics WeakRef FinalizationRegistry ' +
  'await yield async of in new typeof instanceof void delete do else case default break continue ' +
  'return throw try catch finally switch while for if function class extends static get set ' +
  'const let var import export from as with debugger').split(/\s+/));

// 浏览器/页面上下文里的全局名：它们出现在 page.evaluate() 的回调里，
// 运行时由 Playwright 在浏览器里执行，本文件里当然找不到声明。
const BROWSER_GLOBALS = ('document window navigator location localStorage sessionStorage history screen ' +
  'alert confirm prompt getComputedStyle requestAnimationFrame cancelAnimationFrame ' +
  'Element HTMLElement Node NodeList Event CustomEvent MutationObserver IntersectionObserver ' +
  'XMLHttpRequest WebSocket Worker Image Audio Option DOMParser FileReader ' +
  'caches indexedDB PopStateEvent HashChangeEvent StorageEvent CloseEvent ' +
  'CSS CSSStyleSheet DOMPoint DOMRect Range Selection ClipboardEvent DragEvent ' +
  'KeyboardEvent MouseEvent PointerEvent TouchEvent WheelEvent FocusEvent InputEvent ' +
  'SubmitEvent ErrorEvent ProgressEvent ResizeObserver PerformanceObserver BroadcastChannel ' +
  'MessageChannel MessagePort atob btoa scrollTo scrollBy matchMedia').split(/\s+/);
for (const name of BROWSER_GLOBALS) GLOBALS.add(name);

// 把注释、字符串、模板串、正则字面量替换成空格，保持字符数与行数不变。
function stripLiterals(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { const end = src.indexOf('\n', i); const to = end === -1 ? src.length : end; blank(i, to); i = to; continue; }
    if (ch === '/' && next === '*') { const end = src.indexOf('*/', i + 2); const to = end === -1 ? src.length : end + 2; blank(i, to); i = to; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === ch) break; j += 1; }
      blank(i, j + 1); i = j + 1; prev = ch; continue;
    }
    if (ch === '/' && !/[A-Za-z0-9_$)\]}"'`]/.test(prev)) {
      let j = i + 1; let inClass = false; let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true; else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        // 连 flag 一起抹掉：`/,/g` 里的 g、`/Timeout/i` 里的 i 若不抹，
        // 会被后面的扫描当成“使用了但未声明的标识符”，产生稳定的假报。
        let k = j + 1;
        while (k < src.length && /[a-z]/.test(src[k])) k += 1;
        blank(i, k);
        i = k;
        prev = '/';
        continue;
      }
    }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return out.join('');
}

const ID = /[A-Za-z_$][\w$]*/g;

function collectDeclared(code) {
  const declared = new Set();
  const add = (n) => { if (n) declared.add(n); };
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 对象解构声明
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}\n]*)\}/g)) {
    for (const id of m[1].matchAll(ID)) add(id[0]);
  }
  // 数组解构：只在右侧确有 `=` 时才算，避免把 `[1]`、正则字符类误当声明
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\]\s*=/g)) {
    for (const id of m[1].matchAll(ID)) add(id[0]);
  }
  // import 名字
  for (const m of code.matchAll(/\bimport\s+([^;]+?)\s+from\b/g)) {
    for (const id of m[1].matchAll(ID)) add(id[0]);
  }
  // 函数/箭头的形参
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const id of m[1].matchAll(ID)) add(id[0]);
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const id of m[1].matchAll(ID)) add(id[0]);
  }
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) add(m[1]);
  return declared;
}

// 检查一段源码，返回“使用了但未声明”的标识符列表。
// 导出成函数是为了让自检能直接调用 —— 本环境里 spawn 子进程并捕获输出
// 会被沙箱的管道限制拒绝（EPERM），所以自检不能靠 execFileSync。
function findUndeclared(rawSrc) {
  // 统一换行：源码是 CRLF，若不归一化，按 '\n' 切分后每行尾部都残留 '\r'，
  // 行内容比对（例如判断某行是不是 'points,'）会全部失配。
  const src = String(rawSrc).replace(/\r\n?/g, '\n');
  const code = stripLiterals(src);
  const declared = collectDeclared(code);
  // 把反斜杠转义整体抹掉再扫标识符：`\d+`、`\s*`、`\n` 里的 d/s/n 会被
  // 当成裸标识符，产生稳定的假报（例如 /(\d+)\s*\/\s*(\d+)/ 报出 d 和 s）。
  const lines = code.split('\n').map((line) => line.replace(/\\[\s\S]/g, '  '));

  // 收集所有“裸引用”（排除 .prop 这种属性名）
  const refs = new Map();
  for (let ln = 0; ln < lines.length; ln += 1) {
    const withoutProps = lines[ln].replace(/\.\s*[A-Za-z_$][\w$]*/g, (m) => ' '.repeat(m.length));
    for (const m of withoutProps.matchAll(/(^|[^\w$])([A-Za-z_$][\w$]*)/g)) {
      const name = m[2];
      // 对象字面量的键名：后面紧跟冒号、再后面不是另一个冒号（排除 ?: 与 label）
      const after = withoutProps.slice(m.index + m[1].length + name.length);
      if (/^\s*:(?!:)/.test(after)) continue;
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push(ln + 1);
    }
  }

  const problems = [];
  for (const [name, where] of refs) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) continue; // 全大写常量视为外部/约定
    problems.push({ name, lines: [...new Set(where)].slice(0, 4) });
  }
  return problems;
}

module.exports = { findUndeclared, stripLiterals, collectDeclared };

// 只有作为脚本直接运行时才走 CLI；被 require 时不执行。
if (require.main === module) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(ROOT, 'src', 'server.js')];
  let total = 0;
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const problems = findUndeclared(fs.readFileSync(abs, 'utf8'));
    const rel = path.relative(ROOT, abs);
    if (!problems.length) { console.log('OK   ' + rel + '  未发现未声明的标识符'); continue; }
    total += problems.length;
    console.log('可疑 ' + rel + '  共 ' + problems.length + ' 处：');
    for (const p of problems) console.log('    ' + p.name.padEnd(26) + ' 行 ' + p.lines.join(', '));
  }
  if (total) {
    console.log('');
    console.log('这些名字被使用了但全文都没声明过。若是改名漏改，运行时会在执行到那一行时');
    console.log('抛 ReferenceError —— `node --check` 抓不到这类错误。');
  }
  process.exit(total ? 1 : 0);
}
