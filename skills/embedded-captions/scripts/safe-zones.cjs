#!/usr/bin/env node
/*
 * safe-zones.cjs — PRECOMPUTE where captions can safely go, from the subject matte.
 *
 *   node safe-zones.cjs <project-dir>            → safe-zones.json (global + per-sentence windows) + summary
 *   node safe-zones.cjs <project-dir> <in> <out> → just that time window's zones (ad-hoc query)
 *
 * The inverse of check-occlusion: read the silhouette FIRST and hand the author the
 * clean regions + an embed-vs-fg verdict, so layout is right the first time instead of
 * after N occlusion-failure rounds.
 *
 * Uses the per-pixel ALPHA matte (not a bounding box): a cell counts as subject only
 * where the silhouette actually is, so the empty pocket beside the head / above the
 * shoulders stays FREE (a bbox would wrongly claim it). The subject MOVES, so zones are
 * computed PER TIME WINDOW (the union over just that window's frames), not one global box.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const THRESH = 30 / 255;   // a cell is "subject" if ≥12% covered at any sampled frame in the window
const SAMPLES = 48;        // frames cached across the clip (windows aggregate the cached grids)

const HF_ROOTS = [
  process.env.HYPERFRAMES_ROOT,
  path.resolve(__dirname, "../../.."),
  path.join(os.homedir(), "Downloads", "hyperframes"),
].filter(Boolean);
let sharp = null;
for (const root of HF_ROOTS) {
  const cands = [path.join(root, "node_modules", "sharp")];
  const bunDir = path.join(root, "node_modules", ".bun");
  try {
    if (fs.existsSync(bunDir))
      for (const d of fs.readdirSync(bunDir))
        if (d.startsWith("sharp@")) cands.push(path.join(bunDir, d, "node_modules", "sharp"));
  } catch {}
  for (const c of cands) { try { if (fs.existsSync(c)) { sharp = require(c); break; } } catch {} }
  if (sharp) break;
}

// largest all-clear (1) rectangle within [c0,c1)×[r0,r1), in CELL units
function largestRect(safe, GW, c0, c1, r0, r1) {
  const cols = c1 - c0;
  const heights = new Array(cols).fill(0);
  let best = { area: 0, x: 0, y: 0, w: 0, h: 0 };
  for (let r = r0; r < r1; r++) {
    for (let cc = 0; cc < cols; cc++) heights[cc] = safe[r * GW + (c0 + cc)] ? heights[cc] + 1 : 0;
    const st = [];
    for (let cc = 0; cc <= cols; cc++) {
      const h = cc < cols ? heights[cc] : 0;
      let start = cc;
      while (st.length && st[st.length - 1].h >= h) {
        const top = st.pop();
        const area = top.h * (cc - top.i);
        if (area > best.area) best = { area, x: c0 + top.i, y: r - top.h + 1, w: cc - top.i, h: top.h };
        start = top.i;
      }
      st.push({ i: start, h });
    }
  }
  return best;
}

// turn a max-coverage grid into {coverage, subject, zones, recommendation}
function analyze(occ, GW, GH, W, H, lum) {
  const occCell = new Uint8Array(GW * GH);
  for (let c = 0; c < GW * GH; c++) occCell[c] = occ[c] >= THRESH ? 1 : 0;
  const safe = new Uint8Array(GW * GH);            // 1-cell dilation margin around the silhouette
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let o = 0;
    for (let dy = -1; dy <= 1 && !o; dy++) for (let dx = -1; dx <= 1 && !o; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < GW && ny >= 0 && ny < GH && occCell[ny * GW + nx]) o = 1;
    }
    safe[y * GW + x] = o ? 0 : 1;
  }
  const occupied = occCell.reduce((a, b) => a + b, 0);
  const coverage = occupied / (GW * GH);
  let colMin = GW, colMax = -1, rowMin = GH, rowMax = -1;
  for (let x = 0; x < GW; x++) for (let y = 0; y < GH; y++) if (occCell[y * GW + x]) {
    if (x < colMin) colMin = x; if (x > colMax) colMax = x;
    if (y < rowMin) rowMin = y; if (y > rowMax) rowMax = y;
  }
  if (colMax < 0) { colMin = 0; colMax = -1; rowMin = 0; rowMax = -1; }
  const clearerSide = colMin >= (GW - 1 - colMax) ? "left" : "right";
  const cellW = W / GW, cellH = H / GH;
  // HERO anchor — where the ONE big promoted word should sit: ON the subject (centered,
  // crossing it so the head/torso occludes the middle). The OPPOSITE of the clean zones
  // above (those are for narration). A wide band ≈ centered on the subject, vertically
  // crossing the head/upper torso. Only meaningful when there IS a subject.
  let heroAnchor = null;
  if (colMax >= 0) {
    const subjCx = (colMin + colMax + 1) / 2 / GW * 100;
    const subjWpct = (colMax - colMin + 1) / GW * 100;
    const yTop = rowMin / GH * 100, yBot = (rowMax + 1) / GH * 100;
    const wPct = Math.round(Math.min(92, Math.max(58, subjWpct + 26)));
    const xPct = Math.round(Math.min(98 - wPct, Math.max(2, subjCx - wPct / 2)));
    const yPct = Math.round(yTop + (yBot - yTop) * 0.12); // band crosses the head / upper torso
    let bandLuma = null;
    if (lum) {
      const y0 = Math.round(yPct / 100 * GH), y1 = Math.min(GH, y0 + Math.max(2, Math.round(GH * 0.14)));
      const x0 = Math.round(xPct / 100 * GW), x1 = Math.min(GW, Math.round((xPct + wPct) / 100 * GW));
      // luma of the BACKGROUND cells only — that's where the hero's glyphs are visible
      // (the subject-occluded middle doesn't show text; averaging it in hides washout).
      let s2 = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (occCell[y * GW + x]) continue;
        s2 += lum[y * GW + x]; n++;
      }
      bandLuma = n ? Math.round(s2 / n) : null;
    }
    heroAnchor = { centerXPct: +subjCx.toFixed(1), plane: { xPct, yPct, wPct, align: "center" },
      ...(bandLuma != null ? { bandLuma, washoutRisk: bandLuma > 175 } : {}),
      note: "Place the ONE big hero here (centered on the subject); the head/torso occludes its middle (~30-55%) — that is the embed. Do NOT put the hero in a clean zone."
        + (bandLuma != null && bandLuma > 175 ? " ⚠ BAND IS BRIGHT (luma " + bandLuma + "): cream/screen text will wash out — lower the hero onto the darker subject body, or use a template/mode with opaque text." : "") };
  }
  const zoneLuma = (r) => {
    if (!lum || r.area === 0) return null;
    let s2 = 0, n = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { s2 += lum[y * GW + x]; n++; }
    return n ? Math.round(s2 / n) : null;
  };
  const toZone = (r) => r.area === 0 ? null : {
    xPct: +(r.x / GW * 100).toFixed(1), yPct: +(r.y / GH * 100).toFixed(1),
    wPct: +(r.w / GW * 100).toFixed(1), hPct: +(r.h / GH * 100).toFixed(1),
    areaPct: +(r.w * r.h / (GW * GH) * 100).toFixed(1),
    px: { x: Math.round(r.x * cellW), y: Math.round(r.y * cellH), w: Math.round(r.w * cellW), h: Math.round(r.h * cellH) },
    ...(zoneLuma(r) != null ? { meanLuma: zoneLuma(r), bright: zoneLuma(r) > 180 } : {}),
  };
  const zones = {
    largest: toZone(largestRect(safe, GW, 0, GW, 0, GH)),
    left:    toZone(largestRect(safe, GW, 0, Math.round(GW / 2), 0, GH)),
    right:   toZone(largestRect(safe, GW, Math.round(GW / 2), GW, 0, GH)),
    top:     toZone(largestRect(safe, GW, 0, GW, 0, Math.max(2, Math.round(GH * 0.38)))),
  };
  // HUGGING zones — clean strips that ABUT the silhouette (the embed aesthetic wants
  // text NEAR the subject, not parked in the farthest corner). Grown outward from the
  // subject's edge at upper-body height; prefer these for narration.
  const hug = (side) => {
    if (colMax < 0) return null;
    const pad = Math.max(1, Math.round(GW * 0.02));
    const y0 = rowMin, y1 = Math.min(GH, rowMin + Math.max(3, Math.round((rowMax - rowMin + 1) * 0.45)));
    let x0, x1;
    if (side === "right") { x0 = Math.min(GW - 1, colMax + 1 + pad); x1 = GW - pad; }
    else { x1 = Math.max(1, colMin - pad); x0 = pad; }
    if (x1 - x0 < Math.round(GW * 0.10)) return null;
    // shrink until actually clean (≤8% occupied cells)
    let occN = 0, tot = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { tot++; if (occCell[y * GW + x]) occN++; }
    if (tot === 0 || occN / tot > 0.08) return null;
    const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, area: (x1 - x0) * (y1 - y0) };
    return toZone(r);
  };
  zones.hugLeft = hug("left");
  zones.hugRight = hug("right");
  // HERO BAND PROFILE — per-height predicted occlusion of a centered hero band. The hero
  // WANTS ~30–55% (occlusion IS the embed); fg is the LAST resort, only when no height
  // achieves ≤62%. Even an 88%-coverage frame usually has a feasible band over the hairline.
  let heroBands = null;
  if (colMax >= 0) {
    const bandH = Math.max(2, Math.round(GH * 0.13));
    const hx0 = Math.round((heroAnchor ? heroAnchor.plane.xPct : 8) / 100 * GW);
    const hx1 = Math.min(GW, Math.round(((heroAnchor ? heroAnchor.plane.xPct + heroAnchor.plane.wPct : 92)) / 100 * GW));
    const profile = [];
    for (let y0 = 0; y0 + bandH <= GH; y0 += Math.max(1, Math.round(GH * 0.02))) {
      let n = 0, occN = 0, lsum = 0;
      for (let y = y0; y < y0 + bandH; y++) for (let x = hx0; x < hx1; x++) {
        n++; if (occCell[y * GW + x]) occN++; if (lum) lsum += lum[y * GW + x];
      }
      profile.push({ topPct: +(y0 / GH * 100).toFixed(1), occPct: +(occN / n * 100).toFixed(1),
        ...(lum ? { bgLuma: Math.round(lsum / n) } : {}) });
    }
    const ok = profile.filter((b) => b.occPct >= 12 && b.occPct <= 62);
    const best = (ok.length ? ok : profile).reduce((a, b) => Math.abs(b.occPct - 40) < Math.abs(a.occPct - 40) ? b : a);
    heroBands = { feasible: ok.length > 0, best, profile };
  }
  const big = zones.largest;
  const embeddable = !!big && big.areaPct >= 8 && big.hPct >= 10 && big.wPct >= 18;
  return {
    coverage: +(coverage * 100).toFixed(1),
    subject: { colMinPct: +(colMin / GW * 100).toFixed(1), colMaxPct: +((colMax + 1) / GW * 100).toFixed(1), clearerSide },
    zones, heroAnchor, heroBands, recommendation: embeddable ? "embed" : "fg",
  };
}

// split the transcript into sentence windows (punctuation, or a > 0.7s gap)
function sentenceWindows(project) {
  const tp = path.join(project, "transcript.json");
  if (!fs.existsSync(tp)) return [];
  let words;
  try { words = (JSON.parse(fs.readFileSync(tp, "utf8")).words || []).filter((w) => w && "start" in w); } catch { return []; }
  const out = []; let cur = [];
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    const w = words[i], nx = words[i + 1];
    const ends = /[.!?…]$/.test((w.text || "").trim());
    const gap = nx ? nx.start - w.end > 0.7 : true;
    if (ends || gap || !nx) {
      if (cur.length) out.push({ in: +cur[0].start.toFixed(2), out: +cur[cur.length - 1].end.toFixed(2), text: cur.map((x) => x.text).join(" ") });
      cur = [];
    }
  }
  return out;
}

async function main() {
  const project = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) { console.error("usage: safe-zones.cjs <project-dir> [in out]"); process.exit(1); }
  const fgDir = path.join(project, "frames_fg");
  if (!fs.existsSync(fgDir)) { console.error(`[safe-zones] no ${fgDir} — run matte.cjs first`); process.exit(2); }
  if (!sharp) { console.error("[safe-zones] sharp unavailable — set HYPERFRAMES_ROOT"); process.exit(0); }

  const frames = fs.readdirSync(fgDir).filter((f) => /\.png$/i.test(f)).sort();
  if (!frames.length) { console.error("[safe-zones] no PNG frames"); process.exit(2); }
  const meta = await sharp(path.join(fgDir, frames[0])).metadata();
  const W = meta.width, H = meta.height;
  const CELL = Math.max(W, H) / 48;
  const GW = Math.max(8, Math.round(W / CELL)), GH = Math.max(8, Math.round(H / CELL));
  let fps = 24;
  try { const f = parseFloat(String(fs.readFileSync(path.join(project, "matte.fps"), "utf8")).replace(/[^\d.]/g, "")); if (f > 0) fps = f; } catch {}

  const bgDir = path.join(project, "frames_bg");
  const hasBg = fs.existsSync(bgDir);
  // cache evenly-sampled frame grids once (each = per-cell avg subject alpha 0..1,
  // plus per-cell mean LUMINANCE from frames_bg — bright zones wash out cream/screen text)
  const sampleIdx = [...new Set(Array.from({ length: SAMPLES }, (_, i) => Math.min(frames.length - 1, Math.round((i / (SAMPLES - 1)) * (frames.length - 1)))))];
  const grids = [];
  for (const i of sampleIdx) {
    const { data, info } = await sharp(path.join(fgDir, frames[i]))
      .resize(GW, GH, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels, g = new Float32Array(GW * GH);
    for (let c = 0; c < GW * GH; c++) g[c] = (ch >= 4 ? data[c * ch + 3] : 255) / 255;
    let lum = null;
    if (hasBg && fs.existsSync(path.join(bgDir, frames[i]))) {
      const { data: bd, info: bi } = await sharp(path.join(bgDir, frames[i]))
        .resize(GW, GH, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
      const bch = bi.channels; lum = new Float32Array(GW * GH);
      for (let c = 0; c < GW * GH; c++) lum[c] = bd[c * bch];
    }
    grids.push({ t: i / fps, g, lum });
  }
  const lumWindow = (t0, t1) => {
    const acc = new Float32Array(GW * GH); let n = 0;
    let inWin = grids.filter((s2) => s2.t >= t0 - 1e-6 && s2.t <= t1 + 1e-6 && s2.lum);
    if (!inWin.length) inWin = grids.filter((s2) => s2.lum);
    for (const s2 of inWin) { for (let c = 0; c < GW * GH; c++) acc[c] += s2.lum[c]; n++; }
    if (!n) return null;
    for (let c = 0; c < GW * GH; c++) acc[c] /= n;
    return acc;
  };
  const occWindow = (t0, t1) => {
    const occ = new Float32Array(GW * GH);
    let inWin = grids.filter((s) => s.t >= t0 - 1e-6 && s.t <= t1 + 1e-6);
    if (!inWin.length) { // window between samples → use nearest grid
      const mid = (t0 + t1) / 2; inWin = [grids.reduce((a, b) => Math.abs(b.t - mid) < Math.abs(a.t - mid) ? b : a)];
    }
    for (const s of inWin) for (let c = 0; c < GW * GH; c++) if (s.g[c] > occ[c]) occ[c] = s.g[c];
    return occ;
  };

  // ad-hoc window query
  const qIn = parseFloat(process.argv[3]), qOut = parseFloat(process.argv[4]);
  if (Number.isFinite(qIn) && Number.isFinite(qOut)) {
    const a = analyze(occWindow(qIn, qOut), GW, GH, W, H, lumWindow(qIn, qOut));
    console.log(`[safe-zones] window ${qIn}-${qOut}s: ${a.recommendation.toUpperCase()}  coverage ${a.coverage}%  clearer:${a.subject.clearerSide}`);
    const z = a.zones;
    for (const k of ["largest", "left", "right", "top"]) if (z[k]) console.log(`   ${k}: ${z[k].wPct}%×${z[k].hPct}% @ (${z[k].xPct}%,${z[k].yPct}%)`);
    console.log(JSON.stringify({ in: qIn, out: qOut, ...a }));
    return;
  }

  const global = analyze(occWindow(-1e9, 1e9), GW, GH, W, H, lumWindow(-1e9, 1e9));
  const windows = sentenceWindows(project).map((s) => {
    const a = analyze(occWindow(s.in, s.out), GW, GH, W, H, lumWindow(s.in, s.out));
    return { in: s.in, out: s.out, text: s.text.slice(0, 48), coverage: a.coverage, recommendation: a.recommendation, clearerSide: a.subject.clearerSide, zones: a.zones };
  });

  const out = { width: W, height: H, fps, grid: { cols: GW, rows: GH }, ...global, windows };
  fs.writeFileSync(path.join(project, "safe-zones.json"), JSON.stringify(out, null, 2));

  const z = (n, zn) => zn ? `${n}: ${zn.wPct}%×${zn.hPct}% @ (${zn.xPct}%,${zn.yPct}%) [${zn.areaPct}%${zn.meanLuma != null ? ` · luma ${zn.meanLuma}${zn.bright ? " ⚠BRIGHT" : ""}` : ""}]` : `${n}: —`;
  console.log(`[safe-zones] ${W}×${H} grid ${GW}×${GH} @ ${fps}fps · GLOBAL coverage ${global.coverage}% · clearer ${global.subject.clearerSide} · verdict ${global.recommendation.toUpperCase()}`);
  console.log(`             ${z("largest", global.zones.largest)} | ${z("left", global.zones.left)} | ${z("right", global.zones.right)} | ${z("top", global.zones.top)}`);
  if (global.recommendation === "embed") {
    console.log(`[safe-zones] ✅ EMBED — NARRATION planes go in the clean zones (prefer ${global.subject.clearerSide}/top).`);
    if (global.heroAnchor) console.log(`[safe-zones] 🎯 HERO → centered ON the subject: plane ≈ x${global.heroAnchor.plane.xPct}% y${global.heroAnchor.plane.yPct}% w${global.heroAnchor.plane.wPct}% center · BIG (~0.22–0.34·h) · target ~30–55% occlusion${global.heroAnchor.bandLuma != null ? ` · band luma ${global.heroAnchor.bandLuma}${global.heroAnchor.washoutRisk ? " ⚠WASHOUT RISK — see heroAnchor.note" : ""}` : ""}`);
    if (global.heroBands) console.log(`[safe-zones] hero bands: best top ${global.heroBands.best.topPct}% (predicted occlusion ${global.heroBands.best.occPct}%) · bg-hero ${global.heroBands.feasible ? "FEASIBLE — keep the hero EMBEDDED (fg is last resort)" : "INFEASIBLE (no band ≤62%) → hero fg"}`);
    if (global.zones.hugLeft || global.zones.hugRight) console.log(`[safe-zones] hugging zones (narration belongs HERE, abutting the silhouette): L ${global.zones.hugLeft ? global.zones.hugLeft.wPct + "%×" + global.zones.hugLeft.hPct + "%@x" + global.zones.hugLeft.xPct + "%" + (global.zones.hugLeft.bright ? "⚠bright" : "") : "—"} · R ${global.zones.hugRight ? global.zones.hugRight.wPct + "%×" + global.zones.hugRight.hPct + "%@x" + global.zones.hugRight.xPct + "%" + (global.zones.hugRight.bright ? "⚠bright" : "") : "—"}`);
  } else {
    console.log(`[safe-zones] ⚠ FG — subject fills the frame; use caption_layer:"fg" (no clean region to embed behind).`);
  }
  if (windows.length) {
    console.log(`[safe-zones] per-sentence windows (place each group using ITS window's zones):`);
    for (const w of windows)
      console.log(`   [${w.in}-${w.out}s] ${w.recommendation.toUpperCase()} cov ${w.coverage}% clear:${w.clearerSide}  ${w.zones.largest ? `best ${w.zones.largest.wPct}%×${w.zones.largest.hPct}%@(${w.zones.largest.xPct}%,${w.zones.largest.yPct}%)` : ""}  "${w.text}"`);
  }
  console.log(`[safe-zones] → ${path.join(project, "safe-zones.json")}`);
}
main().catch((e) => { console.error(`[safe-zones] (skipped — ${e.message})`); process.exit(0); });
