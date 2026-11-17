/**
 * fuel.js HAQIQIY parseWaybillAoa — Oktabr Excel barcha mashina vs ЖАМИ
 * (hard: gaz/benzin/km/odo). Excel: scripts/_oct2026.xlsx (gitignore).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const XLSX = require('xlsx');

const root = path.join(__dirname, '..');
const fuelSrc = fs.readFileSync(path.join(root, 'fuel.js'), 'utf8');
const xlsxPath = path.join(root, 'scripts', '_oct2026.xlsx');
const outPath = path.join(__dirname, 'fuel_js_waybill_oct_out.json');

if (!fs.existsSync(xlsxPath)) {
  console.error('SKIP: scripts/_oct2026.xlsx yo\'q');
  process.exit(0);
}

const helpers = fuelSrc.slice(
  fuelSrc.indexOf('function n(v) {'),
  fuelSrc.indexOf('function fmtNum(v) {')
);
const i0 = fuelSrc.indexOf('const CYR_MONTHS = {');
const i1 = fuelSrc.indexOf('\nfunction parseKunlikAoa(');
if (i0 < 0 || i1 < 0) {
  console.error('fuel.js markers not found', i0, i1);
  process.exit(2);
}

const prelude =
  helpers +
  '\nconst STATE={meta:{vehicles:{},stations:[]},cars:{},month:"2026-10"};' +
  'const DEFAULT_FLEET=[];' +
  'function plateCompact(p){return String(p||"").toUpperCase().replace(/[^A-Z0-9А-ЯЁЎҚҒҲ]/gi,"");}' +
  'function formatPlateInput(p){return String(p||"").trim();}' +
  'function canonicalPlate(p){return formatPlateInput(p);}\n';

const ctx = { console, XLSX };
vm.createContext(ctx);
vm.runInContext(
  prelude +
    fuelSrc.slice(i0, i1) +
    '\nthis.parseWaybillAoa=parseWaybillAoa;this.isWaybillSheet=isWaybillSheet;' +
    'this.SKIP_SHEET_RE=SKIP_SHEET_RE;this.sheetToAoa=sheetToAoa;this.n=n;this.cleanFloat=cleanFloat;',
  ctx
);

const wb = XLSX.readFile(xlsxPath);
const report = [];
let ok = 0;
let bad = 0;
let skip = 0;

for (const name of wb.SheetNames) {
  if (ctx.SKIP_SHEET_RE.test(name) || !/\d{3}/.test(name)) {
    skip += 1;
    continue;
  }
  const aoa = ctx.sheetToAoa(wb.Sheets[name]);
  if (!ctx.isWaybillSheet(aoa)) {
    report.push({ sheet: name, status: 'skip-not-waybill' });
    skip += 1;
    continue;
  }
  const parsed = ctx.parseWaybillAoa(aoa, {});
  if (!parsed) {
    report.push({ sheet: name, status: 'parse-null' });
    bad += 1;
    continue;
  }
  let sumKm = 0;
  let sumGas = 0;
  let sumBen = 0;
  Object.values(parsed.days || {}).forEach((d) => {
    sumKm += ctx.n(d.km);
    sumGas += ctx.n(d.gasIn);
    sumBen += ctx.n(d.benzinIn);
  });
  const jami = parsed.meta && parsed.meta.jami;
  if (!jami || !jami.rows || !jami.rows.length) {
    report.push({
      sheet: name,
      status: 'ok-no-jami',
      days: Object.keys(parsed.days).length,
      sumKm,
      sumGas,
      sumBen
    });
    ok += 1;
    continue;
  }
  const hardDiffs = (jami.diffs || []).filter(
    (d) =>
      d.hard === true ||
      ['gasIn', 'benzinIn', 'gasKm', 'benKm', 'odoEnd'].includes(d.k)
  );
  if (!jami.ok || hardDiffs.length) {
    report.push({
      sheet: name,
      status: 'BAD',
      days: Object.keys(parsed.days).length,
      sumKm,
      sumGas,
      sumBen,
      diffs: hardDiffs.length ? hardDiffs : jami.diffs
    });
    bad += 1;
  } else {
    report.push({
      sheet: name,
      status: 'OK',
      days: Object.keys(parsed.days).length,
      sumKm,
      sumGas,
      sumBen,
      soft: (jami.softDiffs || []).length
    });
    ok += 1;
  }
}

const out = { ok, bad, skip, report };
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      ok,
      bad,
      skip,
      fails: report.filter((r) => r.status === 'BAD' || r.status === 'parse-null')
    },
    null,
    2
  )
);
process.exit(bad ? 1 : 0);
