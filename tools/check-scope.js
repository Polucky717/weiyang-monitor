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

// 判断 src[k] 处的 `/` 是"正则字面量开头"还是"除号"。
// 规则来自 JS 词法：`/` 前面若是一个"值"（标识符、`)`、`]`、字符串、模板串），
// 它就是除号；否则（前面是 `(`、`,`、`=`、`:`、`return`、`&&` 之类）是正则开头。
// 这条判断必须做对：真实源码里有 `/'/g`（正则里含单引号），把它当字符串开头
// 会让扫描器从此错位 —— 实测导致后面 149 处假报。
function regexCanStartAt(src, k) {
  let p = k - 1;
  while (p >= 0 && /\s/.test(src[p])) p -= 1;
  if (p < 0) return true;
  const prev = src[p];
  if (/[A-Za-z0-9_$)\]}"'`]/.test(prev)) {
    // 例外：return / typeof / case 这类关键字后面可以跟正则
    let w = p;
    while (w >= 0 && /[A-Za-z0-9_$]/.test(src[w])) w -= 1;
    const word = src.slice(w + 1, p + 1);
    return /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(word);
  }
  return true;
}

// 从模板串插值的表达式内部（即 `{` 之后）开始扫，返回配平的 `}` 之后的索引。
//
// 需要跳过这些东西，否则它们里面的花括号会破坏配平：
//   * 单/双引号字符串（`'}'`、`"{"`）
//   * 正则字面量（`/'/g`、`/\{/`）—— 里面的引号和花括号都不能算数
//   * 嵌套模板串（`` `x${a}` ``）—— 它内部又是一层插值，所以递归处理
//   * 行注释与块注释
// 只做配平，不关心表达式的语义 —— 目标是"别卡死、别抹错范围"。
function skipInterpolation(src, from, blank) {
  const wipe = typeof blank === 'function' ? blank : () => {};
  let j = from;
  let brace = 1;              // 已经消费掉 ${ 的那个 `{`
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e === -1 ? src.length : e; continue; }
    if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e === -1 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      let k = j + 1;
      while (k < src.length) { if (src[k] === '\\') { k += 2; continue; } if (src[k] === c) break; k += 1; }
      // 表达式里的字符串内容也要抹掉：`${c.httpOnly ? 'y' : 'n'}` 里若留着
      // 'y' / 'n'，它们会被当成裸标识符报出来。这是个真踩到的老坑。
      wipe(j, Math.min(k + 1, src.length));
      j = k + 1;
      continue;
    }
    if (c === '/' && regexCanStartAt(src, j)) {
      // 正则字面量：扫到未转义、且不在字符类里的 `/` 为止（含 flag）。
      let k = j + 1; let inClass = false; let closed = false;
      while (k < src.length) {
        const d = src[k];
        if (d === '\\') { k += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        k += 1;
      }
      if (closed) {
        // 把 flag 也纳入范围，然后**真的抹掉**，不能只是跳过 —— 只跳过的话
        // 正则里的内容会原样留在结果里，`/'/g` 的 `'` 随后被当成字符串开头、
        // `g` 被当成标识符。实测这里漏了 wipe，导致 2 处假报。
        while (k + 1 < src.length && /[a-z]/.test(src[k + 1])) k += 1;
        wipe(j, k + 1);
        j = k + 1;
        continue;
      }
      // 没闭合就当普通字符处理，别把后面全吃掉
      j += 1;
      continue;
    }    if (c === '`') {
      // 嵌套模板串：找到它的收尾反引号，途中遇到 ${ 就递归跳过那层插值。
      // 嵌套模板的**静态文本也要抹掉**，否则会留下 `y`（来自 `` `y${a}` ``）
      // 这种假标识符。
      let k = j + 1;
      let textFrom = k;
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '`') break;
        if (src[k] === '$' && src[k + 1] === '{') {
          wipe(textFrom, k);
          // 同样把嵌套 ${ 的 $ 抹掉（保留 {），否则它会粘到前面的标识符上
          // 变成 `y$` 这种假标识符。
          wipe(k, k + 1);
          k = skipInterpolation(src, k + 2, wipe);
          textFrom = k;
          continue;
        }
        k += 1;
      }
      wipe(textFrom, Math.min(k, src.length));
      j = k + 1;
      continue;
    }
    if (c === '{') { brace += 1; j += 1; continue; }
    if (c === '}') {
      brace -= 1;
      j += 1;
      if (brace === 0) return j;
      continue;
    }
    j += 1;
  }
  return j;                   // 没配平：返回末尾，交给调用方保守处理
}

// 把注释、字符串、模板串、正则字面量替换成空格，保持字符数与行数不变。
//
// 重要约定：本循环用 `i` 表示"最后消费掉的字符索引"，而不是"下一个待处理索引"。
// 因此每个分支结束时必须保证 i 真的前进了 —— 漏掉就会在同一处反复重扫，
// 表现为**整个工具卡死**（实测：嵌套模板串 `` `x${`y${a}`}z` `` 会死循环，
// 因为模板分支结束时 i 停在反引号上，下一轮又从同一个反引号进入）。
// 下面在第 60 行留了一道"强制前进"保险，任何分支忘记推进都不会再卡死。
function stripLiterals(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const iAtStart = i;            // 保险用：本轮结束若 i 未前进，强制 +1
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { const end = src.indexOf('\n', i); const to = end === -1 ? src.length : end; blank(i, to); i = to; continue; }
    if (ch === '/' && next === '*') { const end = src.indexOf('*/', i + 2); const to = end === -1 ? src.length : end + 2; blank(i, to); i = to; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === ch) break; j += 1; }
      blank(i, j + 1); i = j + 1; prev = ch; continue;
    }
    if (ch === '`') {
      // 模板串要特殊处理：`a${expr}b` 里只有静态文本该被抹掉，${...} 里的
      // expr 是**真代码**，必须保留下来参与检查 —— 它可能引用未声明的标识符。
      //
      // 这段踩过三个坑，全都发生在同一处：
      //   1) 把整个模板串一路抹到最后一个反引号 → `${` 的 `$` 残留，被报成
      //      "使用了但未声明的标识符 $"，而 ${...} 里的代码完全没被检查；
      //   2) 改成"只保留 ${...}"时手滑把 ${...} 本身也抹了 → 假报没了但变成漏报
      //      （`${b}` 抓不到 b）；
      //   3) 自己数花括号深度：进入 ${ 时把 j 推到 `{` 上，下一轮又把同一个 `{`
      //      数一次 → 深度在同一字符上无限递增，**整个工具卡死**；而且嵌套模板
      //      `` `x${`y${a}`}z` `` 里内层的收尾反引号会被误当成外层结束符。
      // 结论：不要手写深度计数，用"跳过字符串与嵌套模板 + 配平花括号"的扫描。
      // 静态文本用 blank() 抹掉，${ 与 } 原样保留，表达式内容完全不碰。
      let j = i + 1;              // 指向模板文本起点
      let textStart = j;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;                       // 模板结束
        if (src[j] !== '$' || src[j + 1] !== '{') { j += 1; continue; }
        // 命中 ${ ：抹掉它之前的静态文本，再用配平扫描跳过整个表达式
        blank(textStart, j);
        // 把 $ 也抹成空格、但保留 { —— 不能留着 $：它紧跟在标识符后面会被
        // 吸进同一个令牌（`x${a}` 被扫成 `x$`），还会让后面对齐整体错位，
        // 连带把正则 flag、字符串内容误报成未声明标识符。
        blank(j, j + 1);
        j = skipInterpolation(src, j + 2, blank);
        textStart = j;                                   // 表达式之后是新的静态文本
      }
      if (j >= src.length) {
        // 模板串没有收尾的反引号：保守地把剩下部分整体抹掉。
        // 宁可漏报也不制造假警报。
        blank(textStart, src.length);
        i = src.length;
        continue;
      }
      blank(textStart, j);        // 结尾那段静态文本
      blank(j, j + 1);            // 收尾反引号本身
      i = j + 1;
      prev = '`';
      continue;
    }
    // 正则字面量的判定，统一走 regexCanStartAt（基于**原始源码**的前一个有效字符）。
    // 旧实现用 prev 变量，而 prev 来自已被抹白的输出，判断不可靠：实测行 264 的
    // `/'/g` 没被识别成正则，里面的 `'` 被当成字符串开头，扫描器随后整体错位，
    // 导致后面 149 处假报。
    if (ch === '/' && regexCanStartAt(src, i)) {
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
    // 强制前进：正常路径下各分支已经把 i 推到下一处，但只要有分支忘了推进
    // （模板串分支就踩过这个坑），这里兜住，避免整个工具死循环。
    // 注意必须用本轮开头记下的 iAtStart 比较 —— 早先这里写成比较外层的变量，
    // 护栏本身就失效了。
    if (i <= iAtStart) i = iAtStart + 1;
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
  // for...of / for...in 的循环变量，含解构形式：
  //   for (const x of list)          → 旧写法已覆盖
  //   for (const [a, b] of entries)  → 必须单独处理，否则 a/b 会被当成未声明
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*\[([^\]]*)\]\s*(?:of|in)\b/g)) {
    for (const id of m[1].matchAll(ID)) add(id[0]);
  }
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

  // 收集所有“裸引用”（排除 .prop 这种属性名）
  //
  // 顺序很重要：必须**先**抹掉 `.属性`，**再**抹掉反斜杠转义。
  // 反过来的话，`\.` 会被替换成两个空格，"点"就没了，于是 `cookie.httpOnly`
  // 里的 `httpOnly` 被当成裸标识符报出来（实测报过）。而抹掉 `.属性` 依赖于
  // "点还在"，所以这两步的先后不能颠倒。
  const refs = new Map();
  for (let ln = 0; ln < code.split('\n').length; ln += 1) {
    const raw = code.split('\n')[ln];
    // 1) 先去掉 .属性
    const withoutProps = raw.replace(/\.\s*[A-Za-z_$][\w$]*/g, (m) => ' '.repeat(m.length));
    // 2) 再抹掉反斜杠转义：`\d+`、`\s*`、`\n` 里的 d/s/n 会被当成裸标识符
    //    （例如 /(\d+)\s*\/\s*(\d+)/ 会报出 d 和 s）
    const line = withoutProps.replace(/\\[\s\S]/g, '  ');
    for (const m of line.matchAll(/(^|[^\w$])([A-Za-z_$][\w$]*)/g)) {
      const name = m[2];
      // 对象字面量的键名：后面紧跟冒号、再后面不是另一个冒号（排除 ?: 与 label）
      //
      // 偏移必须算全：m[1] 是前导字符，名字本身占 name.length 个字符。
      // 早先这里写成 m.index + m[1].length，少算了一个名字的长度，于是 `after`
      // 取到的是名字的尾部残留（例如 `cookie.httpOnly ?` 会得到 "t ?"）而不是
      // " ?"，字符串内容那层过滤因此失效，属性名被当成裸标识符报出来 ——
      // 实测 `c.httpOnly` 里的 httpOnly 就是这么被误报的。
      const after = line.slice(m.index + m[1].length + name.length);
      if (/^\s*:(?!:)/.test(after)) continue;
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push(ln + 1);
    }
  }

  const problems = [];
  for (const [name, where] of refs) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    // 单独的 `$` 不是标识符引用：它出现在模板串插值 `${...}` 的开头，
    // 或正则里作为行尾锚点。把它当"未声明标识符"是纯噪音 —— 实测报过。
    if (name === '$') continue;
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
