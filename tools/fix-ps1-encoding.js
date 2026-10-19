// 确保含非 ASCII 的 .ps1 都带 UTF-8 BOM。
// 可重复运行；每次都重新检查，所以编辑过文件后重跑一次即可。
//
// 为什么必须带 BOM：PowerShell 5.1 读无 BOM 的 .ps1 时会按本地 ANSI 代码页解码，
// 中文会变成乱码字节，**并直接破坏语法解析** —— 实测一个完全正确的脚本被报成
// "The string is missing the terminator"（字符串未闭合）。所以这不是显示问题，
// 而是能不能运行的问题。
//
// 覆盖范围包含 tools/ 与项目根：早期只扫 scripts/，导致 tools/ 下新写的 .ps1
// 漏掉了 BOM，白排查了一轮语法错误。
const fs = require('fs');
const path = require('path');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// 本脚本在 tools/ 下，所以要上退一级才是项目根。
const root = path.join(__dirname, '..');
const dirs = [path.join(root, 'scripts'), path.join(root, 'tools'), root];
let fixed = 0;
let ok = 0;

const seen = new Set();
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.toLowerCase().endsWith('.ps1')) continue;
    const p = path.join(dir, f);
    if (seen.has(p)) continue;
    seen.add(p);
    const label = path.relative(root, p).replace(/\\/g, '/');
    const b = fs.readFileSync(p);
    const hasBom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    const body = hasBom ? b.slice(3) : b;

    let nonAscii = 0;
    for (const x of body) if (x > 127) nonAscii += 1;

    if (nonAscii === 0) { console.log('  ' + label.padEnd(34) + '纯 ASCII，PS 5.1 读它没问题'); ok += 1; continue; }
    if (hasBom) { console.log('  ' + label.padEnd(34) + 'UTF-8 + BOM ✓'); ok += 1; continue; }

    try { new TextDecoder('utf-8', { fatal: true }).decode(body); } catch (e) {
      console.log('  ' + label.padEnd(34) + '✗ 不是合法 UTF-8，跳过（不猜测编码）');
      continue;
    }
    fs.writeFileSync(p, Buffer.concat([BOM, body]));
    console.log('  ' + label.padEnd(34) + '已补 BOM（非 ASCII ' + nonAscii + ' 个）');
    fixed += 1;
  }
}

console.log('');
console.log('补 BOM: ' + fixed + ' 个，正常: ' + ok + ' 个');
if (fixed > 0) console.log('提示: 编辑 .ps1 的工具可能会去掉 BOM，改完重跑本脚本即可。');
