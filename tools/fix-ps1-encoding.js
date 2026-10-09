// 确保 scripts/ 下含非 ASCII 的 .ps1 都带 UTF-8 BOM。
// 可重复运行；每次都重新检查，所以编辑过文件后重跑一次即可。
const fs = require('fs');
const path = require('path');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// 本脚本在 tools/ 下，所以要上退一级才是项目根。
const dir = path.join(__dirname, '..', 'scripts');
let fixed = 0;
let ok = 0;

for (const f of fs.readdirSync(dir).sort()) {
  if (!f.toLowerCase().endsWith('.ps1')) continue;
  const p = path.join(dir, f);
  const b = fs.readFileSync(p);
  const hasBom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const body = hasBom ? b.slice(3) : b;

  let nonAscii = 0;
  for (const x of body) if (x > 127) nonAscii += 1;

  if (nonAscii === 0) { console.log('  ' + f.padEnd(30) + '纯 ASCII，PS 5.1 读它没问题'); ok += 1; continue; }
  if (hasBom) { console.log('  ' + f.padEnd(30) + 'UTF-8 + BOM ✓'); ok += 1; continue; }

  try { new TextDecoder('utf-8', { fatal: true }).decode(body); } catch (e) {
    console.log('  ' + f.padEnd(30) + '✗ 不是合法 UTF-8，跳过（不猜测编码）');
    continue;
  }
  fs.writeFileSync(p, Buffer.concat([BOM, body]));
  console.log('  ' + f.padEnd(30) + '已补 BOM（非 ASCII ' + nonAscii + ' 个）');
  fixed += 1;
}

console.log('');
console.log('补 BOM: ' + fixed + ' 个，正常: ' + ok + ' 个');
if (fixed > 0) console.log('提示: 编辑 .ps1 的工具可能会去掉 BOM，改完重跑本脚本即可。');
