// Tests for the generated extension icon (build-icons.mjs). Checks that the
// geometry is deterministic, that every PNG is a valid image of the right size,
// and that the mark is actually an orange square with a white H.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { ICON_SIZES, iconSvg, writeIcons } from "../build-icons.mjs";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode our own PNGs: 8-bit RGBA, no filtering (the encoder writes filter 0). */
function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], PNG_MAGIC, "PNG signature");
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "bit depth");
      assert.equal(data[9], 6, "colour type RGBA");
    } else if (type === "IDAT") {
      idat.push(data);
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixel = (x, y) => {
    const i = y * (stride + 1) + 1 + x * 4; // +1 skips the per-row filter byte
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  return { width, height, pixel };
}

test("writes every size plus an SVG, deterministically", () => {
  const dir = mkdtempSync(join(tmpdir(), "hidenews-icons-"));
  try {
    writeIcons(dir);
    const first = readFileSync(join(dir, "icon-128.png"));
    writeIcons(dir); // second run must produce byte-identical output
    assert.deepEqual(readFileSync(join(dir, "icon-128.png")), first);
    assert.ok(readFileSync(join(dir, "icon.svg"), "utf8").startsWith("<svg"));
    for (const size of ICON_SIZES) {
      const png = decodePng(readFileSync(join(dir, `icon-${size}.png`)));
      assert.equal(png.width, size);
      assert.equal(png.height, size);
      // The corner is the HN orange background. Sample a point safely inside the
      // left stem (design space 37,64 = the stem's centre) rather than the exact
      // canvas centre: with a thin crossbar the centre pixel is only partly
      // covered at 16px, so it is a blend rather than pure white.
      const stemX = Math.floor((37 * size) / 128);
      const stemY = Math.floor((64 * size) / 128);
      assert.deepEqual(png.pixel(0, 0), [0xff, 0x66, 0x00], `corner at ${size}px`);
      assert.deepEqual(png.pixel(stemX, stemY), [0xff, 0xff, 0xff], `stem at ${size}px`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the SVG uses the same geometry as the PNGs", () => {
  const svg = iconSvg();
  assert.match(svg, /fill="#ff6600"/);
  assert.match(svg, /fill="#ffffff"/);
  // three white rectangles: the two stems and the crossbar
  assert.equal(svg.match(/<rect[^>]*fill="#ffffff"/g).length, 3);
  assert.match(svg, /viewBox="0 0 128 128"/);
});
