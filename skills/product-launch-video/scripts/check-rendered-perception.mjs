#!/usr/bin/env node
// check-rendered-perception.mjs
//
// Tier-1 perceptual gate. Loads each compositions/scene_N.html in headless
// Chrome at 1920×1080, injects the brand @font-face block (so text renders in
// the real display face, not a fallback), seeks the registered timeline at 3
// probe times (40% / 70% / 92% of duration), then queries the live DOM for
// visual failures that pass every structural gate:
//
//   1. text-clipping              — text natural bbox exceeds parent visible bbox
//                                    (catches `overflow: hidden` swallowing chars)
//   2. depth-layer-ghost-on-long-word
//                                  — two same-text siblings offset by N px on a
//                                    ≥10-char display-tier word → reads as smear
//                                    not depth
//   3a. primary-collision         — two [data-layout-role="primary"] siblings in
//                                    the same data-layout-act overlap (IoU > 0.05)
//   3b. cross-text-collision      — two DIFFERENT display-tier texts (≥40px) with
//                                    overlapping bboxes (unannotated headline clash
//                                    / depth-stack spilling into a neighbour)
//   3c. object-overlap            — two non-decorative foreground BOXES (cards,
//                                    panels, stats, media, icons, small-text) that
//                                    are position:absolute|fixed and whose bboxes
//                                    intersect ≥15% of the smaller — object-level
//                                    occlusion that 3a/3b miss. Opt out of an
//                                    intentional layered composition with
//                                    data-layout-allow-overlap="true".
//   4. primary-offscreen          — display-tier text 15–85% clipped by the 1920×1080
//                                    canvas (camera/zoom centering error); checked
//                                    EVEN under data-layout-allow-overflow
//   5. font-too-small             — rendered viewport font-size < 24px on
//                                    non-decorative text
//   6. content-cramped-container  — a foreground child's bbox is pressed against
//                                    its parent container's border (within 6px of
//                                    content-box bottom AND content-box top), OR
//                                    a container reports scrollHeight > clientHeight.
//                                    The signature of a card whose interior was
//                                    not retuned after the parent shrank.
//   7. low-contrast-foreground    — a non-decorative text element (≥24px) AND
//                                    inline-SVG asset has WCAG contrast < 2.5:1
//                                    against the first non-transparent background
//                                    ancestor. The signature of an asset / wordmark
//                                    placed on a surface it was not authored for
//                                    (e.g. a dark-glyph svg on a dark card).
//   8. foreground-over-panel      — a non-decorative text node overlaps an opaque
//                                    sibling panel/card it is NOT inside (supporting
//                                    text bleeding onto a primary panel edge). Fills
//                                    the gap between 3a (primary↔primary only) and
//                                    3b (text↔text ≥40px only). Checked EVEN under
//                                    data-layout-allow-overflow.
//
// All thresholds live in one CFG block below so they are tunable in one place.
// Writes a JSON report (schema-compatible with check-caption-keepout violations
// where possible) to <out>. Always exits 0 — informational; preflight reads the
// report file and incorporates violations into finalize_brief.
//
// Requires either `puppeteer` (auto-finds Chrome) OR `puppeteer-core` + a known
// Chrome binary at `PUPPETEER_EXECUTABLE_PATH` / the standard puppeteer cache
// location. Soft-skips with an empty report if no browser is available.

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDims } from "./lib/dimensions.mjs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

// ─────────────────────────────────────────── CLI args ───
const { values } = parseArgs({
  options: {
    "group-spec": { type: "string", default: "./group_spec.json" },
    hyperframes: { type: "string", default: "." },
    out: { type: "string", default: "./perception_report.json" },
    // Keep this pinned to the same GSAP build assemble-index.mjs injects into
    // index.html <head>, so the probe seeks with the runtime the real render uses.
    "gsap-cdn": {
      type: "string",
      default: "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
    },
    "min-font-size": { type: "string", default: "24" },
  },
});

// ─────────────────────────────────────────── tunable thresholds ───
// One place for every heuristic constant. Passed wholesale into the DOM-side
// PROBE (JSON-serialized by puppeteer, so numbers only — no regex/functions).
// Defaults are starting points calibrated against early PLV runs; tune here,
// not inline. font-too-small (minFontPx) is the only one that is non-blocking.
const CFG = {
  minFontPx: parseFloat(values["min-font-size"]), // readability floor for video @1920×1080
  candidateMinFontPx: 8, // ignore sub-8px nodes entirely (icon glyphs, hairlines)
  clipTolPx: 4, // px of natural-bbox overflow tolerated before text-clipping fires
  ghostMinChars: 10, // depth-ghost only matters on long words…
  ghostMinFontPx: 60, // …at display tier
  ghostMinVOverlap: 0.5, // two layers must overlap ≥50% vertically to count as stacked
  ghostMinOffsetPx: 3, // leading-edge offset below this reads as crisp, not smear
  ghostMinOffsetRatio: 0.005, // …and must be ≥0.5% of text width (scale-independent guard)
  ghostMaxOffsetRatio: 0.5, // …but ≥50% of text width = two separate copies, not a smear
  // (e.g. two animated instances of the same word mid-slide)
  ghostOffsetWidthFrac: 0.02, // recommended max offset = min(width × 2%, cap)
  ghostMaxOffsetCapPx: 4, // …capped at 4px
  primaryIoU: 0.05, // annotated primary-vs-primary overlap that counts as collision
  collisionMinFontPx: 40, // cross-text-collision only considers display-tier text
  collisionIoU: 0.06, // IoU above this = collision…
  collisionOverlapFrac: 0.12, // …OR intersection ≥12% of the smaller bbox
  primaryTextMinFontPx: 60, // primary-offscreen: only display-tier text can be a "cut headline"
  primaryClipMinFrac: 0.15, // …flag when >15% of it is clipped by the 1920×1080 canvas…
  primaryClipMaxFrac: 0.85, // …but ≤85% (fully-off text is an intentional slide/park, not a cut)
  primaryZoomMinScale: 1.5, // …and only when a scaled ancestor caused it (zoom miscentre, NOT a
  //                            headline the layout deliberately bleeds off the margin)
  crampedClearancePx: 6, // content-cramped-container: child bbox edge within this many px
  //                            of parent's content-box edge counts as "pressed"
  crampedMinContainerHeightPx: 200, // skip tiny containers (probes, chips) — only flag
  //                            substantial card / panel / stage containers
  crampedMinChildHeightPx: 24, // skip 1-2px decorative children when scanning for "pressed"
  contrastMinRatio: 2.5, // low-contrast-foreground: WCAG contrast below this is borderline
  //                            invisible at video resolution. AA = 3.0 for large text;
  //                            2.5 catches the worst cases (truly hidden) without
  //                            re-firing on every editorial low-contrast warning that
  //                            `validate` already issues separately.
  contrastMinTextFontPx: 24, // skip body chrome smaller than this — it's caught by
  //                            font-too-small or by validate's WCAG-AA rail
  contrastMinAssetSizePx: 96, // …and skip tiny SVGs (icon glyphs) — only flag wordmark-
  //                            scale assets (≥96×40 ish)
  panelBleedMinFontPx: 16, // foreground-over-panel: ignore sub-16px chrome
  panelBleedOverlapFrac: 0.05, // flag when the text bbox straddles a panel edge: ≥5% over it…
  panelBleedMaxFrac: 0.5, // …but <50% (≥50% = text sitting fully ON the panel = content placed there, not an edge-bleed)
  panelMinSidePx: 200, // a "panel" is a substantial opaque surface (≥200px on both sides)
  panelMinBgAlpha: 0.8, // …with an effectively opaque background-color
  overlapMinFrac: 0.15, // object-overlap (3c): intersection ≥15% of the smaller box = occlusion
  overlapMinSidePx: 24, // …and both boxes ≥24px on the shorter side (skip hairlines / thin accents)
  overlapMaxCanvasFrac: 0.85, // …and skip near-full-bleed boxes (≥85% of canvas): they're LAYERS (bg / connector-lines / overlay / diagram), not discrete colliding objects
};

// ─────────────────────────────────────────── browser bootstrap ───
function findChromeBinary() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  // Standard puppeteer cache locations
  const cache = join(homedir(), ".cache", "puppeteer");
  for (const sub of ["chrome", "chrome-headless-shell"]) {
    const base = join(cache, sub);
    if (!existsSync(base)) continue;
    let versions;
    try {
      versions = readdirSync(base);
    } catch {
      continue;
    }
    for (const ver of versions.sort().reverse()) {
      const platDir = join(base, ver);
      let inner;
      try {
        inner = readdirSync(platDir);
      } catch {
        continue;
      }
      for (const p of inner) {
        const macApp = join(
          platDir,
          p,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        );
        if (existsSync(macApp)) return macApp;
        const linuxBin = join(platDir, p, "chrome");
        if (existsSync(linuxBin)) return linuxBin;
        const shellBin = join(platDir, p, "chrome-headless-shell");
        if (existsSync(shellBin)) return shellBin;
      }
    }
  }
  return null;
}

let puppeteer = null;
let executablePath = null;
try {
  puppeteer = (await import("puppeteer")).default;
} catch {
  try {
    puppeteer = (await import("puppeteer-core")).default;
    executablePath = findChromeBinary();
    if (!executablePath) {
      console.error("skipped: puppeteer-core present but no Chrome binary found");
      writeFileSync(
        values.out,
        JSON.stringify(
          { skipped: true, reason: "no chrome binary", violations: [], scenes_scanned: 0 },
          null,
          2,
        ),
      );
      process.exit(0);
    }
  } catch {
    console.error("skipped: neither `puppeteer` nor `puppeteer-core` installed (npm i puppeteer)");
    writeFileSync(
      values.out,
      JSON.stringify(
        { skipped: true, reason: "no puppeteer", violations: [], scenes_scanned: 0 },
        null,
        2,
      ),
    );
    process.exit(0);
  }
}

// ─────────────────────────────────────────── load group_spec ───
const groupSpec = JSON.parse(readFileSync(values["group-spec"], "utf8"));
const projectRoot = resolve(values.hyperframes);

// Canvas size — render + geometry checks must run at the authored resolution
// (portrait/square clip differently than landscape). From group_spec.width/
// height; landscape default for pre-dims specs.
const { width: CANVAS_W, height: CANVAS_H } = readDims(groupSpec);

// Brand @font-face block — assemble-index.mjs injects this into index.html's
// <head> (the skill forbids @font-face inside scenes, so the scene <template>
// alone renders every `var(--font-*)` in a system-ui fallback). Inject the SAME
// block into each probe page so text geometry is measured in the REAL display
// face. url(public/fonts/…) is relative; the probe file lives at projectRoot so
// file:// resolves it. Empty string when the project ships no brand fonts.
const fontFaceCss = (groupSpec.font_face_css || "").trim();

// Brand design tokens — the `:root { --cl-*: … }` block assemble-index.mjs injects
// into index.html's <head>. Scene <template>s reference these via var(--*) but do
// NOT define them, so without this the probe resolves every token-driven
// background / color to its unset fallback (transparent panels, default text
// color) — which silently defeats the contrast AND foreground-over-panel checks.
// Inject the SAME block so the probe paints the real surfaces.
const brandTokensCss = (groupSpec.brand_tokens_css || "").trim();

// ─────────────────────────────────────────── launch browser ───
const launchOpts = executablePath
  ? { executablePath, headless: "shell", args: ["--no-sandbox", "--disable-setuid-sandbox"] }
  : { headless: "shell", args: ["--no-sandbox", "--disable-setuid-sandbox"] };
const browser = await puppeteer.launch(launchOpts);

const violations = [];
const cleanupPaths = [];
let scenesScanned = 0;
let scenesFailed = 0;
// Coverage honesty: a scene listed in group_spec but missing its file / <template>
// is never probed; a scene whose GSAP timeline never registers gets probed only
// at its t=0 frame (seek is a no-op), so reveals that happen later are invisible.
// Both are counted and surfaced so a partial scan never reads as "all clean".
let scenesSkipped = 0;
let scenesNoTimeline = 0;

// ─────────────────────────────────────────── DOM-side probe ───
// This function runs inside the puppeteer page context. It must be self-contained.
const PROBE = function probe(sid, compRel, cfg, CANVAS_W, CANVAS_H) {
  const v = [];
  const minFontPx = cfg.minFontPx;

  // ── helpers ──
  const isTextEl = (el) => {
    if (!el.childNodes) return false;
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE && c.textContent.trim()) return true;
    }
    return false;
  };
  const fontSize = (el) => parseFloat(getComputedStyle(el).fontSize);
  const selectorFor = (el) => {
    if (el.id) return "#" + el.id;
    const cls = Array.from(el.classList).filter((c) => c && /^s\d+-/.test(c));
    if (cls.length) return el.tagName.toLowerCase() + "." + cls.join(".");
    return el.tagName.toLowerCase();
  };
  const naturalBbox = (el) => {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects());
      if (!rects.length) return null;
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      const top = Math.min(...rects.map((r) => r.top));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      return { left, right, top, bottom, width: right - left, height: bottom - top };
    } catch {
      return null;
    }
  };
  const findClipAncestor = (el) => {
    let p = el.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      if (
        cs.overflow === "hidden" ||
        cs.overflowX === "hidden" ||
        cs.overflowY === "hidden" ||
        cs.overflow === "clip"
      ) {
        return p;
      }
      p = p.parentElement;
    }
    return null;
  };
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const DECO_RX =
    /\b(bg|background|dot-?grid|mesh|gradient|swell|ambient|texture|noise|scanline|surface|overlay|halo|glow|frame|pin|corner-?pin|deco|star-?burst|burst|ring|stripe|rect|shadow|pulse|ripple|measure|probe|scrim|backdrop|veil|fog|grain)\b/i;
  const isInDecor = (el) => {
    let p = el;
    while (p && p !== document.body) {
      const cls = Array.from(p.classList || []).join(" ");
      if (DECO_RX.test(cls)) return true;
      p = p.parentElement;
    }
    return false;
  };
  const hasAriaHidden = (el) => {
    let p = el;
    while (p) {
      if (p.getAttribute && p.getAttribute("aria-hidden") === "true") return true;
      p = p.parentElement;
    }
    return false;
  };
  // Inherited overflow-allowed escape hatch — used by macro-camera scenes
  // (coordinate-target-zoom, multi-phase-camera) where the zoom peak is
  // intentionally outside the parent box.
  const hasAllowOverflow = (el) => {
    let p = el;
    while (p) {
      if (
        p.getAttribute &&
        (p.getAttribute("data-layout-allow-overflow") === "true" ||
          p.getAttribute("data-layout-ignore") === "true")
      )
        return true;
      p = p.parentElement;
    }
    return false;
  };
  // Inherited escape hatch for INTENTIONAL layered composition: any element (or
  // ancestor) marked data-layout-allow-overlap="true" is exempt from Check 3c, so
  // a deliberately layered design opts out of the no-overlap contract.
  const hasAllowOverlap = (el) => {
    let p = el;
    while (p) {
      if (p.getAttribute && p.getAttribute("data-layout-allow-overlap") === "true") return true;
      p = p.parentElement;
    }
    return false;
  };
  // Narrow opt-in for INTENTIONAL primary-text bleed off the canvas (rare —
  // an artistic crop). Unlike allow-overflow (which is for decorative bleed and
  // does NOT exempt primary text from Check 5), this is per-text and explicit.
  const hasExplicitBleed = (el) => {
    let p = el;
    while (p) {
      if (p.getAttribute && p.getAttribute("data-layout-bleed") === "true") return true;
      p = p.parentElement;
    }
    return false;
  };
  // Largest scale factor on the element or any ancestor. Tells a zoom/camera-induced
  // clip (a coordinate-target-zoom miscentre — always has a scaled ancestor) from a
  // rest-size headline the layout simply parks bleeding off the margin (no scale →
  // intentional editorial bleed, not a bug). Parses the CSS matrix(): scaleX = √(a²+b²).
  const ancestorScale = (el) => {
    let maxS = 1,
      p = el;
    while (p && p !== document.body) {
      const t = getComputedStyle(p).transform;
      if (t && t !== "none") {
        const m = t.match(/matrix3?d?\(([^)]+)\)/);
        if (m) {
          const n = m[1].split(",").map(parseFloat);
          const sx = Math.hypot(n[0] || 0, n[1] || 0);
          if (isFinite(sx) && sx > maxS) maxS = sx;
        }
      }
      p = p.parentElement;
    }
    return maxS;
  };

  // ── candidate set: all visible text-bearing nodes under #root, fontSize ≥ 8 ──
  const root = document.getElementById("root") || document.body;
  const all = Array.from(root.querySelectorAll("*"));
  const candidates = [];
  for (const el of all) {
    if (!isTextEl(el)) continue;
    if (!isVisible(el)) continue;
    const fs = fontSize(el);
    if (!isFinite(fs) || fs < cfg.candidateMinFontPx) continue;
    const txt = el.textContent.trim();
    if (!txt) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    candidates.push({ el, txt, fs, rect, sel: selectorFor(el), deco: isInDecor(el) });
  }

  // ── Check 1: text-clipping ──
  // Find the CSS rule (across all stylesheets) that supplies the element's
  // font-size and is uniquely scoped to a selector. Lets the Node side
  // post-process the violation into an Edit-ready font-size reduction.
  function findFontSizeRule(el, currentSizePx) {
    const wanted = Math.round(currentSizePx * 10) / 10;
    const tries = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        continue;
      }
      for (const r of rules) {
        if (r.type !== 1) continue; // CSSStyleRule
        const fsRaw = r.style && r.style.fontSize ? r.style.fontSize : "";
        if (!fsRaw) continue;
        const m = fsRaw.match(/^(\d+(?:\.\d+)?)px$/);
        if (!m) continue;
        const px = parseFloat(m[1]);
        if (Math.abs(px - wanted) > 0.6) continue;
        try {
          if (el.matches(r.selectorText)) {
            tries.push({ selectorText: r.selectorText, cssText: r.cssText, fontSizePx: px });
          }
        } catch {
          /* invalid selector */
        }
      }
    }
    // Prefer most specific match: id > class > tag heuristic via selector length
    tries.sort((a, b) => b.selectorText.length - a.selectorText.length);
    return tries[0] || null;
  }

  for (const c of candidates) {
    if (c.deco) continue;
    if (hasAllowOverflow(c.el)) continue; // by-design camera-zoom overflow
    const clipAnc = findClipAncestor(c.el);
    if (!clipAnc) continue;
    const nat = naturalBbox(c.el);
    if (!nat) continue;
    const pr = clipAnc.getBoundingClientRect();
    const TOL = cfg.clipTolPx;
    const oR = Math.max(0, nat.right - pr.right - TOL);
    const oL = Math.max(0, pr.left - TOL - nat.left);
    const oB = Math.max(0, nat.bottom - pr.bottom - TOL);
    const oT = Math.max(0, pr.top - TOL - nat.top);
    if (oR + oL + oB + oT < 1) continue;
    const rule = findFontSizeRule(c.el, c.fs);
    v.push({
      type: "text-clipping",
      scene_id: sid,
      file: compRel,
      selector: c.sel,
      clip_ancestor_selector: selectorFor(clipAnc),
      text: c.txt.length > 60 ? c.txt.slice(0, 57) + "…" : c.txt,
      metric: {
        font_size_px: Math.round(c.fs * 10) / 10,
        natural_width_px: Math.round(nat.width),
        natural_height_px: Math.round(nat.height),
        visible_width_px: Math.round(pr.right - pr.left),
        visible_height_px: Math.round(pr.bottom - pr.top),
        overflow_left_px: Math.round(oL),
        overflow_right_px: Math.round(oR),
        overflow_top_px: Math.round(oT),
        overflow_bottom_px: Math.round(oB),
      },
      // Hand the CSS rule that owns this element's font-size to the Node side
      // so it can generate edit_old/edit_new strings. Captures the selectorText
      // (e.g. "#s3-dest" or ".s3-line-fully") that browser CSSOM matched.
      css_font_size_rule: rule,
      principle: `Text natural extent exceeds parent visible bbox by [L=${Math.round(oL)} T=${Math.round(oT)} R=${Math.round(oR)} B=${Math.round(oB)}]px (clip ancestor: ${selectorFor(clipAnc)}).`,
      suggestion:
        oR > 0
          ? `Text natural width ${Math.round(nat.width)}px exceeds parent visible width ${Math.round(pr.right - pr.left)}px by ${Math.round(oR)}px. Reduce font-size to ≤ ${Math.round(((c.fs * (pr.right - pr.left)) / nat.width) * 0.95)}px OR break "${c.txt.slice(0, 30)}" into multiple vertically-stacked lines OR widen container.`
          : `Text overflows parent on non-right edge by ${Math.round(oL + oT + oB)}px. Adjust position or sizing.`,
      fix_kind: "manual",
    });
  }

  // ── Check 2: depth-layer-ghost-on-long-word ──
  // Detect pairs of same-text + same-fontSize candidates whose bboxes are:
  //  - vertically overlapping (≥50% of element height) — they're stacked, not unrelated
  //  - horizontally offset within (0.5% … 50%] of text width AND > 3px — a real
  //    smear is a few px; ≥50% of width means two separate copies (e.g. the same
  //    word animated into two on-screen instances), which is not this check's bug.
  // For long words (≥10 chars at display tier ≥60px), this offset reads as
  // ghost smear at the leading edge rather than as deliberate depth.
  const reportedGhost = new Set();
  function vOverlap(a, b) {
    const top = Math.max(a.top, b.top);
    const bot = Math.min(a.bottom, b.bottom);
    const inter = Math.max(0, bot - top);
    const min = Math.min(a.height, b.height);
    return min > 0 ? inter / min : 0;
  }
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i],
        b = candidates[j];
      if (a.deco || b.deco) continue;
      if (a.txt !== b.txt) continue;
      if (Math.abs(a.fs - b.fs) > 2) continue;
      // Must vertically overlap → they're stacked depth layers, not unrelated repeats
      if (vOverlap(a.rect, b.rect) < cfg.ghostMinVOverlap) continue;
      if (a.txt.length < cfg.ghostMinChars || a.fs < cfg.ghostMinFontPx) continue;
      const dx = a.rect.left - b.rect.left;
      const offset = Math.abs(dx);
      const ratio = offset / Math.max(a.rect.width, 1);
      if (offset <= cfg.ghostMinOffsetPx || ratio <= cfg.ghostMinOffsetRatio) continue;
      if (ratio >= cfg.ghostMaxOffsetRatio) continue; // separate copies, not a leading-edge smear
      const key = `${sid}:${a.txt}`;
      if (reportedGhost.has(key)) continue;
      reportedGhost.add(key);
      const recommendedOffset = Math.min(
        Math.round(a.rect.width * cfg.ghostOffsetWidthFrac),
        cfg.ghostMaxOffsetCapPx,
      );
      // Identify front vs back: assume the higher-opacity one is front (heuristic)
      const aOp = parseFloat(getComputedStyle(a.el).opacity);
      const bOp = parseFloat(getComputedStyle(b.el).opacity);
      const front = aOp >= bOp ? a : b;
      const back = aOp >= bOp ? b : a;
      v.push({
        type: "depth-layer-ghost-on-long-word",
        scene_id: sid,
        file: compRel,
        selector: front.sel + " (front) vs " + back.sel + " (back)",
        text: a.txt.length > 60 ? a.txt.slice(0, 57) + "…" : a.txt,
        metric: {
          char_count: a.txt.length,
          font_size_px: Math.round(a.fs * 10) / 10,
          text_width_px: Math.round(a.rect.width),
          leading_offset_px: Math.round(offset * 10) / 10,
          offset_ratio: Math.round(ratio * 10000) / 10000,
          recommended_max_offset_px: recommendedOffset,
          front_opacity: aOp >= bOp ? aOp : bOp,
          back_opacity: aOp >= bOp ? bOp : aOp,
        },
        principle: `${a.txt.length}-char word at ${Math.round(a.fs)}px font; back layer (op=${(aOp >= bOp ? bOp : aOp).toFixed(2)}) is offset ${Math.round(offset)}px (${(ratio * 100).toFixed(1)}% of text width) from front layer — reads as ghost smear at the leading edge, not as depth.`,
        suggestion: `Reduce depth-layer stack to ≤2 layers OR cap leading offset ≤ ${recommendedOffset}px (= min(text_width × 2%, 4px)). For ≥10-char words at display tier, prefer a single drop-shadow over stacked translated copies.`,
        fix_kind: "manual",
      });
      break;
    }
  }

  // ── Check 3a: primary-collision (annotated) ──
  // Catches workers who DID annotate data-layout-role="primary" and put two
  // primaries in the same data-layout-act with overlapping bboxes.
  const primaries = Array.from(document.querySelectorAll('[data-layout-role="primary"]')).filter(
    isVisible,
  );
  const byAct = new Map();
  for (const p of primaries) {
    const act = p.dataset.layoutAct || "__default";
    if (!byAct.has(act)) byAct.set(act, []);
    byAct.get(act).push(p);
  }
  for (const [act, list] of byAct.entries()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i].getBoundingClientRect();
        const B = list[j].getBoundingClientRect();
        const ix = Math.max(0, Math.min(A.right, B.right) - Math.max(A.left, B.left));
        const iy = Math.max(0, Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top));
        const inter = ix * iy;
        const union = A.width * A.height + B.width * B.height - inter;
        const iou = union > 0 ? inter / union : 0;
        if (iou <= cfg.primaryIoU) continue;
        v.push({
          type: "primary-collision",
          scene_id: sid,
          file: compRel,
          selector: selectorFor(list[i]) + " + " + selectorFor(list[j]),
          text: `[${list[i].textContent.trim().slice(0, 30)}] / [${list[j].textContent.trim().slice(0, 30)}]`,
          metric: { act, iou: Math.round(iou * 1000) / 1000 },
          principle: `Two data-layout-role="primary" elements in act="${act}" overlap with IoU=${(iou * 100).toFixed(1)}%.`,
          suggestion: `Demote one to data-layout-role="supporting" OR stagger their visible windows in the timeline OR reposition so bboxes don't intersect.`,
          fix_kind: "manual",
        });
      }
    }
  }

  // ── Check 3b: cross-text-collision (unannotated) ──
  // Catches the case where workers DIDN'T annotate primaries but two
  // display-tier text elements with DIFFERENT content occupy overlapping
  // bboxes — typically headlines stacked too close, or a depth-stack's absolute
  // back-layers spilling out of their wrapper into a neighbouring headline's box.
  //
  // Rules:
  //   - Both candidates are large (≥40px font size)
  //   - Different textContent (after trim; subset-relationships excluded)
  //   - Neither is an ancestor of the other (containment ≠ collision)
  //   - Bbox intersection / min(bbox_area) ≥ 0.12 OR IoU ≥ 0.06
  //   - Skip when both have IDENTICAL textContent (handled by Check 2 instead)
  const reportedCollision = new Set();
  const bigCandidates = candidates.filter(
    (c) => !c.deco && c.fs >= cfg.collisionMinFontPx && c.txt.replace(/[^\w]/g, "").length >= 3,
  );
  function isAncestor(a, b) {
    let p = b.parentElement;
    while (p) {
      if (p === a) return true;
      p = p.parentElement;
    }
    return false;
  }
  function relatedText(a, b) {
    // Treat as related if either text is a substring/superset of the other
    // (typical of discrete-text-sequence mid-reveal: "MAKE" / "MAKE LIFE.")
    if (a.txt === b.txt) return true;
    if (a.txt.length > 3 && b.txt.includes(a.txt)) return true;
    if (b.txt.length > 3 && a.txt.includes(b.txt)) return true;
    return false;
  }
  for (let i = 0; i < bigCandidates.length; i++) {
    for (let j = i + 1; j < bigCandidates.length; j++) {
      const a = bigCandidates[i],
        b = bigCandidates[j];
      if (relatedText(a, b)) continue; // depth-stack pair or mid-reveal — Check 2 owns it
      if (isAncestor(a.el, b.el) || isAncestor(b.el, a.el)) continue;
      const A = a.rect,
        B = b.rect;
      const ix = Math.max(0, Math.min(A.right, B.right) - Math.max(A.left, B.left));
      const iy = Math.max(0, Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top));
      const inter = ix * iy;
      if (inter <= 0) continue;
      const minArea = Math.min(A.width * A.height, B.width * B.height);
      const union = A.width * A.height + B.width * B.height - inter;
      const iou = union > 0 ? inter / union : 0;
      const overlapOfSmaller = minArea > 0 ? inter / minArea : 0;
      if (iou < cfg.collisionIoU && overlapOfSmaller < cfg.collisionOverlapFrac) continue;
      const key = `${a.txt}|${b.txt}`;
      const keyRev = `${b.txt}|${a.txt}`;
      if (reportedCollision.has(key) || reportedCollision.has(keyRev)) continue;
      reportedCollision.add(key);
      v.push({
        type: "cross-text-collision",
        scene_id: sid,
        file: compRel,
        selector: a.sel + " ↔ " + b.sel,
        text: `[${a.txt.slice(0, 30)}] / [${b.txt.slice(0, 30)}]`,
        metric: {
          font_size_a_px: Math.round(a.fs * 10) / 10,
          font_size_b_px: Math.round(b.fs * 10) / 10,
          a_bbox: `(${Math.round(A.left)},${Math.round(A.top)}) ${Math.round(A.width)}x${Math.round(A.height)}`,
          b_bbox: `(${Math.round(B.left)},${Math.round(B.top)}) ${Math.round(B.width)}x${Math.round(B.height)}`,
          intersection_px2: Math.round(inter),
          iou: Math.round(iou * 1000) / 1000,
          overlap_of_smaller: Math.round(overlapOfSmaller * 1000) / 1000,
        },
        principle: `Two display-tier text elements with different content overlap by IoU=${(iou * 100).toFixed(1)}% (${(overlapOfSmaller * 100).toFixed(0)}% of the smaller bbox). Likely a layout bug where one headline / depth-stack is spilling into another.`,
        suggestion: `Pull the two text elements apart vertically (increase line-height or add margin between them) OR reduce the depth-stack height on one OR demote one to a smaller supporting role. If the smaller one is positioned inside the other's depth-stack container, give the depth-stack wrapper an explicit \`position: relative\` and a height that confines its absolute back-layers.`,
        fix_kind: "manual",
      });
    }
  }

  // ── Check 3c: object-overlap (general foreground occlusion) ──
  // 3a/3b only see annotated primaries and ≥40px text-vs-text. The dominant real
  // overlap here is object-level: two BOXES (cards, panels, stats, media, icons,
  // small-text blocks) sharing a screen region. In normal flow sibling boxes can't
  // overlap — overlap requires an element taken OUT of flow — so we only test
  // position:absolute|fixed foreground boxes (that's exactly where authored overlap
  // comes from, and it skips ±3% breathing/drift on in-flow elements). Under the
  // no-overlap layout contract ANY such intersection is a bug; a deliberately
  // layered composition opts out with data-layout-allow-overlap="true".
  const overlapLabel = (el) => {
    const t = (el.textContent || "").trim();
    if (t) return t.length > 24 ? t.slice(0, 21) + "…" : t;
    return el.classList && el.classList[0] ? "." + el.classList[0] : el.tagName.toLowerCase();
  };
  const isBoxObject = (el) => {
    // Honors data-layout-allow-overflow on purpose. Dropping it (to collision-check a
    // continue-group primary panel) was measured and floods FPs: intentional layering —
    // node-diagram nodes sitting on their connector-edges SVG, plus morph-seam coexistence
    // of the diagram and the panel — all read as ≥15% overlap (0→17 on a real project).
    // allow-overflow is the blunt signal that those elements live in an intentional-overflow
    // context. Intentional layering opts out explicitly via data-layout-allow-overlap; a
    // genuinely buggy overlap ON an allow-overflow primary is the known residual gap.
    if (isInDecor(el) || hasAriaHidden(el) || hasAllowOverflow(el) || hasAllowOverlap(el))
      return false;
    if (!isVisible(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== "absolute" && cs.position !== "fixed") return false; // flow can't overlap
    const r = el.getBoundingClientRect();
    if (Math.min(r.width, r.height) < cfg.overlapMinSidePx) return false; // hairlines / dividers
    if (r.width * r.height >= cfg.overlapMaxCanvasFrac * CANVAS_W * CANVAS_H) return false; // full-bleed = a layer, not a discrete object
    const tag = el.tagName.toLowerCase();
    if (isTextEl(el)) return true;
    if (["img", "svg", "video", "canvas", "picture"].includes(tag)) return true;
    if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
    const bg = cs.backgroundColor || "";
    const opaqueBg = bg && bg !== "transparent" && !/,\s*0\)\s*$/.test(bg); // skip rgba(…,0)
    const hasBorder =
      parseFloat(cs.borderTopWidth) > 0 ||
      parseFloat(cs.borderRightWidth) > 0 ||
      parseFloat(cs.borderBottomWidth) > 0 ||
      parseFloat(cs.borderLeftWidth) > 0;
    const hasShadow = cs.boxShadow && cs.boxShadow !== "none";
    return opaqueBg || hasBorder || hasShadow;
  };
  const boxes = all.filter(isBoxObject);
  const reportedOverlap = new Set();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i],
        B = boxes[j];
      if (isAncestor(A, B) || isAncestor(B, A)) continue; // nesting ≠ collision
      const ra = A.getBoundingClientRect(),
        rb = B.getBoundingClientRect();
      const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      const inter = ix * iy;
      if (inter <= 0) continue;
      const minArea = Math.min(ra.width * ra.height, rb.width * rb.height);
      const overlapOfSmaller = minArea > 0 ? inter / minArea : 0;
      if (overlapOfSmaller < cfg.overlapMinFrac) continue;
      // Display-tier text↔text is Check 3b's job — don't double-report it here.
      const aBigText = isTextEl(A) && fontSize(A) >= cfg.collisionMinFontPx;
      const bBigText = isTextEl(B) && fontSize(B) >= cfg.collisionMinFontPx;
      if (aBigText && bBigText) continue;
      const selA = selectorFor(A),
        selB = selectorFor(B);
      const key = [selA, selB].sort().join("|");
      if (reportedOverlap.has(key)) continue;
      reportedOverlap.add(key);
      v.push({
        type: "object-overlap",
        scene_id: sid,
        file: compRel,
        selector: selA + " ↔ " + selB,
        text: `[${overlapLabel(A)}] / [${overlapLabel(B)}]`,
        metric: {
          a_bbox: `(${Math.round(ra.left)},${Math.round(ra.top)}) ${Math.round(ra.width)}x${Math.round(ra.height)}`,
          b_bbox: `(${Math.round(rb.left)},${Math.round(rb.top)}) ${Math.round(rb.width)}x${Math.round(rb.height)}`,
          intersection_px2: Math.round(inter),
          overlap_of_smaller: Math.round(overlapOfSmaller * 1000) / 1000,
        },
        principle: `Two foreground objects overlap by ${(overlapOfSmaller * 100).toFixed(0)}% of the smaller box (object-level occlusion). At least one is position:absolute|fixed; in normal flow these boxes would not intersect.`,
        suggestion: `Lay the two objects out so their boxes don't intersect: put them in a flow (flex/grid) container, OR move/shrink the absolutely-positioned one until the bboxes clear. If the overlap is a deliberate layered composition, mark the shared wrapper data-layout-allow-overlap="true" to opt out (you then own that it reads as intentional).`,
        fix_kind: "manual",
      });
    }
  }

  // ── Check 4: font-too-small ──
  for (const c of candidates) {
    if (c.deco) continue;
    if (c.fs >= minFontPx) continue;
    if (hasAriaHidden(c.el)) continue;
    v.push({
      type: "font-too-small",
      scene_id: sid,
      file: compRel,
      selector: c.sel,
      text: c.txt.length > 60 ? c.txt.slice(0, 57) + "…" : c.txt,
      metric: { font_size_px: Math.round(c.fs * 10) / 10, threshold_px: minFontPx },
      principle: `Rendered font-size ${Math.round(c.fs * 10) / 10}px below ${minFontPx}px readability threshold for video at 1920×1080.`,
      suggestion: `Increase to ≥${minFontPx}px, OR mark decorative with aria-hidden="true" / move into a known decorative container.`,
      fix_kind: "manual",
    });
  }

  // ── Check 5: primary-offscreen (canvas clip — runs EVEN under allow-overflow) ──
  // allow-overflow is the escape hatch for DECORATIVE bleed at a camera/zoom peak;
  // it must NOT also hide a brand wordmark / headline getting sliced by the frame.
  // So this check ignores allow-overflow and asks a narrower question: is a
  // display-tier, non-decorative text element PARTIALLY clipped by the 1920×1080
  // canvas? The 15–85% band is the signature of a coordinate-target-zoom centering
  // error (offset hand-derived with the wrong sign, or scale left no headroom):
  // the headline is mostly visible but a chunk is sliced off. Fully-off text
  // (≥85%) is an intentional slide-in/out or off-stage park, not a cut, so it's
  // skipped. And the clip must be ZOOM-induced (a scaled ancestor ≥1.5×) — a
  // rest-size headline the layout parks bleeding off the margin is by design, not
  // a bug. data-layout-bleed="true" opts a specific element out entirely.
  // CANVAS_W / CANVAS_H are PROBE params (passed at page.evaluate). Module-level
  // Node consts do NOT cross into the page context — referencing them bare here
  // ReferenceErrors and throws the whole probe.
  for (const c of candidates) {
    if (c.deco) continue;
    if (c.fs < cfg.primaryTextMinFontPx) continue; // display tier only
    if (hasAriaHidden(c.el)) continue; // depth-shadow / decoration layers
    if (hasExplicitBleed(c.el)) continue; // intentional bleed opt-in
    const r = c.rect;
    const area = r.width * r.height;
    if (area <= 0) continue;
    const visW = Math.max(0, Math.min(r.right, CANVAS_W) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, CANVAS_H) - Math.max(r.top, 0));
    const clippedFrac = 1 - (visW * visH) / area;
    if (clippedFrac <= cfg.primaryClipMinFrac) continue; // essentially on-screen → fine
    if (clippedFrac >= cfg.primaryClipMaxFrac) continue; // fully off → intentional transition/park
    if (ancestorScale(c.el) < cfg.primaryZoomMinScale) continue; // not zoom-induced → layout bleed by design
    const offX = Math.round(r.left + r.width / 2 - CANVAS_W / 2);
    const offY = Math.round(r.top + r.height / 2 - CANVAS_H / 2);
    v.push({
      type: "primary-offscreen",
      scene_id: sid,
      file: compRel,
      selector: c.sel,
      text: c.txt.length > 60 ? c.txt.slice(0, 57) + "…" : c.txt,
      metric: {
        font_size_px: Math.round(c.fs * 10) / 10,
        clipped_pct: Math.round(clippedFrac * 100),
        bbox: `(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)}`,
        center_offset_px: `x=${offX} y=${offY}`,
      },
      principle: `Display-tier text is ${Math.round(clippedFrac * 100)}% clipped by the ${CANVAS_W}×${CANVAS_H} canvas (center off by x=${offX} y=${offY}). data-layout-allow-overflow does NOT exempt primary text.`,
      suggestion: `Almost always a coordinate-target-zoom error. MEASURE the target's real center (getBoundingClientRect after document.fonts.ready) and bake the counter-translate offset — don't hand-derive it (the equal-cards formula gets the sign wrong on asymmetric layouts). Cap zoom scale so the text stays ≤~88% of canvas width. If the bleed is truly intentional, mark the text element data-layout-bleed="true".`,
      fix_kind: "manual",
    });
  }

  // ── Check 6: content-cramped-container (a foreground child is pressed against
  //    its parent's border — the signature of a card whose interior was not
  //    re-tuned after a height shrink, leaving the last flex child with zero
  //    clearance to the bottom border) ──
  // Calibration: the check fires only when the layout was *meant* to leave
  // breathing room at the bottom but no longer does. Concretely:
  //   - `scrollHeight > clientHeight + 1` (children literally don't fit), OR
  //   - bottom child pressed (clearance < cfg.crampedClearancePx) AND the
  //     container's `justify-content` is one of {flex-start, normal, start,
  //     left, undefined} — i.e. the column flows top-down, so the slack space
  //     was designed to live at the bottom; zero slack = bug.
  // Containers with `justify-content: center | space-* | flex-end` distribute
  // slack on purpose; pressed edges there are by design and we skip them.
  // Containers in a `data-layout-allow-overflow` ancestor are skipped wholesale
  // (slot-machine tickers, etc.).
  const reportedCramp = new Set();
  const flexContainers = Array.from(root.querySelectorAll("*")).filter((el) => {
    if (!isVisible(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.display !== "flex" && cs.display !== "grid" && cs.display !== "inline-flex")
      return false;
    const r = el.getBoundingClientRect();
    if (r.height < cfg.crampedMinContainerHeightPx) return false;
    if (isInDecor(el)) return false;
    if (hasAllowOverflow(el)) return false; // slot-machine tickers etc.
    // Skip the root canvas itself + the scene-root wrapper — those are full-frame
    // and naturally touch every edge.
    if (el === root) return false;
    if (el.id === "root") return false;
    return true;
  });
  // `justify-content` values that put slack at the BOTTOM (= a pressed bottom
  // implies real cramping). Anything else (center / space-* / flex-end /
  // stretch-with-equal-height-grids) is a layout where edges-touching is by
  // design and we skip.
  const TOP_DOWN_JUSTIFY = new Set(["flex-start", "start", "normal", "left", "stretch"]);
  for (const container of flexContainers) {
    const cs = getComputedStyle(container);
    const cr = container.getBoundingClientRect();
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const contentTop = cr.top + padTop;
    const contentBottom = cr.bottom - padBottom;
    const justifyContent = cs.justifyContent || "normal";
    const flowsTopDown = TOP_DOWN_JUSTIFY.has(justifyContent);

    // True overflow: scrollHeight beyond clientHeight by >1px.
    const overflowing = container.scrollHeight - container.clientHeight > 1;

    const kids = Array.from(container.children).filter((k) => {
      if (!isVisible(k)) return false;
      if (isInDecor(k)) return false;
      if (hasAriaHidden(k)) return false;
      const kr = k.getBoundingClientRect();
      return kr.height >= cfg.crampedMinChildHeightPx;
    });
    if (!kids.length && !overflowing) continue;

    // Find the topmost and bottommost foreground kids by their visible y range.
    let topKid = null,
      botKid = null,
      topY = Infinity,
      botY = -Infinity;
    for (const k of kids) {
      const kr = k.getBoundingClientRect();
      if (kr.top < topY) {
        topY = kr.top;
        topKid = k;
      }
      if (kr.bottom > botY) {
        botY = kr.bottom;
        botKid = k;
      }
    }
    const topClearance = topKid ? topY - contentTop : Infinity;
    const botClearance = botKid ? contentBottom - botY : Infinity;
    const pressedBottom = botClearance < cfg.crampedClearancePx;

    // Asymmetry guard: a true "cramping" signature is asymmetric clearance —
    // the layout was designed to keep slack at one end but no longer does.
    // When BOTH ends are pressed AND there's no real overflow, the layout
    // packs intentionally (chip columns, equal-stretch grids, slot-machine
    // strips). Require either real overflow OR clear top-slack so a pressed
    // bottom reads unambiguously as "something got crushed at the bottom".
    const TOP_SLACK_THRESHOLD_PX = 12;
    const hasTopSlack = topClearance >= TOP_SLACK_THRESHOLD_PX;
    if (!overflowing && !(pressedBottom && flowsTopDown && hasTopSlack)) continue;

    const why = overflowing
      ? `scrollHeight ${container.scrollHeight} > clientHeight ${container.clientHeight}`
      : `bottom child pressed (clearance ${Math.round(botClearance)}px) with ${Math.round(topClearance)}px top-slack and justify-content=${justifyContent} — slack was meant to live at the bottom but isn't`;

    const key = `${sid}|cramped|${selectorFor(container)}`;
    if (reportedCramp.has(key)) continue;
    reportedCramp.add(key);

    v.push({
      type: "content-cramped-container",
      scene_id: sid,
      file: compRel,
      selector: selectorFor(container),
      text: "",
      metric: {
        container_height_px: Math.round(cr.height),
        content_height_px: Math.round(cr.height - padTop - padBottom),
        scroll_height_px: container.scrollHeight,
        client_height_px: container.clientHeight,
        top_clearance_px: Math.round(topClearance),
        bottom_clearance_px: Math.round(botClearance),
        child_count: kids.length,
        justify_content: justifyContent,
        pressed_bottom: pressedBottom,
        overflowing,
        topmost_child_selector: topKid ? selectorFor(topKid) : null,
        bottommost_child_selector: botKid ? selectorFor(botKid) : null,
      },
      principle: `Container "${selectorFor(container)}" reports: ${why} (top clearance ${Math.round(topClearance)}px, bottom clearance ${Math.round(botClearance)}px, container height ${Math.round(cr.height)}px with ${kids.length} foreground children). Visual result is squeezed/crushed interior.`,
      suggestion: `Either increase the container's height so children have ≥${cfg.crampedClearancePx * 2}px clearance on the pressed edge(s), OR reduce a child (shrink padding / gap / one font size / drop a non-essential child like a sign-off mark), OR loosen flex gap. Do NOT just remove the bottom child — preserve the brief's content but resize the container to fit. If the cramping was caused upstream by a caption-keepout "shrink height" Edit, re-derive the target height using the real bbox (with transform) before applying.`,
      fix_kind: "manual",
    });
  }

  // ── Check 7: low-contrast-foreground (text / inline-svg asset placed on
  //    a background it cannot read against — the signature of a wordmark
  //    that was authored for one surface and dropped onto another) ──
  // WCAG luminance + contrast ratio. Walks ancestors for the first
  // non-transparent background-color; if none, treats the canvas root as
  // the surface (its `background` may be a token; for color-only backgrounds
  // it resolves to a literal rgba). Skips elements whose background ancestor
  // also has a `background-image` (gradients / textures often defeat a flat
  // color contrast check; the visual-eye snapshot owns those).
  const parseRgb = (s) => {
    if (!s) return null;
    let m = s.match(
      /^rgba?\((\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*([\d.]+))?\)$/i,
    );
    if (m) {
      const a = m[4] === undefined ? 1 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let hex = m[1];
      if (hex.length === 3)
        hex = hex
          .split("")
          .map((c) => c + c)
          .join("");
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
          a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
      }
    }
    return null;
  };
  const relLuminance = (rgb) => {
    const ch = [rgb.r, rgb.g, rgb.b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const contrastRatio = (fg, bg) => {
    const l1 = relLuminance(fg);
    const l2 = relLuminance(bg);
    const hi = Math.max(l1, l2),
      lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  // Walk to the first element (starting WITH `el` itself, then ancestors) whose
  // background-color is opaque enough to "set the surface". Starting with `el`
  // matters for button-like patterns where the text-bearing element IS the
  // button and its own background paints the surface for its text (a parent
  // walk would skip past it and pick up the card behind, falsely claiming the
  // text sits on the card).
  // `rgba(0,0,0,0)` is transparent / inherits, skip it. If the resolved
  // ancestor uses a background-image (gradient/texture/url), mark the surface
  // as unresolved → skip the check (false positives are worse than missed ones
  // on gradient backgrounds).
  const surfaceFor = (el) => {
    let p = el;
    while (p) {
      const cs = getComputedStyle(p);
      const bg = parseRgb(cs.backgroundColor);
      const bgImg = cs.backgroundImage;
      if (bg && bg.a > 0.3) {
        if (bgImg && bgImg !== "none") return { rgb: null, unresolved: true, host: p };
        return { rgb: bg, unresolved: false, host: p };
      }
      p = p.parentElement;
    }
    // Fallback: page body / html background — almost always #fff in our probe
    // shell, so default to white.
    return { rgb: { r: 255, g: 255, b: 255, a: 1 }, unresolved: false, host: document.body };
  };
  // Inline-SVG dominant fill: walks paths / shapes, picks the most-common
  // non-none, non-url() fill. Returns null when every shape uses gradients
  // (the dominant color is then unknowable without rendering — visual-eye
  // owns it).
  const inlineSvgDominantFill = (svgEl) => {
    const shapes = svgEl.querySelectorAll(
      "path, rect, circle, ellipse, polygon, polyline, text, line",
    );
    const tally = new Map();
    for (const s of shapes) {
      let fill = s.getAttribute("fill");
      if (!fill || fill === "none" || fill === "transparent") {
        // CSS computed fill as fallback
        fill = getComputedStyle(s).fill;
      }
      if (!fill || fill === "none" || fill === "transparent") continue;
      if (/url\(/.test(fill)) continue; // gradient / pattern — skip
      // Normalize named colors via a throwaway computed-style trick
      const probe = document.createElement("span");
      probe.style.color = fill;
      document.body.appendChild(probe);
      const rgb = parseRgb(getComputedStyle(probe).color);
      probe.remove();
      if (!rgb) continue;
      const key = `${rgb.r},${rgb.g},${rgb.b}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    if (!tally.size) return null;
    let bestKey = null,
      bestCount = 0;
    for (const [k, c] of tally) {
      if (c > bestCount) {
        bestCount = c;
        bestKey = k;
      }
    }
    const [r, g, b] = bestKey.split(",").map(Number);
    return { r, g, b, a: 1 };
  };

  // 7a. Large-text contrast.
  for (const c of candidates) {
    if (c.deco) continue;
    if (hasAriaHidden(c.el)) continue;
    if (c.fs < cfg.contrastMinTextFontPx) continue;
    const cs = getComputedStyle(c.el);
    const fg = parseRgb(cs.color);
    if (!fg) continue;
    const surf = surfaceFor(c.el);
    if (surf.unresolved) continue;
    if (!surf.rgb) continue;
    const ratio = contrastRatio(fg, surf.rgb);
    if (ratio >= cfg.contrastMinRatio) continue;
    v.push({
      type: "low-contrast-foreground",
      scene_id: sid,
      file: compRel,
      selector: c.sel,
      text: c.txt.length > 60 ? c.txt.slice(0, 57) + "…" : c.txt,
      metric: {
        kind: "text",
        font_size_px: Math.round(c.fs * 10) / 10,
        foreground_rgb: `rgb(${fg.r},${fg.g},${fg.b})`,
        surface_rgb: `rgb(${surf.rgb.r},${surf.rgb.g},${surf.rgb.b})`,
        surface_host_selector: selectorFor(surf.host),
        contrast_ratio: Math.round(ratio * 100) / 100,
        wcag_aa_large_required: 3.0,
      },
      principle: `Text "${c.txt.slice(0, 30)}" (${Math.round(c.fs)}px) on surface ${selectorFor(surf.host)} has WCAG contrast ${(Math.round(ratio * 100) / 100).toFixed(2)} : 1 — below ${cfg.contrastMinRatio}:1 (borderline-invisible at video resolution).`,
      suggestion: `Either (a) swap the text \`color\` to a token that contrasts with the surface (e.g. var(--hud-text) on canvas-void, var(--ink) on light surfaces); (b) change the surface (this scene's card may be on the wrong token); (c) if the asset is correct and the SURFACE was unintentionally chosen, re-pick the surface token (e.g. a dark wordmark belongs on canvas not on canvas-navy).`,
      fix_kind: "manual",
    });
  }

  // 7b. Inline-SVG asset contrast (catches wordmark / logo placed on the
  //     wrong surface; for `<img src="*.svg">` the SVG is opaque to DOM
  //     introspection — the visual-eye snapshot inspection in the finalize
  //     agent is the only safety net there, which is why the checklist in
  //     `agents/hyperframes-finalize.md` calls it out explicitly).
  const inlineSvgs = Array.from(root.querySelectorAll("svg")).filter((s) => {
    if (!isVisible(s)) return false;
    if (isInDecor(s)) return false;
    if (hasAriaHidden(s)) return false;
    const r = s.getBoundingClientRect();
    return r.width >= cfg.contrastMinAssetSizePx && r.height >= 40;
  });
  for (const svg of inlineSvgs) {
    const dominant = inlineSvgDominantFill(svg);
    if (!dominant) continue;
    const surf = surfaceFor(svg);
    if (surf.unresolved || !surf.rgb) continue;
    const ratio = contrastRatio(dominant, surf.rgb);
    if (ratio >= cfg.contrastMinRatio) continue;
    const r = svg.getBoundingClientRect();
    v.push({
      type: "low-contrast-foreground",
      scene_id: sid,
      file: compRel,
      selector: selectorFor(svg),
      text: "(inline svg asset)",
      metric: {
        kind: "inline-svg",
        bbox: `(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)}`,
        dominant_fill_rgb: `rgb(${dominant.r},${dominant.g},${dominant.b})`,
        surface_rgb: `rgb(${surf.rgb.r},${surf.rgb.g},${surf.rgb.b})`,
        surface_host_selector: selectorFor(surf.host),
        contrast_ratio: Math.round(ratio * 100) / 100,
        wcag_aa_large_required: 3.0,
      },
      principle: `Inline SVG dominant fill rgb(${dominant.r},${dominant.g},${dominant.b}) against surface rgb(${surf.rgb.r},${surf.rgb.g},${surf.rgb.b}) on ${selectorFor(surf.host)} has WCAG contrast ${(Math.round(ratio * 100) / 100).toFixed(2)} : 1 — borderline-invisible.`,
      suggestion: `The SVG was likely authored for the inverse surface tone. Either (a) swap the asset for the surface-appropriate variant (e.g. dark-on-light → light-on-dark variant) — many capture libraries ship two; (b) move the asset onto a contrasting plate token; (c) recolor inline (only when you own the SVG paths). Check the capture's asset-descriptions for a sibling variant before defaulting to recolor.`,
      fix_kind: "manual",
    });
  }

  // ── Check 8: foreground-over-opaque-panel ──
  // A non-decorative text node overlaps an opaque sibling panel/card it is NOT
  // inside. Catches supporting text (or any text below the 40px display tier)
  // bleeding onto a primary card/panel edge — the gap that 3a (primary↔primary)
  // and 3b (text↔text ≥40px) both leave open. Runs EVEN under
  // data-layout-allow-overflow (like Check 5): that attribute is for decorative
  // bleed and must not hide a real text/panel collision.
  const opaquePanels = [];
  for (const el of all) {
    if (!isVisible(el) || isInDecor(el)) continue;
    const pr = el.getBoundingClientRect();
    if (pr.width < cfg.panelMinSidePx || pr.height < cfg.panelMinSidePx) continue;
    if (pr.width >= window.innerWidth * 0.92 && pr.height >= window.innerHeight * 0.92) continue; // full-frame backdrop, not a panel
    const bg = parseRgb(getComputedStyle(el).backgroundColor);
    if (!bg || bg.a < cfg.panelMinBgAlpha) continue;
    opaquePanels.push({ el, rect: pr });
  }
  const reportedBleed = new Set();
  for (const c of candidates) {
    if (c.deco) continue;
    if (c.fs < cfg.panelBleedMinFontPx) continue;
    if (hasAriaHidden(c.el)) continue;
    const t = c.rect;
    const tArea = t.width * t.height;
    if (tArea <= 0) continue;
    for (const p of opaquePanels) {
      if (p.el === c.el || isAncestor(p.el, c.el) || isAncestor(c.el, p.el)) continue; // inside it = legitimate
      const ix = Math.max(0, Math.min(t.right, p.rect.right) - Math.max(t.left, p.rect.left));
      const iy = Math.max(0, Math.min(t.bottom, p.rect.bottom) - Math.max(t.top, p.rect.top));
      const inter = ix * iy;
      if (inter <= 0) continue;
      const frac = inter / tArea;
      // Straddle only: a minority of the text dips over the panel edge. Full /
      // majority containment (frac → 1) is text placed ON the panel as content
      // (often a sibling layer, not a DOM child) — not an edge-bleed. z-order is
      // not considered, so a partial straddle behind a higher panel is a known
      // (rare) false-positive.
      if (frac < cfg.panelBleedOverlapFrac || frac > cfg.panelBleedMaxFrac) continue;
      const key = `${sid}|bleed|${c.sel}|${selectorFor(p.el)}`;
      if (reportedBleed.has(key)) continue;
      reportedBleed.add(key);
      v.push({
        type: "foreground-over-panel",
        scene_id: sid,
        file: compRel,
        selector: c.sel + " over " + selectorFor(p.el),
        text: c.txt.length > 60 ? c.txt.slice(0, 57) + "…" : c.txt,
        metric: {
          font_size_px: Math.round(c.fs * 10) / 10,
          overlap_of_text: Math.round(frac * 1000) / 1000,
          text_bbox: `(${Math.round(t.left)},${Math.round(t.top)}) ${Math.round(t.width)}x${Math.round(t.height)}`,
          panel_bbox: `(${Math.round(p.rect.left)},${Math.round(p.rect.top)}) ${Math.round(p.rect.width)}x${Math.round(p.rect.height)}`,
        },
        principle: `Text "${c.txt.slice(0, 30)}" overlaps opaque panel ${selectorFor(p.el)} by ${(frac * 100).toFixed(0)}% of its bbox without being inside it — reads as text bleeding onto the panel edge. Not covered by primary↔primary or text↔text checks; data-layout-allow-overflow does NOT exempt it.`,
        suggestion: `Reserve a gutter: move/narrow the text column (or the panel) so panel.right < text.left (or text.right < panel.left). Verify the gap numerically — don't eyeball. If this element is a connector/leader meant to touch the panel, mark it decorative (aria-hidden="true" or a decorative class) to exclude it.`,
        fix_kind: "manual",
      });
      break;
    }
  }

  return v;
};

// ─────────────────────────────────────────── per-scene render loop ───
// Probe each scene at 3 hold frames after entry / mid / climax. Most reveals
// (discrete-text-sequence, 3d-text-depth-layers, counting-dynamic-scale) finish
// in the second half of the scene, so a single midpoint sample misses the
// most-visually-problematic state. Aggregate violations across all frames and
// dedup by (scene_id, type, text, selector_hash).
const PROBE_RATIOS = [0.4, 0.7, 0.92];

for (const grp of groupSpec.groups) {
  for (const [sid, scene] of Object.entries(grp.scenes)) {
    const compRel = `compositions/${sid}.html`;
    const compPath = join(projectRoot, compRel);
    if (!existsSync(compPath)) {
      scenesSkipped++;
      console.error(`  skipped ${sid}: ${compRel} not found`);
      continue;
    }

    const sceneHtml = readFileSync(compPath, "utf8");
    const tmplMatch = sceneHtml.match(/<template[^>]*>([\s\S]*?)<\/template>/);
    if (!tmplMatch) {
      scenesSkipped++;
      console.error(`  skipped ${sid}: no <template> found`);
      continue;
    }

    const innerHtml = tmplMatch[1];
    const probeTimes = PROBE_RATIOS.map((r) => +(scene.estimatedDuration_s * r).toFixed(3));
    const probePath = join(projectRoot, `_probe-${sid}.html`);
    cleanupPaths.push(probePath);

    const probeHtml = `<!doctype html>
<html><head>
<meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${CANVAS_W}px;height:${CANVAS_H}px;overflow:hidden;background:#fff;font-family:system-ui,sans-serif;}
${brandTokensCss ? `/* brand design tokens — mirrors index.html <head> so var(--*) backgrounds/colors resolve */\n${brandTokensCss}` : ""}
${fontFaceCss ? `/* brand @font-face — mirrors index.html <head> so text renders in the real face */\n${fontFaceCss}` : ""}
</style>
<script src="${values["gsap-cdn"]}"></script>
</head>
<body>
${innerHtml}
</body></html>`;

    writeFileSync(probePath, probeHtml);

    let page;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: CANVAS_W, height: CANVAS_H, deviceScaleFactor: 1 });
      await page.goto(`file://${probePath}`, { waitUntil: "networkidle0", timeout: 30000 });

      // Block on brand @font-face loading — text-clipping / depth-ghost width
      // metrics are font-dependent, so measuring before fonts swap in would
      // read the system-ui fallback and silently under-report clipping.
      await page.evaluate(() =>
        document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true,
      );

      const tlReady = await page.evaluate(
        (sid) =>
          new Promise((resolve) => {
            const start = Date.now();
            const tick = () => {
              if (window.gsap && window.__timelines && window.__timelines[sid])
                return resolve(true);
              if (Date.now() - start > 5000) return resolve(false);
              setTimeout(tick, 50);
            };
            tick();
          }),
        sid,
      );
      if (!tlReady) {
        scenesNoTimeline++;
        console.error(
          `  ⚠ ${sid}: timeline never registered on window.__timelines — probing t=0 frame only`,
        );
      }

      // Probe at multiple times; aggregate + dedup violations per scene.
      // CRITICAL: GSAP's seek() default is suppressEvents=true, so onUpdate
      // callbacks (used by discrete-text-sequence drivers, depth-layer text
      // mutators, ASR glow envelopes) DON'T fire. Pass `false` as 2nd arg so
      // worker scripts that drive textContent via onUpdate are actually
      // applied at the seek time.
      const sceneRawViolations = [];
      for (const t of probeTimes) {
        await page.evaluate(
          (sid, t) => {
            const tl = window.__timelines && window.__timelines[sid];
            if (tl) tl.seek(t, false);
          },
          sid,
          t,
        );
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        await new Promise((r) => setTimeout(r, 60));
        const frameVio = await page.evaluate(PROBE, sid, compRel, CFG, CANVAS_W, CANVAS_H);
        for (const fv of frameVio) sceneRawViolations.push({ ...fv, probe_t: t });
      }
      // Dedup: keep the worst (largest metric) per (type, text, selector)
      const seen = new Map();
      for (const v of sceneRawViolations) {
        const key = `${v.type}|${v.text || ""}|${v.selector || ""}`;
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, v);
          continue;
        }
        // pick the one with bigger overflow / offset / lower font
        const sevOf = (x) => {
          if (x.type === "text-clipping")
            return Math.max(x.metric?.overflow_right_px || 0, x.metric?.overflow_bottom_px || 0);
          if (x.type === "depth-layer-ghost-on-long-word") return x.metric?.leading_offset_px || 0;
          if (x.type === "primary-collision") return x.metric?.iou || 0;
          if (x.type === "primary-offscreen") return x.metric?.clipped_pct || 0;
          if (x.type === "font-too-small") return -(x.metric?.font_size_px || 999);
          if (x.type === "object-overlap") return x.metric?.overlap_of_smaller || 0;
          return 0;
        };
        if (sevOf(v) > sevOf(prev)) seen.set(key, v);
      }
      violations.push(...seen.values());
      scenesScanned++;
    } catch (err) {
      scenesFailed++;
      console.error(`  ✗ ${sid}: ${err.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
}

await browser.close();

// ─────────────────────────────────────────── cleanup + report ───
for (const p of cleanupPaths) {
  try {
    rmSync(p);
  } catch {}
}

// ── Augment text-clipping violations with edit-ready Edit() strings ──
// When a unique CSS rule "<selector> { ... font-size: <Npx>; ... }" supplies
// the element's font-size AND we can locate that rule inside the scene file,
// emit `edit_old` / `edit_new` so the finalize agent applies the fix with one
// no-Read Edit() call (same UX as caption_keepout violations).
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const v of violations) {
  if (v.type !== "text-clipping") continue;
  if (!v.css_font_size_rule) continue;
  // Only auto-fix horizontal overflow — vertical overflow usually needs a real
  // layout decision (line-height, container height, repositioning).
  const oR = v.metric.overflow_right_px || 0;
  const oL = v.metric.overflow_left_px || 0;
  if (oR + oL === 0) continue;

  const current = v.css_font_size_rule.fontSizePx;
  const naturalW = v.metric.natural_width_px;
  const visibleW = v.metric.visible_width_px;
  // Target font-size so natural width fits in 95% of visible width
  const targetSize = Math.max(20, Math.floor((current * visibleW * 0.95) / naturalW));
  if (targetSize >= current) continue;

  const filePath = join(projectRoot, v.file);
  if (!existsSync(filePath)) continue;
  const content = readFileSync(filePath, "utf8");

  // Find the rule block in the file. CSSOM cssText reformats whitespace, so
  // search by selector + opening brace + the font-size line.
  const selRaw = v.css_font_size_rule.selectorText;
  const fontSizeRx = new RegExp(`font-size:\\s*${current}(?:\\.\\d+)?px\\s*;`, "g");
  const sizeOccurrences = (content.match(fontSizeRx) || []).length;

  if (sizeOccurrences === 1) {
    // Unique font-size value across the whole file → simplest Edit
    const match = content.match(fontSizeRx);
    v.edit_old = match[0];
    v.edit_new = `font-size: ${targetSize}px;`;
    v.edit_old_is_unique = true;
    v.fix_kind = "edit-ready";
    v.recommended_font_size_px = targetSize;
  } else if (sizeOccurrences > 1) {
    // Try to scope the match to the rule block by anchoring on the selector
    const sels = selRaw.split(",").map((s) => s.trim());
    for (const sel of sels) {
      const escSel = escapeRegExp(sel);
      const blockRx = new RegExp(
        `(${escSel}\\s*\\{[^}]*?font-size:\\s*${current}(?:\\.\\d+)?px\\s*;)`,
        "s",
      );
      const m = content.match(blockRx);
      if (m) {
        const newBlock = m[1].replace(fontSizeRx, `font-size: ${targetSize}px;`);
        // Confirm the scoped match is itself unique in the file
        if (content.split(m[1]).length === 2) {
          v.edit_old = m[1];
          v.edit_new = newBlock;
          v.edit_old_is_unique = true; // unique BY scoped block
          v.fix_kind = "edit-ready";
          v.recommended_font_size_px = targetSize;
          v.edit_scoped_selector = sel;
          break;
        }
      }
    }
    if (v.fix_kind !== "edit-ready") {
      v.recommended_font_size_px = targetSize; // advisory only
    }
  }
}

violations.sort(
  (a, b) =>
    a.scene_id.localeCompare(b.scene_id) ||
    a.type.localeCompare(b.type) ||
    (a.text || "").localeCompare(b.text || ""),
);
const bySceneType = {};
for (const v of violations) {
  (bySceneType[v.scene_id] = bySceneType[v.scene_id] || []).push(v);
}

const report = {
  generated_at: new Date().toISOString(),
  driver: executablePath ? "puppeteer-core" : "puppeteer",
  executable_path: executablePath || "(puppeteer bundled)",
  scenes_scanned: scenesScanned,
  scenes_failed: scenesFailed,
  scenes_skipped: scenesSkipped, // in group_spec but no file/<template> → never probed
  scenes_no_timeline: scenesNoTimeline, // probed at t=0 only (timeline never registered)
  violations_count: violations.length,
  violations,
  by_scene: bySceneType,
};
writeFileSync(values.out, JSON.stringify(report, null, 2));

// Coverage caveat — surface partial scans loudly so a green report isn't trusted
// blindly when some scenes weren't (fully) measured.
if (scenesSkipped || scenesNoTimeline || scenesFailed) {
  console.log(
    `  ⚠ coverage: ${scenesSkipped} skipped (no file/template), ${scenesNoTimeline} probed at t=0 only (no timeline), ${scenesFailed} errored`,
  );
}

if (violations.length === 0) {
  console.log(`✓ check-rendered-perception: ${scenesScanned} scene(s) scanned, 0 violations`);
  process.exit(0);
}

console.log(
  `✗ check-rendered-perception: ${violations.length} violation(s) across ${Object.keys(bySceneType).length} scene(s)`,
);
for (const sid of Object.keys(bySceneType).sort()) {
  console.log(`  [${sid}] ${bySceneType[sid].length} issue(s)`);
  for (const v of bySceneType[sid]) {
    const metric = v.metric
      ? Object.entries(v.metric)
          .map(([k, val]) => `${k}=${val}`)
          .join(" ")
      : "";
    console.log(`    ${v.type}: "${v.text}" (${metric})`);
    console.log(`      → ${v.suggestion}`);
  }
}
console.log(`\n  full report: ${values.out}`);
process.exit(0);
