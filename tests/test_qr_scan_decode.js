/**
 * QR skaner regressiya: OFD havolani QR qilib chizadi va jsQR bilan o‘qiydi.
 * iPhone yo‘li (BarcodeDetector yo‘q) shu decode’ga tayanadi.
 *
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

/** Kameradagi kichik QR + atrof oq fon (markaz crop simulatsiya) */
function padOnCanvas(srcPng, canvasSize, qrSize) {
  const src = PNG.sync.read(srcPng);
  const out = new PNG({ width: canvasSize, height: canvasSize });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 255;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  // nearest-neighbor scale src -> qrSize
  const ox = Math.floor((canvasSize - qrSize) / 2);
  const oy = Math.floor((canvasSize - qrSize) / 2);
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
  return { data: out.data, width: out.width, height: out.height };
}

async function main() {
  const vendor = path.join(ROOT, 'vendor', 'jsQR.min.js');
  assert.ok(fs.existsSync(vendor), 'vendor/jsQR.min.js yo‘q');
  assert.ok(fs.statSync(vendor).size > 10000, 'vendor/jsQR.min.js juda kichik');

  const png = await QRCode.toBuffer(OFD, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 280,
    color: { dark: '#000000', light: '#ffffff' }
  });

  const direct = decode(pngToRgba(png));
  assert.strictEqual(direct, OFD, 'To‘g‘ridan-to‘g‘ri decode OFD URL bermadi');
  const parsed = parseOfdLike(direct);
  assert.ok(parsed, 'parseOfdLike null');
  assert.strictEqual(parsed.t, 'LG420211628460');
  assert.strictEqual(parsed.r, '75947');
  assert.strictEqual(parsed.sig, '223241506405');

  // Telefon: QR kadrning markazida kichik
  const padded = padOnCanvas(png, 720, 220);
  const mid = decode(padded);
  assert.strictEqual(mid, OFD, 'Markazdagi kichik QR o‘qilmadi (kamera simulatsiya)');

  // Juda kichik QR (uzoqroq tutish)
  const far = padOnCanvas(png, 720, 140);
  const farHit = decode(far);
  assert.strictEqual(farHit, OFD, 'Uzoqroq (140px) QR o‘qilmadi');

  console.log('OK test_qr_scan_decode: OFD QR decode + markaz/uzoq simulatsiya o‘tdi');
}

main().catch((e) => {
  console.error('FAIL', e && e.message ? e.message : e);
  process.exit(1);
});
