/**
 * QR skaner regressiya — kamera 1× kadr simulatsiyasi (markaz crop + jsQR).
 * Run: node tests/test_qr_scan_decode.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OFD =
  'https://ofd.soliq.uz/check?t=LG420211628460&r=75947&c=20261111200441&s=223241506405';

function parseOfdLike(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  const host = String(u.hostname || '').replace(/^www\./i, '').toLowerCase();
  const t = (u.searchParams.get('t') || '').trim();
  const r = (u.searchParams.get('r') || '').trim();
  const c = (u.searchParams.get('c') || '').trim();
  const sig = (u.searchParams.get('s') || '').trim();
  const ofd = /ofd\.soliq|fact\.soliq|new-ofd|my\.soliq/.test(host) || (t && r && c && sig);
  if (!ofd) return null;
  return { t, r, c, sig, qr: s };
}

function pngToRgba(buf) {
  const png = PNG.sync.read(buf);
  return { data: png.data, width: png.width, height: png.height };
}

function decode(rgba) {
  const r = jsQR(rgba.data, rgba.width, rgba.height, { inversionAttempts: 'attemptBoth' });
  return r && r.data ? String(r.data).trim() : '';
}

/** 1280×720 kamera kadriga QR joylash (1× preview) */
function placeOnFrame(srcPng, frameW, frameH, qrSize, cxRatio, cyRatio) {
  const src = PNG.sync.read(srcPng);
  const out = new PNG({ width: frameW, height: frameH });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 245;
    out.data[i + 1] = 245;
    out.data[i + 2] = 245;
    out.data[i + 3] = 255;
  }
  const ox = Math.max(0, Math.min(frameW - qrSize, Math.floor(frameW * cxRatio - qrSize / 2)));
  const oy = Math.max(0, Math.min(frameH - qrSize, Math.floor(frameH * cyRatio - qrSize / 2)));
  for (let y = 0; y < qrSize; y++) {
    for (let x = 0; x < qrSize; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x / qrSize) * src.width));
      const sy = Math.min(src.height - 1, Math.floor((y / qrSize) * src.height));
      const si = (src.width * sy + sx) << 2;
      const di = (out.width * (oy + y) + (ox + x)) << 2;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return { data: out.data, width: out.width, height: out.height, ox, oy, qrSize };
}

/** decodeFrameQr markaz crop mantiqi */
function centerCropDecode(frame, f) {
  const side = Math.min(frame.width, frame.height) * f;
  const sx = Math.max(0, Math.min(frame.width - side, frame.width * 0.5 - side / 2));
  const sy = Math.max(0, Math.min(frame.height - side, frame.height * 0.5 - side / 2));
  const outW = 560;
  const outH = 560;
  const out = new PNG({ width: outW, height: outH });
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const fx = Math.min(frame.width - 1, Math.floor(sx + (x / outW) * side));
      const fy = Math.min(frame.height - 1, Math.floor(sy + (y / outH) * side));
      const si = (frame.width * fy + fx) << 2;
      const di = (outW * y + x) << 2;
      out.data[di] = frame.data[si];
      out.data[di + 1] = frame.data[si + 1];
      out.data[di + 2] = frame.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return decode({ data: out.data, width: outW, height: outH });
}

function assertNoBadCameraCode() {
  const js = fs.readFileSync(path.join(ROOT, 'cheks.js'), 'utf8');
  assert.ok(!/zMax - zMin\) \* 0\.3/.test(js), 'raqamli zoom foizi qolgan');
  assert.ok(!/zoom tebranadi/.test(js), 'zoom hunt qolgan');
  assert.ok(!/ideal: 1920/.test(js), '1920 telefoto xavfi');
  assert.ok(/ideal: 1280/.test(js), '1280 yo‘q');
  assert.ok(/selfTestDecoder/.test(js), 'selfTestDecoder yo‘q');
  assert.ok(/Native \+ lokal jsQR|startNativeCamera/.test(js), 'native yo‘l yo‘q');
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'jsQR.min.js')), 'vendor jsQR yo‘q');
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'html5-qrcode.min.js')), 'vendor html5-qrcode yo‘q');
  assert.ok(fs.statSync(path.join(ROOT, 'vendor', 'html5-qrcode.min.js')).size > 100000, 'html5-qrcode kichik');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!/25–40|25-40|15–25|15-25/.test(html), 'sm masofa matni qolgan');
  assert.ok(/object-fit:\s*cover/.test(html), 'object-fit cover kerak');
  assert.ok(!/#chek-scan-cam video, #chek-scan-cam canvas/.test(html), 'canvas CSS hali buzadi');
  assert.ok(/vendor\/jsQR\.min\.js/.test(html), 'jsQR preload yo‘q');
  assert.ok(/vendor\/html5-qrcode\.min\.js/.test(html), 'html5 preload yo‘q');
  assert.ok(/#chek-scan-frame/.test(html), 'QR moslashuvchi ramka CSS yo‘q');
  assert.ok(/snapScanFrameToQr|ensureScanFrame/.test(js), 'ramka moslashuv funksiyasi yo‘q');
}

async function main() {
  const vendor = path.join(ROOT, 'vendor', 'jsQR.min.js');
  assert.ok(fs.existsSync(vendor), 'vendor/jsQR.min.js yo‘q');
  assert.ok(fs.statSync(vendor).size > 10000, 'vendor/jsQR.min.js juda kichik');
  assertNoBadCameraCode();

  const png = await QRCode.toBuffer(OFD, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 280,
    color: { dark: '#000000', light: '#ffffff' }
  });

  for (let round = 1; round <= 3; round++) {
    const direct = decode(pngToRgba(png));
    assert.strictEqual(direct, OFD, 'round ' + round + ' direct decode');
    const parsed = parseOfdLike(direct);
    assert.ok(parsed && parsed.r === '75947', 'round ' + round + ' parse');

    // Standart telefon masofasi: QR kadrning ~22–35% i
    const cases = [
      { w: 1280, h: 720, qr: 260, x: 0.5, y: 0.5, label: 'markaz-normal' },
      { w: 1280, h: 720, qr: 200, x: 0.5, y: 0.55, label: 'markaz-kichik' },
      { w: 1280, h: 720, qr: 180, x: 0.5, y: 0.68, label: 'past-chek' },
      { w: 1920, h: 1080, qr: 240, x: 0.5, y: 0.5, label: '1080p-markaz' }
    ];
    for (const c of cases) {
      const frame = placeOnFrame(png, c.w, c.h, c.qr, c.x, c.y);
      let hit = decode(frame);
      if (!hit) hit = centerCropDecode(frame, 0.68);
      if (!hit) hit = centerCropDecode(frame, 0.55);
      assert.strictEqual(hit, OFD, 'round ' + round + ' ' + c.label + ' o‘qilmadi');
    }
  }

  console.log('OK test_qr_scan_decode: 3× round, 1× kamera kadr + crop o‘tdi');
}

main().catch((e) => {
  console.error('FAIL', e && e.message ? e.message : e);
  process.exit(1);
});
