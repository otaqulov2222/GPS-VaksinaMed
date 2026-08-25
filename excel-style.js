/**
 * Umumiy Excel hisobot stili (xlsx-js-style).
 * Familiya/ustunlar matnga qarab kengayadi.
 */
(function (global) {
  'use strict';

  function thinBorder(rgb) {
    const edge = { style: 'thin', color: { rgb: rgb || '94A3B8' } };
    return { top: edge, bottom: edge, left: edge, right: edge };
  }

  function cellDisplayLen(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(String(Math.round(v * 100) / 100).length, 6);
    }
    const s = String(v);
    let len = s.length;
    // Kirill / keng harflar Excelda biroz kengroq
    if (/[А-Яа-яЁёЎўҚқҒғҲҳІі]/.test(s)) len = Math.ceil(len * 1.2);
    return len;
  }

  /** AOA dan ustun kengliklari — title qatori hisobga olinmaydi */
  function colWidthsFromAoa(aoa, opts) {
    const o = opts || {};
    const titleRow = o.titleRow;
    const minW = o.minWidths || [];
    const maxW = o.maxWidth != null ? o.maxWidth : 42;
    const pad = o.pad != null ? o.pad : 3;
    const hint = o.colWidths || [];
    let colCount = 0;
    (aoa || []).forEach(function (row) {
      if (row && row.length > colCount) colCount = row.length;
    });
    const widths = [];
    for (let c = 0; c < colCount; c++) {
      let max = Math.max(minW[c] || 6, hint[c] || 0);
      for (let r = 0; r < (aoa || []).length; r++) {
        if (titleRow != null && r === titleRow) continue;
        const row = aoa[r] || [];
        max = Math.max(max, cellDisplayLen(row[c]) + pad);
      }
      widths.push(Math.min(maxW, Math.max(minW[c] || 6, max)));
    }
    return widths;
  }

  function styleSheet(ws, opts) {
    if (!ws || !ws['!ref'] || typeof XLSX === 'undefined') return ws;
    const o = opts || {};
    const headerRow = o.headerRow != null ? o.headerRow : 0;
    const titleRow = o.titleRow;
    const numberCols = o.numberCols || [];
    const moneyCols = o.moneyCols || [];
    const centerCols = o.centerCols || [];
    const range = XLSX.utils.decode_range(ws['!ref']);
    const border = thinBorder('94A3B8');
    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11, name: 'Calibri' },
      fill: { patternType: 'solid', fgColor: { rgb: '0B1F3A' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: border
    };
    const titleStyle = {
      font: { bold: true, color: { rgb: '0B1F3A' }, sz: 13, name: 'Calibri' },
      fill: { patternType: 'solid', fgColor: { rgb: 'E2E8F0' } },
      alignment: { horizontal: 'left', vertical: 'center' },
      border: border
    };
    const baseFont = { sz: 10, name: 'Calibri', color: { rgb: '0F172A' } };
    const altFill = { patternType: 'solid', fgColor: { rgb: 'F8FAFC' } };

    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) ws[addr] = { t: 's', v: '' };
        const cell = ws[addr];
        if (titleRow != null && R === titleRow) {
          cell.s = titleStyle;
          continue;
        }
        if (R === headerRow) {
          cell.s = headerStyle;
          continue;
        }
        const s = {
          font: Object.assign({}, baseFont),
          alignment: { vertical: 'center' },
          border: border
        };
        if ((R - headerRow) % 2 === 0) s.fill = altFill;
        if (moneyCols.indexOf(C) >= 0 || numberCols.indexOf(C) >= 0) {
          s.alignment.horizontal = 'right';
          if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
            cell.t = 'n';
            cell.z = moneyCols.indexOf(C) >= 0 ? '#,##0.00' : '0.00';
          }
        } else if (centerCols.indexOf(C) >= 0 || C === 0) {
          s.alignment.horizontal = 'center';
        } else {
          s.alignment.horizontal = 'left';
        }
        cell.s = s;
      }
    }

    const widths = o.autoWidth === false && o.colWidths && o.colWidths.length
      ? o.colWidths
      : null;
    // autoWidth default: true — agar aoa berilgan bo'lsa
    if (widths) {
      ws['!cols'] = widths.map(function (w) { return { wch: w }; });
    } else if (o.aoa) {
      ws['!cols'] = colWidthsFromAoa(o.aoa, o).map(function (w) { return { wch: w }; });
    } else if (o.colWidths && o.colWidths.length) {
      ws['!cols'] = o.colWidths.map(function (w) { return { wch: w }; });
    }

    const rowsMeta = [];
    if (titleRow != null) rowsMeta[titleRow] = { hpt: 26 };
    rowsMeta[headerRow] = { hpt: 24 };
    ws['!rows'] = rowsMeta;
    if (o.freeze !== false) {
      const ySplit = headerRow + 1;
      ws['!freeze'] = {
        xSplit: 0,
        ySplit: ySplit,
        topLeftCell: XLSX.utils.encode_cell({ r: ySplit, c: 0 }),
        activePane: 'bottomLeft',
        state: 'frozen'
      };
    }
    if (titleRow != null && range.e.c > range.s.c) {
      ws['!merges'] = (ws['!merges'] || []).concat([{
        s: { r: titleRow, c: range.s.c },
        e: { r: titleRow, c: range.e.c }
      }]);
    }
    return ws;
  }

  function sheetFromAoa(aoa, styleOpts) {
    const opts = Object.assign({}, styleOpts || {}, { aoa: aoa });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    return styleSheet(ws, opts);
  }

  global.VmExcel = {
    styleSheet: styleSheet,
    sheetFromAoa: sheetFromAoa,
    colWidthsFromAoa: colWidthsFromAoa
  };

  // Orqaga moslik: fuel.js / journal.js eski nomlari
  global.styleExcelSheet = styleSheet;
  global.excelSheetFromAoa = sheetFromAoa;
})(typeof window !== 'undefined' ? window : globalThis);
