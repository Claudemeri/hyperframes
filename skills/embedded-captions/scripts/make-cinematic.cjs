#!/usr/bin/env node
/*
 * make-cinematic.cjs — compile cinematic.json → plan.json (then make-composition.cjs).
 * CINEMATIC MODE, raised to BLOCK level. The agent authors thought-BLOCKS — lines of
 * words, which plane each block stacks in, at most one promoted HERO word — and the
 * compiler lowers that into the classic plan.json with everything deterministic
 * generated, so the Cinematic failure modes seen in the wild become impossible:
 *   - READING ORDER by construction: lines stack in declaration order inside a flex
 *     plane (spoken order = visual order; a hero can never sit below later words)
 *   - timings from the transcript BY SEQUENCE (no hand-copied times; duplicates by position)
 *   - accumulate-within-block / page-flip-between-blocks rhythm generated:
 *     lines of a block share the block's out (they accumulate, then clear together
 *     when the next block's first word lands); the NEXT block enters fresh
 *   - hero hand-off: the promoted word is lifted OUT of its line, enters as the hero
 *     (its own plane, BIG) when spoken, holds to the END of its block, exits cleanly
 *   - fg fallback: safe-zones verdict "fg" → caption_layer:"fg" automatically
 *
 *   node make-cinematic.cjs <project-dir>
 *
 * cinematic.json schema:
 * {
 *   "template": "cinematic-cream",
 *   "width": 1920, "height": 1080, "fps": 30,
 *   "planes": {                       // layout REGIONS — place them using safe-zones.json
 *     "narr": "top: 14%; left: 4%; width: 26%;",            // string or {css}
 *     "hero": null                    // null/absent → auto from safe-zones heroAnchor
 *   },
 *   "blocks": [
 *     { "plane": "narr", "lines": [
 *         { "words": ["You","need","to"],        "css": "font-size: calc(0.05*var(--h)); font-weight:600;" },
 *         { "words": ["judge","us","by","the"],  "css": "font-size: calc(0.062*var(--h)); font-weight:700;" },
 *         { "words": ["actions"],                "hero": true,
 *           "text": "ACTIONS", "css": "font-size: calc(0.24*var(--h)); font-weight:900; text-transform:uppercase;" },
 *         { "words": ["that","we","take."],      "css": "font-size: calc(0.05*var(--h));" }
 *       ] },
 *     { "plane": "narr", "lines": [ ... next thought ... ] }
 *   ],
 *   "tones": { "default": "soft", "hero": "present" }       // optional
 * }
 * Rules: words must match the transcript verbatim in spoken order across all blocks.
 * Mark at most ONE line "hero": true per clip (scarcity); its words form the hero
 * (usually a single word; "text" overrides the display form).
 */
const path = require("path");
const fs = require("fs");

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9']/g, "");
const LOOKAHEAD = 40;
function die(m) { console.error(`[make-cinematic] ${m}`); process.exit(1); }

function main() {
  const project = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) die("usage: make-cinematic.cjs <project-dir>");
  const cj = path.join(project, "cinematic.json");
  const tj = path.join(project, "transcript.json");
  if (!fs.existsSync(cj)) die(`missing ${cj} — author it first (schema in this header)`);
  if (!fs.existsSync(tj)) die(`missing ${tj} — run prepare.sh first`);
  const C = JSON.parse(fs.readFileSync(cj, "utf8"));
  const tr = (JSON.parse(fs.readFileSync(tj, "utf8")).words || []).filter((w) => w && "start" in w && "end" in w);
  if (!tr.length) die("transcript has no word timings");

  // safe-zones: fg verdict + heroAnchor default
  let sz = null;
  try { sz = JSON.parse(fs.readFileSync(path.join(project, "safe-zones.json"), "utf8")); } catch (e) {}
  // author override first (borderline scenes: coverage near the line, agitated subject),
  // else the safe-zones verdict.
  // narration legibility follows the verdict; the HERO is judged separately — it WANTS
  // occlusion (~30–55% is the product). fg for the hero is the LAST resort: only when no
  // height band achieves ≤62% predicted occlusion (safe-zones heroBands). An explicit
  // author caption_layer:"fg" still forces everything front.
  const authorFg = C.caption_layer === "fg";
  const narrFg = authorFg || (sz && sz.recommendation === "fg");
  const hb = sz && sz.heroBands;
  const heroFeasible = authorFg ? false : (hb ? hb.feasible : !narrFg);
  const globalFg = narrFg; // narration layer (name kept for the lowering below)

  const W = C.width || 1920, H = C.height || 1080, FPS = C.fps || 24;
  const blocks = C.blocks || [];
  if (!blocks.length) die("blocks is empty");

  // ── sequence-match every word across blocks/lines ──────────────────────────
  let p = 0; const missing = [];
  for (const b of blocks) for (const ln of (b.lines || [])) {
    ln._w = (ln.words || []).map((text) => {
      const t = norm(text);
      let f = -1;
      for (let j = p; j < Math.min(tr.length, p + LOOKAHEAD); j++) if (norm(tr[j].text) === t) { f = j; break; }
      if (f < 0) { missing.push(text); return { text, start: null, end: null }; }
      p = f + 1;
      return { text, start: tr[f].start, end: tr[f].end, ti: f };
    });
  }
  if (missing.length) die(`words not in transcript (in order): ${missing.join(" ")} — lines must match the transcript verbatim`);

  // ── block windows: in = first word −lead; out = page-flip = next block's first word −0.28 (or +1.2 hold) ──
  const LEAD = 0.18;
  const bw = blocks.map((b) => {
    const ws = (b.lines || []).flatMap((l) => l._w);
    return { first: Math.min(...ws.map((w) => w.start)), last: Math.max(...ws.map((w) => w.end)) };
  });
  let srcDur = null;
  try {
    const cp = require("child_process");
    for (const f of ["source.mp4"].concat(fs.readdirSync(project).filter((x) => /\.(mp4|mov|webm)$/i.test(x)))) {
      const fp = path.join(project, f); if (!fs.existsSync(fp)) continue;
      const d = parseFloat(cp.execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", fp], { encoding: "utf8" }));
      if (d > 0) { srcDur = d; break; }
    }
  } catch (e) {}
  const DUR = +(srcDur || bw[bw.length - 1].last + 0.6).toFixed(3);
  // ── SLOT layout + paging. Lines get FIXED absolute positions (no flex reflow — the
  // "lower line jumps up when the upper one clears" bug is impossible by construction).
  // Lines accumulate down the plane like a poem; the plane PAGE-FLIPS (all visible lines
  // clear together, the next line restarts at the top) only when (a) the plane is full,
  // (b) a block sets "flip": true, or (c) a block boundary coincides with a real speech
  // pause (≥0.6s). Block windows (bw) are kept only for the hero's hold.
  for (let i = 0; i < bw.length; i++) {
    bw[i].in = Math.max(0, bw[i].first - LEAD);
    bw[i].out = Math.min(DUR - 0.05, Math.min(bw[i].last, DUR - 0.05) + 0.9);
  }
  const fracOfLine = (css) => { const m = (css || "").match(/font-size\s*:\s*calc\(\s*([\d.]+)\s*\*\s*var\(--h\)/); return m ? +m[1] : 0.05; };
  const planeBudgetPx = (pk) => {
    const css = (C.planes && C.planes[pk] && (typeof C.planes[pk] === "string" ? C.planes[pk] : C.planes[pk].css)) || "";
    const m = css.match(/height\s*:\s*([\d.]+)%/);
    return (m ? +m[1] / 100 : 0.30) * H;
  };

  // ── planes: agent's + auto hero plane from safe-zones heroAnchor ────────────
  const planes = {};
  for (const [k, v] of Object.entries(C.planes || {})) {
    if (v == null) continue;
    let css = typeof v === "string" ? v : (v.css || "");
    if (!/text-align\s*:/.test(css)) css += " text-align:center;"; // slot children are absolute; only alignment carries
    planes[k] = { css };
  }
  let heroPlaneName = null;
  const heroLine = blocks.flatMap((b, bi) => (b.lines || []).map((l) => ({ l, bi }))).find((x) => x.l.hero === true);
  if (heroLine) {
    heroPlaneName = "hero";
    if (!planes.hero) {
      const a = sz && sz.heroAnchor && sz.heroAnchor.plane;
      let heroTop = a ? a.yPct : 30;
      if (a && hb && hb.profile && hb.best) {
        const near = hb.profile.reduce((x, y) => Math.abs(y.topPct - heroTop) < Math.abs(x.topPct - heroTop) ? y : x);
        if (near.occPct > 62) { console.log(`[make-cinematic] heroAnchor band ${heroTop}% predicts ${near.occPct}% occlusion → moved to ${hb.best.topPct}% (predicted ${hb.best.occPct}%)`); heroTop = +(hb.best.topPct + 6.5).toFixed(1); } // band top → center
      }
      const heroFrac = (heroLine.l.css || "").match(/calc\(\s*([\d.]+)\s*\*\s*var\(--h\)/);
      const halfPct = (heroFrac ? +heroFrac[1] : 0.24) * 100 * 1.12 / 2 + 0.6;
      heroTop = +Math.min(100 - halfPct, Math.max(halfPct, heroTop)).toFixed(1);
      planes.hero = { css: a
        ? `top: ${heroTop}%; left: ${a.xPct}%; width: ${a.wPct}%; text-align: center;`
        : `top: ${heroTop}%; left: 8%; width: 84%; text-align: center;` };
    }
  }

  // ── lower to classic plan.json groups (slot layout + per-plane paging) ─────
  const tones = C.tones || {};
  const groups = [];
  let heroRef = null;
  const flat = [];
  blocks.forEach((b, bi) => {
    for (const ln of (b.lines || [])) {
      if (ln.hero === true) { heroRef = { b, bi, ln }; continue; }
      flat.push({ b, bi, ln, plane: b.plane,
        first: Math.min(...ln._w.map((w) => w.start)),
        lastEnd: Math.min(Math.max(...ln._w.map((w) => w.end)), DUR - 0.05),
        frac: fracOfLine(ln.css) });
    }
  });
  const byPlane = {};
  flat.forEach((l) => { (byPlane[l.plane] = byPlane[l.plane] || []).push(l); });
  for (const [pk, ls] of Object.entries(byPlane)) {
    const budget = planeBudgetPx(pk);
    const pages = []; let page = [], slot = 0;
    for (const l of ls) {
      const lineH = l.frac * H * 1.25 + 12;
      const prev = page[page.length - 1];
      const pauseGap = prev ? l.first - prev.lastEnd : 0;
      const boundary = prev && l.bi !== prev.bi;
      if (page.length && (slot + lineH > budget || (boundary && l.b.flip === true) || (boundary && pauseGap >= 0.6))) {
        pages.push(page); page = []; slot = 0;
      }
      l.slotPx = Math.round(slot); slot += lineH; page.push(l);
    }
    if (page.length) pages.push(page);
    pages.forEach((pg, pi) => {
      const nextFirst = pi + 1 < pages.length ? pages[pi + 1][0].first : null;
      const maxEnd = Math.max(...pg.map((l) => l.lastEnd));
      const out = nextFirst != null
        ? Math.max(maxEnd + 0.01, Math.min(DUR - 0.05, nextFirst - 0.28))
        : Math.min(DUR - 0.05, maxEnd + 1.2);
      pg.forEach((l, li) => {
        l.pageIdx = pi;
        l.out = +out.toFixed(3);
        l.in = +Math.max(0, l.first - LEAD).toFixed(3);
        // first line of a NEW page: don't enter before the old page has begun clearing
        if (li === 0 && pi > 0) l.in = +Math.min(l.first, Math.max(l.first - LEAD, pages[pi - 1][0].out - 0.02)).toFixed(3);
      });
    });
  }
  let gid = 0;
  for (const l of flat) {
    l.gid = `b${l.bi}-l${gid++}`;
    groups.push({
      id: l.gid, plane: l.plane, layer: globalFg ? "fg" : (l.ln.layer || l.b.layer || "bg"),
      tone: l.ln.tone || tones.default || "soft", allow_overlap: true,
      in: l.in, out: l.out,
      css: `position:absolute;left:0;right:0;top:${l.slotPx}px; ` + (l.ln.css || "font-size: calc(0.05 * var(--h)); font-weight: 600;"),
      words: l.ln._w.map((w) => ({ text: w.text, start: w.start, end: Math.min(w.end, DUR - 0.05), ti: w.ti })),
    });
  }
  if (heroRef) {
    const { b, bi, ln } = heroRef;
    const w0 = ln._w[0];
    groups.push({
      id: `h-${bi}`, hero: true, plane: heroPlaneName, layer: ln.layer || (heroFeasible ? "bg" : "fg"),
      tone: tones.hero || "present", allow_overlap: true,
      in: +Math.max(0, w0.start - 0.02).toFixed(3), out: +bw[bi].out.toFixed(3),
      css: ln.css || "font-size: calc(0.24 * var(--h)); font-weight: 900; text-transform: uppercase; white-space: nowrap;",
      words: ln._w.map((w, i) => ({ text: i === 0 && ln.text ? ln.text : w.text, start: w.start, end: Math.min(w.end, DUR - 0.05), ti: w.ti })),
    });
    if (!heroFeasible) console.log("[make-cinematic] no hero band ≤62% predicted occlusion → hero rendered in FRONT (last resort)");
  }
  // proximity: narration planes should HUG the silhouette (the embed reads as in-scene
  // only when typography interacts with the subject) — warn on far-parked planes.
  if (sz && sz.subject) {
    for (const [pk2, pv] of Object.entries(C.planes || {})) {
      if (pk2 === heroPlaneName || pv == null) continue;
      const css2 = typeof pv === "string" ? pv : (pv.css || "");
      const lm = css2.match(/left\s*:\s*([\d.]+)%/), wm = css2.match(/width\s*:\s*([\d.]+)%/);
      if (!lm || !wm) continue;
      const pl = +lm[1], pr = +lm[1] + +wm[1];
      const gap = pr <= sz.subject.colMinPct ? sz.subject.colMinPct - pr : (pl >= sz.subject.colMaxPct ? pl - sz.subject.colMaxPct : 0);
      if (gap > 12) console.log(`[make-cinematic] ⚠ plane "${pk2}" sits ${gap.toFixed(0)}% away from the silhouette — embeds read in-scene when text HUGS the subject (use safe-zones zones.hugLeft/hugRight, gap 2–6%)`);
    }
  }
  const plan = {
    mode: "template", template: C.template || "cinematic-cream", compiled_by: "make-cinematic.cjs",
    width: W, height: H, fps: FPS, duration: DUR,
    ...((globalFg && (!heroRef || !heroFeasible)) ? { caption_layer: "fg" } : {}), // mixed narration-fg + hero-bg → per-group layers (hybrid render)
    planes: Object.fromEntries(Object.entries(planes).map(([k, v]) => [k, { css: v.css }])),
    groups,
  };
  fs.writeFileSync(path.join(project, "plan.json"), JSON.stringify(plan, null, 2));
  console.log(`[make-cinematic] ${blocks.length} block(s) → ${groups.length} group(s)` +
    `${heroLine ? `, hero "${(heroLine.l.text || heroLine.l.words[0])}" holds to its block end` : ""}` +
    `${globalFg ? ", caption_layer=fg (safe-zones verdict)" : ""}, canvas ${DUR}s`);
  // straight into the existing template compiler
  const cp2 = require("child_process");
  let r = cp2.spawnSync("node", [path.join(__dirname, "make-composition.cjs"), project], { stdio: "inherit" });
  if ((r.status || 0) !== 0) process.exit(r.status);

  // ── RE-SLOT pass (real measurement). Compile-time slots assume each line renders as
  // ONE visual line; a narrow plane WRAPS long lines and the next slot overlaps the
  // wrapped tail. Measure every page's REAL text heights in Chromium and re-stack.
  {
    const textBoxH = (c) => {
      const ws = (c.words || []).filter((w) => (w.opacity ?? 1) > 0.05 && w.w > 0);
      if (!ws.length) return c.cap_bbox ? c.cap_bbox.h : 0;
      return Math.max(...ws.map((w) => w.y + w.h)) - Math.min(...ws.map((w) => w.y));
    };
    const pagesByKey = {};
    for (const l of flat) {
      const key = l.plane + "|" + (l.pageIdx || 0);
      (pagesByKey[key] = pagesByKey[key] || { t: +(l.out - 0.10).toFixed(2), lines: [] }).lines.push(l);
    }
    const times = [...new Set(Object.values(pagesByKey).map((pg) => pg.t))];
    if (times.length) {
      cp2.spawnSync("node", [path.join(__dirname, "measure-layout.cjs"), project, ...times.map(String)], { stdio: "ignore", timeout: 120000 });
      let lay = null;
      try { lay = JSON.parse(fs.readFileSync(path.join(project, "_layout.json"), "utf8")); } catch (e) {}
      if (lay && lay.samples) {
        let changes = 0;
        for (const pg of Object.values(pagesByKey)) {
          const sample = lay.samples.reduce((a, b) => Math.abs(b.t - pg.t) < Math.abs(a.t - pg.t) ? b : a);
          if (!sample || Math.abs(sample.t - pg.t) > 0.3) continue;
          const ordered = [...pg.lines].sort((a, b) => a.slotPx - b.slotPx);
          let top = 0;
          for (const l of ordered) {
            const cap = (sample.caps || []).find((c) => c.id === l.gid);
            const realH = cap ? textBoxH(cap) : l.frac * H * 1.25;
            if (Math.abs(top - l.slotPx) > 3) {
              const g = groups.find((g2) => g2.id === l.gid);
              g.css = g.css.replace(/top:\s*-?[\d.]+px/, "top:" + Math.round(top) + "px");
              changes++;
            }
            top += (realH || l.frac * H * 1.25) + 12;
          }
        }
        if (changes) {
          console.log(`[make-cinematic] re-slot: ${changes} line(s) re-stacked from MEASURED heights (wrapped lines accounted)`);
          fs.writeFileSync(path.join(project, "plan.json"), JSON.stringify(plan, null, 2));
          cp2.spawnSync("node", [path.join(__dirname, "make-composition.cjs"), project], { stdio: "ignore" });
          try { fs.unlinkSync(path.join(project, "_layout.json")); } catch (e) {}
        }
      }
    }
  }

  // ── HERO post-pass (real measurement, up to 2 re-emits) ────────────────────
  // (a) SIZE: a timid hero is the #1 quality kill. If the authored font leaves >25%
  //     of the usable width unused, raise it to the width-fit maximum (cap 0.34·h).
  // (b) CLEARANCE: the hero band must not overlap other visible caps (same block
  //     accumulates by design — TIME overlap is the aesthetic; SPACE overlap is a bug).
  //     If the measured hero bbox intersects another cap's bbox, shift the hero plane
  //     vertically to clear it.
  const heroG = groups.find((g) => g.hero === true);
  if (heroG) {
    const measure = () => {
      const midT = ((heroG.in + Math.min(heroG.out, heroG.in + 1.0)) / 2).toFixed(2);
      cp2.spawnSync("node", [path.join(__dirname, "measure-layout.cjs"), project, String(midT)], { stdio: "ignore", timeout: 60000 });
      try { return JSON.parse(fs.readFileSync(path.join(project, "_layout.json"), "utf8")).samples[0].caps || []; }
      catch (e) { return null; }
    };
    const fracOf = (css) => { const m = (css || "").match(/font-size\s*:\s*calc\(\s*([\d.]+)\s*\*\s*var\(--h\)/); return m ? +m[1] : null; };
    const setFrac = (css, f) => (css || "").replace(/font-size\s*:\s*[^;]+/, "font-size: calc(" + f.toFixed(3) + " * var(--h))");
    let didRaise = false;
    for (let pass = 0; pass < 3; pass++) {
      const caps = measure();
      if (!caps) break;
      // TEXT bbox = union of the word rects. cap_bbox is the CONTAINER, which a flex
      // plane stretches to the plane width — measuring it inflated a 720px word to
      // 994px and blocked the size raise (and can fake overlaps).
      const textBox = (c) => {
        const ws = (c.words || []).filter((w) => (w.opacity ?? 1) > 0.05 && w.w > 0);
        if (!ws.length) return c.cap_bbox;
        const x0 = Math.min(...ws.map((w) => w.x)), x1 = Math.max(...ws.map((w) => w.x + w.w));
        const y0 = Math.min(...ws.map((w) => w.y)), y1 = Math.max(...ws.map((w) => w.y + w.h));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      };
      const hc0 = caps.find((c) => c.id === heroG.id);
      if (!hc0 || !hc0.cap_bbox) break;
      const hc = { ...hc0, cap_bbox: textBox(hc0) };
      const others = caps.filter((c) => c.id !== heroG.id && c.cap_bbox && c.opacity > 0.05)
        .map((c) => ({ ...c, cap_bbox: textBox(c) }));
      const maxW = W * 0.94;
      const f0 = fracOf(heroG.css);
      let changed = false;
      if (f0 && hc.cap_bbox.w > 0) {
        if (hc.cap_bbox.w > maxW) {
          const nf = Math.max(0.06, f0 * maxW / hc.cap_bbox.w);
          console.log(`[make-cinematic] hero too WIDE ${Math.round(hc.cap_bbox.w)}px → ${f0}h→${nf.toFixed(3)}h`);
          heroG.css = setFrac(heroG.css, nf); changed = true;
        } else if (hc.cap_bbox.w >= maxW * 0.75) {
          if (pass === 0) console.log(`[make-cinematic] hero at width CEILING (${Math.round(hc.cap_bbox.w)}/${Math.round(maxW)}px) — cannot enlarge; a long word on a narrow frame caps the hero size. Consider a shorter display word if more impact is needed.`);
        } else if (!didRaise && hc.cap_bbox.w < maxW * 0.75) {
          const nf = Math.min(0.34, f0 * (maxW * 0.95) / hc.cap_bbox.w);
          if (nf > f0 * 1.1) {
            console.log(`[make-cinematic] hero TIMID (${Math.round(hc.cap_bbox.w)}px of ${Math.round(maxW)}px usable) → ${f0}h→${nf.toFixed(3)}h (width-fit max)`);
            heroG.css = setFrac(heroG.css, nf); changed = true; didRaise = true;
          }
        }
      }
      const hb = hc.cap_bbox;
      // collect ALL colliders, clear them in ONE jump (below the lowest, else above the highest)
      const hits = others.filter((o) => {
        const b = o.cap_bbox;
        const ix = Math.min(hb.x + hb.w, b.x + b.w) - Math.max(hb.x, b.x);
        const iy = Math.min(hb.y + hb.h, b.y + b.h) - Math.max(hb.y, b.y);
        return ix > 8 && iy > 8;
      });
      if (hits.length) {
        const maxBottom = Math.max(...hits.map((o) => o.cap_bbox.y + o.cap_bbox.h));
        const minTop = Math.min(...hits.map((o) => o.cap_bbox.y));
        const downTo = (maxBottom + 14) / H * 100;
        const upTo = Math.max(2, (minTop - hb.h - 14) / H * 100);
        const planeCss = plan.planes[heroPlaneName].css;
        const curTop = +(planeCss.match(/top:\s*([\d.]+)%/) || [0, 30])[1];
        const newTop = (downTo + hb.h / H * 100 < 96) ? downTo : upTo;
        plan.planes[heroPlaneName].css = planeCss.replace(/top:\s*[\d.]+%/, "top: " + newTop.toFixed(1) + "%");
        console.log(`[make-cinematic] hero OVERLAPS ${hits.map((o) => o.id).join(",")} — hero plane top ${curTop}% → ${newTop.toFixed(1)}%`);
        changed = true;
      }
      if (!changed) break;
      fs.writeFileSync(path.join(project, "plan.json"), JSON.stringify(plan, null, 2));
      r = cp2.spawnSync("node", [path.join(__dirname, "make-composition.cjs"), project], { stdio: "ignore" });
      try { fs.unlinkSync(path.join(project, "_layout.json")); } catch (e) {}
    }
  }
  process.exit(0);
}
main();
