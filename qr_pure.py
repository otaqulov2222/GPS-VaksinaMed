# Minimal offline QR (byte mode, ECC-M, mask 0) + PNG — tashqi paket kerak emas.
# Ofis QR plakat uchun (qisqa payload, versiya 2–4, bitta RS blok).

from __future__ import annotations

import struct
import zlib


_EXP = [0] * 512
_LOG = [0] * 256


def _init_gf():
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_init_gf()


def _gf_mul(a, b):
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _poly_mul(p, q):
    r = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        for j, b in enumerate(q):
            r[i + j] ^= _gf_mul(a, b)
    return r


def _rs_generator(nsym):
    g = [1]
    for i in range(nsym):
        g = _poly_mul(g, [1, _EXP[i]])
    return g


def _rs_encode(data, nsym):
    gen = _rs_generator(nsym)
    out = data[:] + [0] * nsym
    for i in range(len(data)):
        coef = out[i]
        if coef:
            for j in range(len(gen)):
                out[i + j] ^= _gf_mul(gen[j], coef)
    return out[-nsym:]


# ver: (modules, data_codewords, ecc_codewords) — faqat 1 ta RS blok (v2–4 M)
_VER_M = {
    2: (25, 28, 16),
    3: (29, 44, 26),
    4: (33, 64, 36),
}

# Alignment center (row=col) for versions 2–4
_ALIGN = {2: 18, 3: 22, 4: 26}


def _bitbuf():
    return {"bits": [], "bytes": []}


def _put(buf, val, length):
    for i in range(length - 1, -1, -1):
        buf["bits"].append((val >> i) & 1)
        if len(buf["bits"]) == 8:
            v = 0
            for b in buf["bits"]:
                v = (v << 1) | b
            buf["bytes"].append(v)
            buf["bits"] = []


def _flush(buf):
    if buf["bits"]:
        while len(buf["bits"]) < 8:
            buf["bits"].append(0)
        v = 0
        for b in buf["bits"]:
            v = (v << 1) | b
        buf["bytes"].append(v)
        buf["bits"] = []


def _choose_version(nbytes):
    # byte mode: 4 + 8 + nbytes*8 (+ terminator up to 4)
    need_bytes = (4 + 8 + nbytes * 8 + 4 + 7) // 8
    for ver in sorted(_VER_M):
        _size, data_cw, _ecc = _VER_M[ver]
        if data_cw >= need_bytes:
            return ver
    raise ValueError("QR payload juda uzun (maks ~50 bayt)")


def _encode_data(text: str, ver: int):
    raw = text.encode("utf-8")
    _size, data_cw, ecc_cw = _VER_M[ver]
    buf = _bitbuf()
    _put(buf, 0b0100, 4)  # byte mode
    _put(buf, len(raw), 8)  # char count (v1–9)
    for b in raw:
        _put(buf, b, 8)
    rem_bits = data_cw * 8 - len(buf["bytes"]) * 8 - len(buf["bits"])
    _put(buf, 0, min(4, rem_bits))
    _flush(buf)
    data = buf["bytes"]
    pad = [0xEC, 0x11]
    i = 0
    while len(data) < data_cw:
        data.append(pad[i % 2])
        i += 1
    data = data[:data_cw]
    ecc = _rs_encode(data, ecc_cw)
    return data + ecc, _VER_M[ver][0]


def _place_finders(mat, n):
    def place(ox, oy):
        for dy in range(-1, 8):
            for dx in range(-1, 8):
                x, y = ox + dx, oy + dy
                if not (0 <= x < n and 0 <= y < n):
                    continue
                if dx == -1 or dy == -1 or dx == 7 or dy == 7:
                    mat[y][x] = 0
                elif dx in (0, 6) or dy in (0, 6) or (2 <= dx <= 4 and 2 <= dy <= 4):
                    mat[y][x] = 1
                else:
                    mat[y][x] = 0

    place(0, 0)
    place(n - 7, 0)
    place(0, n - 7)


def _place_timing(mat, n):
    for i in range(8, n - 8):
        v = 1 if i % 2 == 0 else 0
        if mat[6][i] is None:
            mat[6][i] = v
        if mat[i][6] is None:
            mat[i][6] = v


def _place_alignment(mat, n, ver):
    c = _ALIGN.get(ver)
    if c is None:
        return
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            x, y = c + dx, c + dy
            if mat[y][x] is not None:
                continue
            if abs(dx) == 2 or abs(dy) == 2 or (dx == 0 and dy == 0):
                mat[y][x] = 1
            else:
                mat[y][x] = 0


def _place_dark(mat, n):
    # Dark module: (8, 4*ver+9) ≡ (8, n-8)
    mat[n - 8][8] = 1


def _reserve_format(mat, n):
    for i in range(9):
        if i != 6:
            if mat[8][i] is None:
                mat[8][i] = False  # reserved marker (overwritten later)
            if mat[i][8] is None:
                mat[i][8] = False
    for i in range(8):
        if mat[8][n - 1 - i] is None:
            mat[8][n - 1 - i] = False
        if mat[n - 1 - i][8] is None:
            mat[n - 1 - i][8] = False


def _fill_data(mat, n, codewords):
    bits = []
    for b in codewords:
        for i in range(7, -1, -1):
            bits.append((b >> i) & 1)
    idx = 0
    col = n - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(n - 1, -1, -1) if upward else range(0, n)
        for row in rows:
            for c in (col, col - 1):
                if mat[row][c] is not None:
                    continue
                bit = bits[idx] if idx < len(bits) else 0
                idx += 1
                # mask 0
                if (row + c) % 2 == 0:
                    bit ^= 1
                mat[row][c] = bit
        col -= 2
        upward = not upward


def _format_bits(mask=0):
    # ECC-M = 00
    data = (0b00 << 3) | (mask & 7)
    rem = data << 10
    poly = 0b10100110111
    for i in range(14, 9, -1):
        if rem & (1 << i):
            rem ^= poly << (i - 10)
    return ((data << 10) | rem) ^ 0b101010000010010


def _place_format(mat, n, bits):
    coords_a = [
        (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
        (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8),
    ]
    coords_b = [
        (n - 1, 8), (n - 2, 8), (n - 3, 8), (n - 4, 8), (n - 5, 8), (n - 6, 8), (n - 7, 8),
        (8, n - 8), (8, n - 7), (8, n - 6), (8, n - 5), (8, n - 4), (8, n - 3), (8, n - 2), (8, n - 1),
    ]
    for i in range(15):
        bit = (bits >> (14 - i)) & 1
        x, y = coords_a[i]
        mat[y][x] = bit
        x2, y2 = coords_b[i]
        mat[y2][x2] = bit


def encode_matrix(text: str):
    raw = text.encode("utf-8")
    ver = _choose_version(len(raw))
    codewords, n = _encode_data(text, ver)
    mat = [[None] * n for _ in range(n)]
    _place_finders(mat, n)
    _place_alignment(mat, n, ver)
    _place_timing(mat, n)
    _reserve_format(mat, n)
    _place_dark(mat, n)
    # Convert False reserved → keep as "occupied" for fill skip
    for y in range(n):
        for x in range(n):
            if mat[y][x] is False:
                mat[y][x] = 0
    _fill_data(mat, n, codewords)
    _place_format(mat, n, _format_bits(0))
    for y in range(n):
        for x in range(n):
            if mat[y][x] is None:
                mat[y][x] = 0
            else:
                mat[y][x] = 1 if mat[y][x] else 0
    return mat


def matrix_to_png_bytes(mat, scale=10, margin=4, dark=(7, 21, 37), light=(255, 255, 255)):
    n = len(mat)
    size = (n + margin * 2) * scale
    rows = []
    for y in range(size):
        row = [0]
        my = (y // scale) - margin
        for x in range(size):
            mx = (x // scale) - margin
            on = 0 <= mx < n and 0 <= my < n and mat[my][mx]
            c = dark if on else light
            row.extend(c)
        rows.append(bytes(row))
    raw = b"".join(rows)
    compressed = zlib.compress(raw, 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", ihdr),
        chunk(b"IDAT", compressed),
        chunk(b"IEND", b""),
    ])


def make_qr_png(text: str, scale: int = 10) -> bytes:
    mat = encode_matrix(text)
    return matrix_to_png_bytes(mat, scale=scale)
