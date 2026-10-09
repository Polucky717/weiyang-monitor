// 核对所有位图/矢量图标：尺寸、着色后的最深色、以及陈旧元素是否清干净。
const { chromium } = require('playwright');
const fs = require('fs');
const zlib = require('zlib');

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const t = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : 3;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y += 1) {
    const ft = raw[rp]; rp += 1;
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

function analyze(file, bg) {
  const { w, h, ch, data } = decodePng(fs.readFileSync(file));
  let ink = 0, dark = 999, darkest = null;
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) {
      ink += 1;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < dark) { dark = lum; darkest = [r, g, b]; }
    }
  }
  return {
    coverage: +(ink / (w * h) * 100).toFixed(1),
    darkest: darkest ? '#' + darkest.map((v) => v.toString(16).padStart(2, '0')).join('') : 'n/a'
  };
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 20000 });
  const page = await browser.contexts()[0].newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url().slice(0, 70)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 140)); });

  await page.setViewportSize({ width: 1440, height: 900, deviceScaleFactor: 4 });
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3500);

  const meta = await page.evaluate(() => {
    const out = { rows: [], leftovers: {} };
    document.querySelectorAll('.activity-row').forEach((row) => {
      const icon = row.querySelector('.activity-icon');
      const img = icon.querySelector('img.tinted-icon');
      const svg = icon.querySelector('svg');
      const el = img || svg;
      const tag = row.querySelector('.tag');
      out.rows.push({
        section: tag ? tag.textContent.trim() : '?',
        kind: img ? '位图(' + (img.getAttribute('src') || '').slice(0, 22) + '…)' : '矢量',
        box: Math.round(icon.getBoundingClientRect().width),
        el: +el.getBoundingClientRect().width.toFixed(1),
        filter: getComputedStyle(el).filter
      });
    });
    const mag = document.getElementById('settingsIcon');
    out.magnifier = mag ? {
      present: true,
      hasSrc: (mag.getAttribute('src') || '').startsWith('data:image/png'),
      size: +mag.getBoundingClientRect().width.toFixed(1),
      box: Math.round(document.querySelector('.settings-icon').getBoundingClientRect().width),
      filter: getComputedStyle(mag).filter
    } : { present: false };
    out.leftovers = {
      searchIconEl: document.querySelectorAll('.search-icon').length,
      sheepIconClass: document.querySelectorAll('img.sheep-icon').length,
      tintedIconClass: document.querySelectorAll('img.tinted-icon').length
    };
    out.assets = Object.keys(window.__ICON_ASSETS || {});
    return out;
  });

  console.log('=== 活动列表图标 ===');
  for (const r of meta.rows) {
    const f = 'tmp-i.png';
    await page.locator('.activity-row').nth(meta.rows.indexOf(r)).locator('.activity-icon').screenshot({ path: f });
    const st = analyze(f, [237, 241, 255]);
    fs.unlinkSync(f);
    console.log('  ' + r.section.padEnd(8) + r.kind.padEnd(28) + ' 框 ' + r.box + 'px  元素 '
      + String(r.el).padStart(4) + 'px  覆盖率 ' + String(st.coverage).padStart(5) + '%  最深 ' + st.darkest);
  }
  console.log('');
  console.log('=== 自动监测栏放大镜 ===');
  console.log('  ' + JSON.stringify(meta.magnifier));
  if (meta.magnifier.present && meta.magnifier.hasSrc) {
    await page.locator('.settings-icon').screenshot({ path: 'tmp-m.png' });
    console.log('  渲染统计: ' + JSON.stringify(analyze('tmp-m.png', [241, 243, 255])));
    fs.unlinkSync('tmp-m.png');
  }
  console.log('');
  console.log('=== 清理核对 ===');
  console.log('  .search-icon 元素残留: ' + meta.leftovers.searchIconEl + '（应为 0）');
  console.log('  img.sheep-icon 残留: ' + meta.leftovers.sheepIconClass + '（应为 0，已改名 tinted-icon）');
  console.log('  img.tinted-icon 总数: ' + meta.leftovers.tintedIconClass + '（列表 2 + 侧边栏 1 + 放大镜 1 = 4）');
  console.log('  __ICON_ASSETS 含: ' + meta.assets.join(', '));
  console.log('  页面错误: ' + (errors.length ? errors.slice(0, 4).join(' | ') : '无'));

  await page.close();
  await browser.close();
})().catch((e) => { console.error('DIAG ERROR:', e.message); process.exit(1); });
