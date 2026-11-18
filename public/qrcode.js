/* Tiny QR Code generator (byte mode) - no dependencies.
 * Provides QR.generate(text, eclName) -> { version, size, modules }
 * where modules is a 2D array of booleans (true = dark).
 */
(function (global) {
  "use strict";

  /* ---- GF(256) ---- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
  }

  /* ---- tables [version][ecl 0..3: L,M,Q,H] ---- */
  const ECC = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const NBLK = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];
  const ECL_BITS = [1, 0, 3, 2]; // L, M, Q, H

  function rawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      result -= (25 * n - 10) * n - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  const totalCodewords = (ver) => Math.floor(rawDataModules(ver) / 8);
  const dataCodewords = (ver, ecl) => totalCodewords(ver) - ECC[ecl][ver] * NBLK[ecl][ver];

  function alignPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const size = ver * 4 + 17;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;

  function encodeData(text, ver, ecl) {
    const bytes = new TextEncoder().encode(text);
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };

    push(0x4, 4);
    push(bytes.length, ver <= 9 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);

    const capacity = dataCodewords(ver, ecl) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

    const out = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
    return out;
  }

  function addEccAndInterleave(data, ver, ecl) {
    const numBlocks = NBLK[ecl][ver];
    const eccLen = ECC[ecl][ver];
    const raw = totalCodewords(ver);
    const numShort = numBlocks - (raw % numBlocks);
    const shortBlockLen = Math.floor(raw / numBlocks);
    const shortDataLen = shortBlockLen - eccLen;
    const maxDataLen = shortDataLen + (numShort < numBlocks ? 1 : 0);

    const divisor = rsDivisor(eccLen);
    const dataBlocks = [];
    const eccBlocks = [];
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
      const len = shortDataLen + (i < numShort ? 0 : 1);
      const dat = data.slice(k, k + len);
      k += len;
      dataBlocks.push(dat);
      eccBlocks.push(rsRemainder(dat, divisor));
    }

    const out = [];
    for (let j = 0; j < maxDataLen; j++) {
      for (let i = 0; i < numBlocks; i++) if (j < dataBlocks[i].length) out.push(dataBlocks[i][j]);
    }
    for (let j = 0; j < eccLen; j++) {
      for (let i = 0; i < numBlocks; i++) out.push(eccBlocks[i][j]);
    }
    return out;
  }

  function maskFn(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function buildMatrix(ver, ecl, codewords, forcedMask) {
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));

    const setFn = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFn[y][x] = true;
    };

    // timing
    for (let i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }

    // finder patterns
    const drawFinder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(cx + dx, cy + dy, d !== 2 && d !== 4);
        }
      }
    };
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // alignment patterns
    const pos = alignPositions(ver);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === pos.length - 1) ||
          (i === pos.length - 1 && j === 0)
        ) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFn(pos[j] + dx, pos[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    const drawFormat = (mask) => {
      const data = (ECL_BITS[ecl] << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
      setFn(8, 7, getBit(bits, 6));
      setFn(8, 8, getBit(bits, 7));
      setFn(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
      setFn(8, size - 8, true);
    };

    const drawVersion = () => {
      if (ver < 7) return;
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFn(a, b, bit);
        setFn(b, a, bit);
      }
    };

    drawFormat(0); // reserve format area
    drawVersion();

    // place codewords
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && i < codewords.length * 8) {
            modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }

    const applyMask = (mask) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (!isFn[y][x] && maskFn(mask, x, y)) modules[y][x] = !modules[y][x];
        }
      }
    };

    const penalty = () => {
      let result = 0;
      for (let y = 0; y < size; y++) {
        let color = false;
        let run = 0;
        for (let x = 0; x < size; x++) {
          if (modules[y][x] === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            color = modules[y][x];
            run = 1;
          }
        }
      }
      for (let x = 0; x < size; x++) {
        let color = false;
        let run = 0;
        for (let y = 0; y < size; y++) {
          if (modules[y][x] === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            color = modules[y][x];
            run = 1;
          }
        }
      }
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
        }
      }
      const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
      const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
      const scan = (get) => {
        const line = new Array(size + 8);
        for (let i = 0; i < 4; i++) line[i] = false;
        for (let i = 0; i < size; i++) line[4 + i] = get(i);
        for (let i = 0; i < 4; i++) line[size + 4 + i] = false;
        for (let i = 0; i <= line.length - 11; i++) {
          let h1 = true;
          let h2 = true;
          for (let k = 0; k < 11; k++) {
            if (line[i + k] !== pat1[k]) h1 = false;
            if (line[i + k] !== pat2[k]) h2 = false;
          }
          if (h1) result += 40;
          if (h2) result += 40;
        }
      };
      for (let y = 0; y < size; y++) scan((x) => modules[y][x]);
      for (let x = 0; x < size; x++) scan((y) => modules[y][x]);
      let dark = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
      const total = size * size;
      result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return result;
    };

    let mask = forcedMask == null ? 0 : forcedMask;
    if (forcedMask == null) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m);
        drawFormat(m);
        const score = penalty();
        applyMask(m); // undo
        if (score < best) {
          best = score;
          mask = m;
        }
      }
    }
    applyMask(mask);
    drawFormat(mask);

    return { version: ver, size, modules, mask };
  }

  function generate(text, eclName) {
    const ecl = { L: 0, M: 1, Q: 2, H: 3 }[eclName || "M"];
    const bytes = new TextEncoder().encode(text);
    let ver = 1;
    for (; ver <= 40; ver++) {
      const cc = ver <= 9 ? 8 : 16;
      if (4 + cc + bytes.length * 8 <= dataCodewords(ver, ecl) * 8) break;
    }
    if (ver > 40) throw new Error("data too long for a QR code");
    const data = encodeData(text, ver, ecl);
    const interleaved = addEccAndInterleave(data, ver, ecl);
    return buildMatrix(ver, ecl, interleaved, null);
  }

  const QR = { generate, _buildMatrix: buildMatrix, _encode: encodeData, _interleave: addEccAndInterleave };

  global.QR = QR;
  if (typeof module !== "undefined" && module.exports) module.exports = QR;
})(typeof window !== "undefined" ? window : globalThis);
