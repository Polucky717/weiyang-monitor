// 打包 GitHub 发布用的 zip。
// 用 System.IO.Compression 直接在 Node 里做，关键点：
//   1. 条目路径必须用【正斜杠】——ZipFile.CreateFromDirectory 在 Windows 上写的是
//      反斜杠，Linux/GitHub 解压会变成一个名字里带 "\" 的怪文件。
//   2. 技能包里的 .ps1 含中文，必须保留 UTF-8 BOM，否则 Windows PowerShell 5.1
//      会按 GBK 解码导致乱码；这里按字节复制，不做任何编码转换。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 本脚本在 tools/ 下，打包目标是项目根，所以基准目录要上退一级。
const ROOT = path.join(__dirname, '..');
const INNER = 'weiyangchengzhang-monitor';   // zip 内的顶层目录名（与旧包一致）
// 默认输出名；可用命令行第一个参数覆盖（例如先出到临时名再替换，避免覆盖被占用）
const OUT = path.join(ROOT, process.argv[2] || 'weiyang-monitor-github.zip');

// 要打包的文件（相对项目根，正斜杠）。运行时产物、登录态、备份、日志一律排除。
const FILES = [
  // 根目录入口（保持平铺：用户从这里双击 / 执行 npm）
  '.gitignore',
  'README.md',
  'package.json',
  'package-lock.json',
  'run-monitor.cmd',
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
  'tools/install-autostart.js',
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

// —— 极简 zip 写入器（store / deflate），只为完全控制条目名 ——
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const entries = [];
for (const rel of FILES) {
  const abs = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(abs)) { console.error('缺少文件:', rel); process.exit(1); }
  const data = fs.readFileSync(abs);           // 按字节读，BOM 原样保留
  const name = INNER + '/' + rel;              // 正斜杠
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  // 压缩后没变小就用 store
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  entries.push({
    name,
    nameBuf: Buffer.from(name, 'utf8'),
    body,
    crc: crc32(data),
    usize: data.length,
    csize: body.length,
    method: useDeflate ? 8 : 0,
    mtime: fs.statSync(abs).mtime
  });
}

function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { time, date };
}

const chunks = [];
const central = [];
let offset = 0;

for (const e of entries) {
  const { time, date } = dosTime(e.mtime);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);              // version needed
  local.writeUInt16LE(0x0800, 6);          // flag: 文件名是 UTF-8
  local.writeUInt16LE(e.method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(e.crc, 14);
  local.writeUInt32LE(e.csize, 18);
  local.writeUInt32LE(e.usize, 22);
  local.writeUInt16LE(e.nameBuf.length, 26);
  local.writeUInt16LE(0, 28);              // extra 长度
  chunks.push(local, e.nameBuf, e.body);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);                 // version made by
  cd.writeUInt16LE(20, 6);                 // version needed
  cd.writeUInt16LE(0x0800, 8);             // flag: UTF-8
  cd.writeUInt16LE(e.method, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(e.crc, 16);
  cd.writeUInt32LE(e.csize, 20);
  cd.writeUInt32LE(e.usize, 24);
  cd.writeUInt16LE(e.nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);                 // extra
  cd.writeUInt16LE(0, 32);                 // comment
  cd.writeUInt16LE(0, 34);                 // disk number
  cd.writeUInt16LE(0, 36);                 // internal attrs
  cd.writeUInt32LE(0, 38);                 // external attrs
  cd.writeUInt32LE(offset, 42);
  central.push(cd, e.nameBuf);

  offset += local.length + e.nameBuf.length + e.body.length;
}

const cdBuf = Buffer.concat(central);
const cdOffset = offset;
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cdBuf.length, 12);
end.writeUInt32LE(cdOffset, 16);
end.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([...chunks, cdBuf, end]));

console.log('已写出 ' + path.basename(OUT) + ': ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
console.log('条目数: ' + entries.length + '  顶层目录: ' + INNER + '/');
console.log('');
console.log('条目名（确认全部是正斜杠）:');
entries.forEach((e) => console.log('  ' + e.name + '  ' + e.usize + 'B' + (e.method === 8 ? '' : '  [未压缩]')));
