// 把用户提供的蓝色线稿位图预处理成能直接当图标的资源。
//
// 通用脚本：改 ICONS 表就能加/换图标，不用为每张图再写一个脚本。
// 每张图做四件事：裁掉四周留白 -> 白底转透明 -> 缩到 128px -> 内嵌成 data URL。
// 环境里没有 sharp/canvas 这类图像库，所以借无头 Edge（已开 CDP）里的 Canvas 来做。
//
// 两种 alpha 模式（关键差别，别混用）：
//   'chroma'    —— 按色度：蓝色描边色度高、白底和白填充色度低。
//                  适合「内部有白色填充」的插画（绵羊），能把羊身内部也抠成透明。
//   'luminance' —— 按亮度：白/浅灰 -> 透明，越深越不透明。
//                  适合纯线条图标（演讲台、放大镜），描边和抗锯齿边缘都保留。
//
// 用法：node tools/build-icon-assets.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 本脚本在 tools/ 下，但图标资源和生成物都在项目根，所以基准目录要上退一级。
// 注意：这行必须在 require('path') 之后，否则会报 "Cannot access 'path' before initialization"。
const ROOT = path.join(__dirname, '..');

const SHOTS = 'C:\\Users\\W\\Pictures\\Screenshots\\';

// key -> 配置。输出 assets/<key>.png，并把 data URL 汇进 icon-assets.js
const ICONS = {
  sheep: {
    src: SHOTS + '屏幕截图 2026-10-09 223935.png',
    alpha: 'chroma',
    // 绵羊专用脚本不再单独维护，这里接管；--sheep-only 可只重建它
    alsoWriteSheepIconJs: true
  },
  lectern: {
    src: SHOTS + '屏幕截图 2026-10-09 230642.png',
    alpha: 'luminance',
    // 演讲台是竖长的（332x596），而列表图标框是正方形。
    // 补成正方形画布、内容居中，这样和绵羊放在同样的 22px 框里时，
    // 各自的自然比例都能保住（否则 object-fit:contain 会把它压扁）。
    padToSquare: true
  },
  magnifier: {
    src: SHOTS + '屏幕截图 2026-10-09 230650.png',
    alpha: 'luminance',
    padToSquare: true
  }
};

const HEADER = [
  '// 本文件自动生成，请不要手改。',
  '// 内容：各图标位图预处理后的 data URL（裁白边 + 白底转透明 + 缩到 128px）。',
  '// 内嵌进 JS 是为了不发网络请求、也不怕文件路径变。',
  '// 重新生成请跑 build-icon-assets.js。',
  '// 着色由 index.html 里的 #sheepTint 滤镜完成（把图里的蓝映射成界面配色）。'
];

(async () => {
  const only = process.argv[2];
  const keys = Object.keys(ICONS).filter((k) => !only || k === only);
  for (const k of keys) {
    if (!fs.existsSync(ICONS[k].src)) { console.error('原图不存在:', ICONS[k].src); process.exit(1); }
  }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 20000 });
  const page = await browser.contexts()[0].newPage();
  await page.goto('about:blank');

  const results = {};

  for (const key of keys) {
    const cfg = ICONS[key];
    const buf = fs.readFileSync(cfg.src);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    console.log('--- ' + key + ' ---');
    console.log('  原图:', path.basename(cfg.src), '(' + (buf.length / 1024).toFixed(0) + ' KB)');

    const r = await page.evaluate(async ({ dataUrl, mode, padToSquare }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;

      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, W, H);
      const px = d.data;

      let minX = W, minY = H, maxX = -1, maxY = -1, opaque = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = (y * W + x) * 4;
          const r0 = px[i], g0 = px[i + 1], b0 = px[i + 2];
          let alpha;
          if (mode === 'chroma') {
            // 色度：蓝色描边高、白底/白填充低
            const chroma = Math.max(r0, g0, b0) - Math.min(r0, g0, b0);
            const lum = (r0 + g0 + b0) / 3;
            alpha = Math.max(0, Math.min(1, (chroma - 8) / 40));
            if (lum < 120) alpha = 1; // 深色像素一律保留，避免描边被吃掉
          } else {
            // 亮度：白/浅灰 -> 透明
            alpha = Math.max(0, Math.min(1, (255 - Math.min(r0, g0, b0)) / 255));
            if (alpha < 0.06) alpha = 0; // 掐掉极浅的背景噪点
          }
          px[i + 3] = Math.round(alpha * 255);
          if (alpha > 0.5) {
            opaque += 1;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      ctx.putImageData(d, 0, 0);
      if (maxX < 0) return { error: '没有检测到不透明像素' };

      const pad = 2;
      const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
      const cw = Math.min(W - cx, (maxX - minX + 1) + pad * 2);
      const ch = Math.min(H - cy, (maxY - minY + 1) + pad * 2);

      const out = document.createElement('canvas');
      const side = 128;
      // padToSquare：把裁切框先扩成正方形（内容保持居中），再缩到 side x side。
      // 这样输出的图内容比例不变，只是四周多了透明留白。
      let scx = cx, scy = cy, scw = cw, sch = ch;
      if (padToSquare) {
        const sd = Math.max(cw, ch);
        scx = cx - (sd - cw) / 2;
        scy = cy - (sd - ch) / 2;
        scw = sd; sch = sd;
      }
      out.width = side; out.height = side;
      const octx = out.getContext('2d');
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      // 非正方形时才做 contain 缩放（正方形下 scale 就是 side/sd，等价于铺满）
      const scale = padToSquare ? side / scw : Math.min(side / scw, side / sch);
      const dw = scw * scale, dh = sch * scale;
      octx.drawImage(c, scx, scy, scw, sch, (side - dw) / 2, (side - dh) / 2, dw, dh);

      return {
        original: { W, H }, bbox: { x: cx, y: cy, w: cw, h: ch },
        squared: padToSquare ? scw : null, opaque,
        dataUrl: out.toDataURL('image/png')
      };
    }, { dataUrl, mode: cfg.alpha, padToSquare: Boolean(cfg.padToSquare) });

    if (r.error) { console.error('  处理失败:', r.error); process.exit(1); }
    console.log('  原图尺寸:', r.original.W + 'x' + r.original.H,
      ' 裁切:', r.bbox.w + 'x' + r.bbox.h,
      r.squared ? ' 补正方形: ' + r.squared + 'x' + r.squared : '',
      ' 不透明像素:', r.opaque);

    const outPng = path.join(ROOT, 'assets', key + '.png');
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    const outBuf = Buffer.from(r.dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(outPng, outBuf);
    console.log('  输出:', 'assets/' + key + '.png', (outBuf.length / 1024).toFixed(1) + ' KB');

    results[key] = r.dataUrl;
  }

  await page.close();
  await browser.close();

  // 汇总写出 icon-assets.js
  const lines = HEADER.slice();
  lines.push('window.__ICON_ASSETS = {');
  for (const [k, v] of Object.entries(results)) {
    lines.push('  ' + k + ": '" + v + "',");
  }
  lines.push('};');
  fs.writeFileSync(path.join(ROOT, 'icon-assets.js'), lines.join('\n') + '\n', 'utf8');
  console.log('');
  console.log('已写出 icon-assets.js:', (fs.statSync('icon-assets.js').size / 1024).toFixed(1) + ' KB',
    ' 含图标:', Object.keys(results).join(', '));

  // 兼容：绵羊还要单独出一份 sheep-icon.js（侧边栏 bootstrap 在用）
  if (results.sheep) {
    const sheepHeader = [
      '// 本文件自动生成，请不要手改。',
      '// 来源：用户提供的蓝色绵羊线稿位图（屏幕截图 2026-10-09 223935.png）。',
      '// 处理：裁掉四周留白 -> 白底转透明（按色度）-> 缩到 128px -> 内嵌为 data URL。',
      '// 重新生成请跑 build-icon-assets.js sheep。',
      'window.__SHEEP_ICON_URL = '
    ].join('\n');
    fs.writeFileSync(path.join(ROOT, 'sheep-icon.js'), sheepHeader + "'" + results.sheep + "';\n", 'utf8');
    console.log('已写出 sheep-icon.js:', (fs.statSync('sheep-icon.js').size / 1024).toFixed(1) + ' KB');
  }
})().catch((e) => { console.error('DIAG ERROR:', e.message); process.exit(1); });
