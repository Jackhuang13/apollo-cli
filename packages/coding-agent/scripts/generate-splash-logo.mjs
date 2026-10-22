#!/usr/bin/env node
/**
 * Generate APOLLO_LOGO_ROWS for the splash header from the brand SVG.
 *
 * Renders assets/brand/prime-butterfly.svg as half-block text art
 * (blocks style: 1 col = 1 raster px, 2 raster rows per text row) and
 * colors each column with a left-to-right hue ramp.
 *
 * Usage:
 *   node scripts/generate-splash-logo.mjs [--width 22] [--svg PATH] [--out FILE]
 *     [--hue-start 0] [--hue-span 300] [--sat 0.95] [--light 0.58] [--steps 24]
 *
 * The emitted APOLLO_LOGO_ROWS constant replaces the one in
 * src/themes/apollo-logo.ts. No renderer changes: BrandSplashHeader
 * already applies per-segment colors via Theme.fgHex.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseArgs(argv) {
  const args = {
    width: 22,
    svg: join(repoRoot, "assets", "brand", "prime-butterfly.svg"),
    out: null,
    hueStart: 0,
    hueSpan: 300,
    sat: 0.95,
    light: 0.58,
    steps: 24,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--width") args.width = Number(argv[++i]);
    else if (a === "--svg") args.svg = resolve(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--hue-start") args.hueStart = Number(argv[++i]);
    else if (a === "--hue-span") args.hueSpan = Number(argv[++i]);
    else if (a === "--sat") args.sat = Number(argv[++i]);
    else if (a === "--light") args.light = Number(argv[++i]);
    else if (a === "--steps") args.steps = Number(argv[++i]);
    else throw new Error("unknown argument: " + a);
  }
  return args;
}

// ---------- SVG path parsing (flattens cubics into polylines) ----------
function parsePath(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
  let i = 0, cx = 0, cy = 0, cmd = null;
  let cur = null, start = [0, 0];
  const polys = [];
  const N = 24;
  const cubic = (x0, y0, x1, y1, x2, y2, x3, y3, out) => {
    for (let s = 1; s <= N; s++) {
      const t = s / N, u = 1 - t;
      out.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i]; i++; continue; }
    if (!cmd) cmd = "c";
    const abs = cmd === cmd.toUpperCase();
    const rel = (a, b) => (abs ? [a, b] : [cx + a, cy + b]);
    switch (cmd.toLowerCase()) {
      case "m": {
        const p = rel(Number(tokens[i]), Number(tokens[i + 1])); i += 2;
        cur = [p]; start = p; polys.push(cur); cx = p[0]; cy = p[1]; cmd = "l"; break;
      }
      case "l": {
        const p = rel(Number(tokens[i]), Number(tokens[i + 1])); i += 2;
        cur.push(p); cx = p[0]; cy = p[1]; break;
      }
      case "h": {
        const p = rel(Number(tokens[i]), 0); i += 1;
        cur.push(p); cx = p[0]; break;
      }
      case "v": {
        const p = rel(0, Number(tokens[i])); i += 1;
        cur.push(p); cy = p[1]; break;
      }
      case "c": {
        const p1 = rel(Number(tokens[i]), Number(tokens[i + 1]));
        const p2 = rel(Number(tokens[i + 2]), Number(tokens[i + 3]));
        const p3 = rel(Number(tokens[i + 4]), Number(tokens[i + 5])); i += 6;
        cubic(cx, cy, p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], cur);
        cx = p3[0]; cy = p3[1]; break;
      }
      case "z": {
        cur.push(start); cx = start[0]; cy = start[1]; cmd = null; break;
      }
      default: throw new Error("unsupported path command: " + cmd);
    }
  }
  return polys;
}

// ---------- scanline even-odd rasterizer ----------
function rasterize(polys, W, H, scale, ox, oy) {
  const edges = [];
  for (const poly of polys) {
    for (let i = 0; i + 1 < poly.length; i++) {
      const x0 = (poly[i][0] - ox) * scale, y0 = (poly[i][1] - oy) * scale;
      const x1 = (poly[i + 1][0] - ox) * scale, y1 = (poly[i + 1][1] - oy) * scale;
      if (Math.abs(y1 - y0) > 1e-9) edges.push([x0, y0, x1, y1]);
    }
  }
  const mask = new Uint8Array(W * H);
  const xs = new Float64Array(edges.length);
  for (let y = 0; y < H; y++) {
    const yy = y + 0.5;
    let n = 0;
    for (const e of edges) {
      if ((e[1] <= yy && e[3] > yy) || (e[3] <= yy && e[1] > yy)) {
        xs[n++] = e[0] + ((yy - e[1]) / (e[3] - e[1])) * (e[2] - e[0]);
      }
    }
    xs.subarray(0, n).sort();
    for (let k = 0; k + 1 < n; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) mask[y * W + x] = 1;
    }
  }
  return mask;
}

// 2x supersampled coverage in 0..1
function coverage(polys, W, H, scale, ox, oy) {
  const big = rasterize(polys, W * 2, H * 2, scale * 2, ox, oy);
  const cov = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const r0 = (y * 2) * (W * 2);
    const r1 = (y * 2 + 1) * (W * 2);
    for (let x = 0; x < W; x++) {
      cov[y * W + x] = (big[r0 + x * 2] + big[r0 + x * 2 + 1] + big[r1 + x * 2] + big[r1 + x * 2 + 1]) * 0.25;
    }
  }
  return cov;
}

// ---------- color ----------
function hsl2hex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + toHex(f(h + 1 / 3)) + toHex(f(h)) + toHex(f(h - 1 / 3));
}

// ---------- main ----------
const args = parseArgs(process.argv);
const svg = readFileSync(args.svg, "utf8");
const polys = [...svg.matchAll(/<path[^>]*?\sd="([^"]+)"/g)].map((m) => m[1]).flatMap((d) => parsePath(d));
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const p of polys) for (const [x, y] of p) {
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const bw = maxX - minX, bh = maxY - minY;
const W = args.width;
const H = Math.max(4, Math.ceil((W * bh) / bw / 2) * 2);
const cov = coverage(polys, W, H, W / bw, minX, minY);

const table = { 0: " ", 1: "▀", 2: "▄", 3: "█" };
const cells = [];
for (let y = 0; y < H; y += 2) {
  const row = [];
  for (let x = 0; x < W; x++) {
    const m = (cov[y * W + x] >= 0.5 ? 1 : 0) | (cov[(y + 1) * W + x] >= 0.5 ? 2 : 0);
    row.push(table[m]);
  }
  cells.push(row);
}
while (cells.length && cells[0].every((c) => c === " ")) cells.shift();
while (cells.length && cells[cells.length - 1].every((c) => c === " ")) cells.pop();
let left = Infinity;
for (const row of cells) {
  const f = row.findIndex((c) => c !== " ");
  if (f >= 0) left = Math.min(left, f);
}
if (left < Infinity) for (const row of cells) row.splice(0, left);

let xMin = Infinity, xMax = -Infinity;
for (const row of cells) for (let x = 0; x < row.length; x++) {
  if (row[x] !== " ") { if (x < xMin) xMin = x; if (x > xMax) xMax = x; }
}

const step = 360 / args.steps;
const rows = cells.map((row) => {
  const segs = [];
  for (let x = 0; x < row.length; x++) {
    const ch = row[x];
    let color;
    if (ch !== " ") {
      const t = xMax === xMin ? 0 : (x - xMin) / (xMax - xMin);
      const hue = args.hueStart + args.hueSpan * t;
      color = hsl2hex(Math.round(hue / step) * step, args.sat, args.light);
    }
    const last = segs[segs.length - 1];
    if (last && last.char === ch && last.color === color) last.text += ch;
    else segs.push({ char: ch, color, text: ch });
  }
  return segs;
});

const lines = [];
lines.push("// GENERATED: node scripts/generate-splash-logo.mjs --width " + W +
  " --hue-start " + args.hueStart + " --hue-span " + args.hueSpan +
  " --sat " + args.sat + " --light " + args.light + " --steps " + args.steps);
lines.push("// Source: assets/brand/prime-butterfly.svg - do not edit by hand.");
lines.push("export const APOLLO_LOGO_ROWS: readonly (readonly LogoSegment[])[] = [");
for (const segs of rows) {
  lines.push("	[");
  for (const s of segs) {
    lines.push(s.color === undefined
      ? "		{ text: " + JSON.stringify(s.text) + " },"
      : "		{ text: " + JSON.stringify(s.text) + ", color: " + JSON.stringify(s.color) + " },");
  }
  lines.push("	],");
}
lines.push("];");
const out = lines.join("\n") + "\n";
if (args.out) writeFileSync(args.out, out);
else process.stdout.write(out);
