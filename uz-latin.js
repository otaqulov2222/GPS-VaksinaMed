'use strict';
/** Kirill → o'zbek lotin (UI ko'rinishi). Ichki GPS moslashuvi o'zgarmaydi. */

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

window.uzLatin = uzLatin;
window.uzUi = uzUi;
