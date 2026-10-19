// check-scope.js 的自检套件：node tools\test-check-scope.js
//
// 为什么要有这个文件：check-scope 本身是"用来抓漏改名的工具"，但它自己改动时
// 很容易悄悄坏掉 —— 而且坏的方式是**两个相反方向**：
//   * 变得爱报（假报）：改了模板串处理后一度报出 149 处，
//     再后来又因为索引算错报出 `httpOnly`；
//   * 变得沉默（漏报）：模板串里的代码没被检查，`${b}` 抓不到 b。
// 两种都会让人不再信任它。所以这里把"必须抓到的真错误"和"必须不报的噪声"
// 都固定成用例，改完工具跑一遍就知道有没有退化。
const fs = require('fs');
const path = require('path');
const { findUndeclared } = require('./check-scope.js');

let pass = 0; let fail = 0;
const check = (label, cond, detail) => {
  if (cond) pass += 1; else fail += 1;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail && !cond ? '   ' + detail : ''));
};

// 套件放在 tools/ 下，所以被检查的源码在上一级目录
const target = path.join(__dirname, '..', 'src', 'server.js');
const orig = fs.readFileSync(target, 'utf8').replace(/\r\n?/g, '\n');

console.log('=== 真错误仍要抓到 ===');
check('改名漏改 explicitTrustworty', findUndeclared(orig.replace('} else if (explicitTrustworthy) {', '} else if (explicitTrustworty) {')).some((p) => p.name === 'explicitTrustworty'));
check('凭空引用 bogusNameHere', findUndeclared(orig.replace('const effectivePoints =', 'const effectivePoints = bogusNameHere +')).some((p) => p.name === 'bogusNameHere'));
check('未声明变量 notDeclaredAnywhere', findUndeclared('const a = 1;\nconsole.log(a, notDeclaredAnywhere);\n').some((p) => p.name === 'notDeclaredAnywhere'));

console.log('');
console.log('=== 属性名不再误报 ===');
check('三元里的 .httpOnly', findUndeclared("const c = { httpOnly: true };\nconst s = `${c.httpOnly ? 'y' : 'n'}`;\n").length === 0, JSON.stringify(findUndeclared("const c = { httpOnly: true };\nconst s = `${c.httpOnly ? 'y' : 'n'}`;\n")));
check('普通属性 .domain', findUndeclared('const c = { domain: "a" };\nconsole.log(c.domain);\n').length === 0, JSON.stringify(findUndeclared('const c = { domain: "a" };\nconsole.log(c.domain);\n')));
check('链式属性 a.b.c', findUndeclared('const a = { b: { c: 1 } };\nconsole.log(a.b.c);\n').length === 0, JSON.stringify(findUndeclared('const a = { b: { c: 1 } };\nconsole.log(a.b.c);\n')));

console.log('');
console.log('=== 正则转义不误报 ===');
check('正则里的 \\\\d', findUndeclared('const re = /(\\d+)\\/(\\d+)/;\nconsole.log("1/2".match(re));\n').length === 0, JSON.stringify(findUndeclared('const re = /(\\d+)\\/(\\d+)/;\nconsole.log("1/2".match(re));\n')));

console.log('');
console.log('=== 模板串 ===');
check('${} 内的未声明变量被抓到', findUndeclared('const a = 1;\nconst s = `hello ${b}`;\n').some((p) => p.name === 'b'));
check('嵌套模板不崩且不假报', findUndeclared('const a = 1;\nconst s = `x${`y${a}`}z`;\n').length === 0);

console.log('');
console.log('=== 真实源码 ===');
const problems = findUndeclared(orig);
check('src/server.js 无未声明标识符', problems.length === 0, JSON.stringify(problems.slice(0, 5)));

console.log('');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
