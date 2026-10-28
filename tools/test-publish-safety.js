// 回归测试：发布工具不能误删仓库里的文件，也不能覆盖用户在网页上维护的 README。
//
// 这次踩的坑值得单独钉住：为了让 README 不被覆盖，把它从推送清单里去掉了 ——
// 而 Git Data API 建 tree 时如果不带 base_tree，建出来的是**完整快照**，
// 清单之外的文件会被全部删除。结果 README 直接从仓库里消失了，
// 而发布脚本自己还打印着"完成"。这类"静默删除用户文件"的故障必须静态拦住。
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

const src = fs.readFileSync(path.join(__dirname, 'publish-to-github.js'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, 'build-release-zip.js'), 'utf8');

console.log('=== 1. 建 tree 必须带 base_tree（否则清单外的文件被删除）===');
check('创建 tree 时传了 base_tree', /git\/trees'?,\s*\{\s*tree[^}]*base_tree/.test(src));
check('base_tree 指向当前分支头', /base_tree:\s*baseCommit/.test(src));
check('注释解释了为什么不能省', /完整快照/.test(src));

console.log('');
console.log('=== 2. README 默认不覆盖，但可以显式覆盖 ===');
check('有 --include-readme 开关', /--include-readme/.test(src));
check('默认会跳过 README.md', /if \(!INCLUDE_README\)/.test(src));
check('跳过后清单里确实去掉了 README', /FILES\.splice\(at, 1\)/.test(src));
check('两种选择都会打印出来（不静默）', /跳过 README\.md/.test(src) && /本次会覆盖 GitHub 上的 README\.md/.test(src));

console.log('');
console.log('=== 3. 清单仍然一致（zip 与推送用同一份）===');
const listOf = (s) => {
  const m = s.match(/const FILES = \[([\s\S]*?)\n\];/);
  return m ? m[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith("'")).map((l) => l.replace(/^'|',?$/g, '')) : null;
};
const a = listOf(src); const b = listOf(build);
check('两份清单都存在', Boolean(a && b));
check('条目数相同', a && b && a.length === b.length, a && b ? a.length + ' vs ' + b.length : '');
check('README.md 仍在清单里（靠 base_tree 保住远端内容）', Boolean(a && a.includes('README.md')));

console.log('');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
