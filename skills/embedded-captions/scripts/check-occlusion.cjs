#!/usr/bin/env node
/* check-occlusion.cjs — pixel-perfect occlusion gate (Node port of check-occlusion-v2.py).
 * Runs measure-layout.cjs (real Chromium DOM rects), reads the subject-matte alpha via sharp,
 * computes per-word / per-cap occlusion. No Python.
 *   node check-occlusion.cjs <project-dir> [--strict] [--word-fail F] [--word-warn F] [--cap-fail F] [--remeasure]
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const cp = require("child_process");

function hfResolve(pkg) {
  const roots = [process.env.HYPERFRAMES_ROOT, path.resolve(__dirname, "..", "..", ".."), path.join(os.homedir(), "Downloads", "hyperframes")].filter(Boolean);
  for (const root of roots) {
    const cands = [path.join(root, "node_modules", pkg)];
    const bun = path.join(root, "node_modules", ".bun");
    try { if (fs.existsSync(bun)) for (const d of fs.readdirSync(bun)) if (d.startsWith(pkg + "@")) cands.push(path.join(bun, d, "node_modules", pkg)); } catch (e) {}
    for (const c of cands) { try { if (fs.existsSync(c)) return require(c); } catch (e) {} }
  }
  console.error(`[v2] cannot find ${pkg} — set HYPERFRAMES_ROOT`); process.exit(3);
}
const sharp = hfResolve("sharp");

function ensureLayoutMeasured(project, force) {
  const lp = path.join(project, "_layout.json"), idx = path.join(project, "index.html");
  let stale = force || !fs.existsSync(lp);
  if (!stale && fs.existsSync(idx) && fs.statSync(idx).mtimeMs > fs.statSync(lp).mtimeMs) stale = true;
  if (stale) cp.execFileSync("node", [path.join(__dirname, "measure-layout.cjs"), project], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(lp, "utf8"));
}
async function loadAlphaMask(png) {
  if (!fs.existsSync(png)) return null;
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}
function occlusionForRect(m, x, y, w, h) {
  if (!m) return 0;
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(m.W, Math.round(x + w)), y1 = Math.min(m.H, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) return 0;
  let cnt = 0, tot = 0;
  for (let yy = y0; yy < y1; yy++) { const row = yy * m.W; for (let xx = x0; xx < x1; xx++) { tot++; if (m.data[row + xx] > 128) cnt++; } }
  return tot ? cnt / tot : 0;
}
function argf(name, d) { const i = process.argv.indexOf(name); return i >= 0 ? parseFloat(process.argv[i + 1]) : d; }

async function main() {
  const project = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) { console.error("usage: check-occlusion.cjs <project-dir> [--strict]"); process.exit(1); }
  const strict = process.argv.includes("--strict");
  const wordFail = argf("--word-fail", 0.65), wordWarn = argf("--word-warn", 0.35), capFail = argf("--cap-fail", 0.50);
  const layout = ensureLayoutMeasured(project, process.argv.includes("--remeasure"));
  const framesDir = path.join(project, "frames_fg");
  if (!fs.existsSync(framesDir)) { console.error(`[v2] missing ${framesDir}`); process.exit(2); }
  const planPath = path.join(project, "plan.json");
  const plan = fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, "utf8")) : {};
  const planLayer = plan.caption_layer || "bg";
  // Hero groups (the ONE big promoted word) are SUPPOSED to sit ON the subject — for them
  // occlusion is a TARGET (~30–55%), not "minimize". Collect their ids for the advisory below.
  const heroIds = new Set();
  for (const g of (plan.groups || [])) if (g && (g.hero === true || /^(hero|crown)$/i.test(g.plane || ""))) heroIds.add(g.id);
  if (plan.crown_group && plan.crown_group.id) heroIds.add(plan.crown_group.id);
  const M = 2; // frame-edge tolerance (px) — matches check-overflow.cjs
  const frameW = layout.width, frameH = layout.height;

  const capStats = {};
  for (const sample of layout.samples) {
    const png = path.join(framesDir, `f_${String(sample.frame_idx).padStart(4, "0")}.png`);
    const mask = await loadAlphaMask(png);
    if (!mask) continue;
    for (const cap of sample.caps) {
      const entry = (capStats[cap.id] ||= { layer: cap.layer || planLayer, samples: [] });
      const wordsData = [];
      for (const w of (cap.words || [])) {
        if ((w.opacity ?? 1) < 0.3) continue;
        wordsData.push({ text: w.text, occlusion: occlusionForRect(mask, w.x, w.y, w.w, w.h) });
        // Frame-edge overflow — clipped text is always wrong; track worst per cap.
        const off = { left: Math.max(0, Math.round(-w.x - M)), right: Math.max(0, Math.round(w.x + w.w - frameW - M)),
                      top: Math.max(0, Math.round(-w.y - M)), bottom: Math.max(0, Math.round(w.y + w.h - frameH - M)) };
        const score = off.left + off.right + off.top + off.bottom;
        if (score > 0 && (!entry.overflow || score > entry.overflow.score)) entry.overflow = { text: w.text, off, score, t: sample.t };
      }
      const capOccl = occlusionForRect(mask, cap.cap_bbox.x, cap.cap_bbox.y, cap.cap_bbox.w, cap.cap_bbox.h);
      entry.samples.push({ t: sample.t, cap_occl: capOccl, words: wordsData });
    }
  }

  const failures = [];
  console.log(`[v2] ${path.basename(project)}  word-fail≥${(wordFail * 100).toFixed(0)}%  cap-fail≥${(capFail * 100).toFixed(0)}%`);
  for (const [gid, entry] of Object.entries(capStats)) {
    // Frame-edge overflow applies to every layer (fg too). The skill allows the
    // climax a few-px graze on the first/last letter, so only a clear glyph clip
    // (>8px past an edge) is a hard FAIL; a sub-glyph graze is a WARN.
    if (entry.overflow) {
      const o = entry.overflow;
      const maxOff = Math.max(o.off.left, o.off.right, o.off.top, o.off.bottom);
      const sides = Object.entries(o.off).filter(([, v]) => v > 0).map(([s, v]) => `${s} ${v}px`).join(", ");
      const hard = maxOff >= 8;
      console.log(`  ${gid}  [overflow${hard ? "" : "-warn"}] "${o.text}" off-frame: ${sides} (@${o.t}s)`
        + (hard ? " — cropped text is always wrong" : " (graze — within climax tolerance)"));
      if (hard && !failures.includes(gid)) failures.push(gid);
    }
    if (entry.layer === "fg") { console.log(`  ${gid}  fg    (occlusion skipped — fg renders above matte)`); continue; }
    const capOccls = entry.samples.map((s) => s.cap_occl);
    const avgCap = capOccls.length ? capOccls.reduce((a, b) => a + b, 0) / capOccls.length : 0;
    const peakCap = capOccls.length ? Math.max(...capOccls) : 0;
    const wordPeaks = {};
    for (const s of entry.samples) for (const wd of s.words) wordPeaks[wd.text] = Math.max(wordPeaks[wd.text] || 0, wd.occlusion);
    const oblit = Object.entries(wordPeaks).filter(([, p]) => p >= wordFail);
    const warn = Object.entries(wordPeaks).filter(([, p]) => p >= wordWarn && p < wordFail);
    let status = "OK";
    if (oblit.length || peakCap >= capFail) { status = "FAIL"; failures.push(gid); }
    else if (warn.length) status = "WARN";
    let s = "";
    if (oblit.length) s = oblit.slice(0, 5).map(([t, p]) => `${t}(${(p * 100).toFixed(0)}%)`).join(" ") + (oblit.length > 5 ? ` …+${oblit.length - 5}` : "");
    else if (warn.length) s = "[warn] " + warn.slice(0, 3).map(([t, p]) => `${t}(${(p * 100).toFixed(0)}%)`).join(" ");
    console.log(`  ${gid}  ${entry.layer}  avg ${(avgCap * 100).toFixed(0)}%  peak ${(peakCap * 100).toFixed(0)}%  ${status}  ${s}`);
    // HERO target-occlusion advisory (not a failure): a hero should sit ON the subject
    // (~30–55%). If it barely grazes, it reads as a small floating word, not an embed.
    if (heroIds.has(gid) && peakCap < 0.15) {
      console.log(`  ${gid}  [hero-weak] peak ${(peakCap * 100).toFixed(0)}% — hero barely crosses the subject; it should sit ON the subject (~30–55% = the embed effect). Center it (safe-zones heroAnchor) + make it BIG; don't park it in a clean margin.`);
    }
  }
  if (failures.length) {
    const uniq = [...new Set(failures)];
    console.error(`\n[v2] ${uniq.length} cap(s) FAIL: ${uniq.join(", ")}`);
    console.error("  → occlusion: set that cap's layer to fg, OR shrink/reposition;  overflow: shrink/reposition (fg won't help)");
  }
  process.exit(strict && failures.length ? 2 : 0);
}
main().catch((e) => { console.error("[v2]", e.message); process.exit(1); });
