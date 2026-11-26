// Generates the extension icon: an orange square with a white bold "H", in the
// spirit of the Y Combinator mark (orange square, white letter) but with an H.
//
// One source of truth for the geometry. It is rasterised here (no image
// dependencies) into PNGs at the sizes browsers ask for, and also emitted as an
// SVG for previewing. The build writes both into <browser>/dist/icons/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// Hacker News orange; the YC mark uses the same colour.
const ORANGE = "#ff6600";
const ORANGE_RGB = [0xff, 0x66, 0x00];
const WHITE_RGB = [0xff, 0xff, 0xff];

// Design canvas. Everything below is in these units.
const CANVAS = 128;
const SUPERSAMPLE = 4; // anti-aliasing: render N x N per output pixel, then average

// The H, as three rectangles. Deliberately thick and flat-ended, like the YC Y.
const LEFT = { x0: 30, x1: 50 };
const RIGHT = { x0: 78, x1: 98 };
const TOP = 28;
const BOTTOM = 100;
const BAR = { y0: 54, y1: 74 };

const RECTS = [
  { x: LEFT.x0, y: TOP, w: LEFT.x1 - LEFT.x0, h: BOTTOM - TOP },
  { x: RIGHT.x0, y: TOP, w: RIGHT.x1 - RIGHT.x0, h: BOTTOM - TOP },
  { x: LEFT.x0, y: BAR.y0, w: RIGHT.x1 - LEFT.x0, h: BAR.y1 - BAR.y0 },
];

export const ICON_SIZES = [16, 32, 48, 96, 128];

/** Is the design-space point (x, y) inside the white H? */
function inLetter(x, y) {
  for (const r of RECTS) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}

/** RGBA pixels for a size x size icon, supersampled for smooth edges. */
function rasterize(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = CANVAS / (size * SUPERSAMPLE); // design units per sub-sample
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          const c = inLetter(x, y) ? WHITE_RGB : ORANGE_RGB;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (py * size + px) * 4;
      pixels[i] = Math.round(r / n);
      pixels[i + 1] = Math.round(g / n);
      pixels[i + 2] = Math.round(b / n);
      pixels[i + 3] = 0xff;
    }
  }
  return pixels;
}

// ---- minimal PNG encoder (RGBA, no filtering) ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The same geometry as an SVG, for previewing and editing. */
export function iconSvg() {
  const rects = RECTS.map(
    (r) => `  <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#ffffff"/>`,
  ).join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">`,
    `  <rect width="${CANVAS}" height="${CANVAS}" fill="${ORANGE}"/>`,
    rects,
    "</svg>",
    "",
  ].join("\n");
}

/** Write icon-<size>.png for every size plus icon.svg into `dir`. */
export function writeIcons(dir) {
  mkdirSync(dir, { recursive: true });
  for (const size of ICON_SIZES) {
    writeFileSync(join(dir, `icon-${size}.png`), encodePng(size, rasterize(size)));
  }
  writeFileSync(join(dir, "icon.svg"), iconSvg());
}
