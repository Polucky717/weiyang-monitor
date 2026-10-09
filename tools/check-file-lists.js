// 核对两个发布工具的 FILES 清单是否一致、且磁盘上都存在。
const fs = require('fs');
const path = require('path');

function extract(file) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('const FILES = [');
  if (start < 0) throw new Error('找不到 FILES: ' + file);
  const end = src.indexOf('];', start);
  const body = src.slice(start, end);
  const list = [];
  for (const m of body.matchAll(/'([^']+)'/g)) list.push(m[1]);
  return list;
}

const a = extract(path.join(__dirname, 'build-release-zip.js'));
const b = extract(path.join(__dirname, 'publish-to-github.js'));

console.log('build-release-zip.js : ' + a.length + ' 项');
console.log('publish-to-github.js : ' + b.length + ' 项');
console.log('');

const sa = new Set(a);
const sb = new Set(b);
const onlyA = a.filter((x) => !sb.has(x));
const onlyB = b.filter((x) => !sa.has(x));
console.log('只在 build 里: ' + (onlyA.length ? onlyA.join(', ') : '无'));
console.log('只在 publish 里: ' + (onlyB.length ? onlyB.join(', ') : '无'));
console.log('两者一致: ' + (onlyA.length === 0 && onlyB.length === 0 && a.length === b.length));
console.log('顺序一致: ' + (JSON.stringify(a) === JSON.stringify(b)));
console.log('');

console.log('=== 磁盘存在性 ===');
const missing = [];
for (const rel of a) {
  const p = path.join(__dirname, '..', rel);
  if (!fs.existsSync(p)) missing.push(rel);
}
console.log('缺失文件: ' + (missing.length ? missing.join(', ') : '无（全部存在）'));
if (missing.length) process.exit(1);
