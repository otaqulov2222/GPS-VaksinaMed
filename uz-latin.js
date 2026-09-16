'use strict';
/**
 * Kirill ↔ lotin (UI + qidiruv).
 * GPS ichki nomlar o'zgarmaydi — faqat ko'rinish va solishtirish.
 */

const UZ_CYR_LAT = [
    ['Ў', "O'"], ['ў', "o'"],
    ['Қ', 'Q'], ['қ', 'q'],
    ['Ғ', "G'"], ['ғ', "g'"],
    ['Ҳ', 'H'], ['ҳ', 'h'],
    ['Ш', 'Sh'], ['ш', 'sh'],
    ['Ч', 'Ch'], ['ч', 'ch'],
    ['Ң', 'Ng'], ['ң', 'ng'],
    ['Ё', 'Yo'], ['ё', 'yo'],
    ['Ю', 'Yu'], ['ю', 'yu'],
    ['Я', 'Ya'], ['я', 'ya'],
    ['Ц', 'Ts'], ['ц', 'ts'],
    ['Ъ', "'"], ['ъ', "'"],
    ['Ь', ''], ['ь', ''],
    ['А', 'A'], ['а', 'a'],
    ['Б', 'B'], ['б', 'b'],
    ['В', 'V'], ['в', 'v'],
    ['Г', 'G'], ['г', 'g'],
    ['Д', 'D'], ['д', 'd'],
    ['Е', 'E'], ['е', 'e'],
    ['Ж', 'J'], ['ж', 'j'],
    ['З', 'Z'], ['з', 'z'],
    ['И', 'I'], ['и', 'i'],
    ['Й', 'Y'], ['й', 'y'],
    ['К', 'K'], ['к', 'k'],
    ['Л', 'L'], ['л', 'l'],
    ['М', 'M'], ['м', 'm'],
    ['Н', 'N'], ['н', 'n'],
    ['О', 'O'], ['о', 'o'],
    ['П', 'P'], ['п', 'p'],
    ['Р', 'R'], ['р', 'r'],
    ['С', 'S'], ['с', 's'],
    ['Т', 'T'], ['т', 't'],
    ['У', 'U'], ['у', 'u'],
    ['Ф', 'F'], ['ф', 'f'],
    ['Х', 'X'], ['х', 'x'],
    ['Щ', 'Sh'], ['щ', 'sh'],
    ['Ы', 'I'], ['ы', 'i'],
    ['Э', 'E'], ['э', 'e']
];

function uzLatin(s) {
    if (s == null || s === '') return '';
    let out = String(s);
    for (let i = 0; i < UZ_CYR_LAT.length; i++) {
        const pair = UZ_CYR_LAT[i];
        out = out.split(pair[0]).join(pair[1]);
    }
    return out;
}

/** UI matni — lotinda, ortiqcha bo'shliqsiz */
function uzUi(s) {
    return uzLatin(s).replace(/\s+/g, ' ').trim();
}

/**
 * Yagona qidiruv/moslashuv kaliti.
 * Kirill, lotin, rus, katta/kichik, chiziq/bo'shliq — bir xil natija.
 * Misollar: «Юнусобод - 7» ≡ «yunusobod 7» ≡ «ЮНУСОБОД7»
 */
function uzSearchFold(s) {
    let t = uzLatin(String(s == null ? '' : s)).toLowerCase();
    t = t.replace(/[ʼ'`´ʻʹʿ]/g, "'");
    t = t.replace(/o'\s*/g, 'o').replace(/g'\s*/g, 'g');
    // X/H chalkashuvi — ch/sh digraflarini saqlab
    t = t.replace(/sh/g, '\u0001').replace(/ch/g, '\u0002');
    t = t.replace(/h/g, 'x');
    t = t.replace(/\u0001/g, 'sh').replace(/\u0002/g, 'ch');
    // faqat harf+raqam
    t = t.replace(/[^a-z0-9]+/g, '');
    return t;
}

/** To'liq qidiruv: so'rov lotin yoki kirill — haystackda topiladi */
function uzSearchMatch(haystack, needle) {
    const q = uzSearchFold(needle);
    if (!q) return true;
    const h = uzSearchFold(haystack);
    if (h.indexOf(q) !== -1) return true;

    // So'zma-so'z: «yunusobod 7» → har bir bo'lak alohida ham topilsin
    const parts = uzLatin(String(needle || ''))
        .toLowerCase()
        .replace(/[ʼ'`´ʻʹʿ]/g, '')
        .split(/[^a-z0-9а-яёўқғҳ]+/i)
        .map(uzSearchFold)
        .filter(Boolean);
    if (parts.length > 1 && parts.every(p => h.indexOf(p) !== -1)) return true;

    const hSoft = uzLatin(String(haystack || ''))
        .toLowerCase()
        .replace(/[ʼ'`´ʻʹʿ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const qSoft = uzLatin(String(needle || ''))
        .toLowerCase()
        .replace(/[ʼ'`´ʻʹʿ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return !!(qSoft && hSoft.indexOf(qSoft) !== -1);
}

/** Ikki nom bir xil joy (biriktirish/dedupe) */
function uzNameEq(a, b) {
    const ka = uzSearchFold(a);
    const kb = uzSearchFold(b);
    return !!ka && ka === kb;
}

window.uzLatin = uzLatin;
window.uzUi = uzUi;
window.uzSearchFold = uzSearchFold;
window.uzSearchMatch = uzSearchMatch;
window.uzNameEq = uzNameEq;
