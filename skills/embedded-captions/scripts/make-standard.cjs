#!/usr/bin/env node
/*
 * make-standard.cjs — compile standard.json + transcript.json → index.html + rail.html
 * (STANDARD MODE). The agent authors a small JSON of creative choices; everything
 * deterministic is GENERATED, so whole bug classes are impossible by construction:
 *   - word/group timings come from the transcript BY SEQUENCE (duplicate words resolve
 *     by position — no hand-copied times, no drift)
 *   - rail lines pre-empt: each line's exit completes before the next line's first word
 *   - the PROMOTED word is lifted OUT of the rail (never duplicated); the rail line
 *     freezes at the pre-part, the climax holds across the page-flip to the end of its
 *     thought, the rail resumes fresh — the canonical hand-off, generated every time
 *   - the canvas duration = the SOURCE clip length (no foreground-only tail)
 *   - climax line-fit: the font shrinks if the text would overflow the frame
 *   - seek-safe GSAP only (no Math.random/Date.now/CSS keyframes), one paused timeline
 *     registered on window.__timelines.main, in BOTH files
 * Also emits a derived plan.json (climax as a hero group) so the existing timing +
 * occlusion gates (incl. the hero-weak advisory) run for Standard automatically.
 *
 *   node make-standard.cjs <project-dir>
 *
 * standard.json schema (authored by the agent; see modes/standard/PIPELINE.md):
 * {
 *   "template": "didone",                  // which library template the tokens came from
 *   "width": 1920, "height": 1080, "fps": 30,
 *   "font": "Bodoni Moda",                 // climax font — LITERAL family name
 *   "rail_font": null,                     // optional rail override (decorative display faces)
 *   "cfill": "#f4efe6", "cacc": "#caa14a", // fill + active-word accent
 *   "climax_css": "font-style:italic;",    // optional extra CSS on .climax (template tokens)
 *   "rail_css": "",                        // optional extra CSS on .line
 *   "rail": {
 *     "bottom_pct": 9, "width_pct": 90, "font_cqh": 6.4,
 *     "lines": [["You","need","to"], ["judge","us","by","the","actions"], ["that","we","take."]]
 *     // ALL spoken words you want captioned, in spoken order, grouped into lines
 *     // (2-5 words/line at clause/breath boundaries). Include the promoted word where
 *     // it is spoken — the compiler lifts it out and generates the hand-off.
 *   },
 *   "climax": {
 *     "match": "actions",                  // the promoted word as it appears in rail.lines
 *     "occurrence": 1,                     // which occurrence in the flattened lines (duplicates)
 *     "text": "ACTIONS",                   // display form (often uppercase)
 *     "top_pct": 37, "font_cqh": 44,
 *     "entrance": "rise",                  // rise | scale-settle | pop
 *     "exit": "rise-off",                  // rise-off | fade | shrink-off
 *     "hold": "thought"                    // "thought" (to end of sentence) | seconds (number)
 *   }
 * }
 */
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9']/g, "");
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LOOKAHEAD = 40;

function die(msg) { console.error(`[make-standard] ${msg}`); process.exit(1); }

function sourceDurationSec(project) {
  for (const c of ["source.mp4"].concat(fs.readdirSync(project).filter((f) =>
    /\.(mp4|mov|webm|mkv|m4v)$/i.test(f) && !/^(final|bg_plus_caps|fg_caps|rail|index)/.test(f)))) {
    const p = path.join(project, c);
    if (!fs.existsSync(p)) continue;
    try {
      const d = parseFloat(cp.execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
        "-of", "default=nokey=1:noprint_wrappers=1", p], { encoding: "utf8" }).trim());
      if (d > 0) return d;
    } catch (e) {}
  }
  return null;
}

// crude width estimate (same approach as fit-fonts): chars × per-family advance × px size
const ADV = { "anton": 0.44, "oswald": 0.45, "teko": 0.40, "bebas neue": 0.40, "press start 2p": 1.05,
  "vt323": 0.52, "monoton": 0.62, "special elite": 0.55, "jetbrains mono": 0.60, "archivo black": 0.62,
  "bangers": 0.50, "bodoni moda": 0.50, "playfair display": 0.52, "cinzel": 0.62, "cormorant garamond": 0.45,
  "fredoka": 0.55, "baloo 2": 0.55, "permanent marker": 0.55, "caveat": 0.40, "orbitron": 0.66,
  "sora": 0.54, "space grotesk": 0.54, "saira stencil one": 0.46, "audiowide": 0.60, "creepster": 0.45 };

function main() {
  const project = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) die("usage: make-standard.cjs <project-dir>");
  const sj = path.join(project, "standard.json");
  const tj = path.join(project, "transcript.json");
  if (!fs.existsSync(sj)) die(`missing ${sj} — author it first (schema in this file's header / PIPELINE.md)`);
  if (!fs.existsSync(tj)) die(`missing ${tj} — run prepare.sh (or transcribe.cjs) first`);
  const S = JSON.parse(fs.readFileSync(sj, "utf8"));
  const trWords = (JSON.parse(fs.readFileSync(tj, "utf8")).words || []).filter((w) => w && "start" in w && "end" in w);
  if (!trWords.length) die("transcript has no word timings");

  const W = S.width || 1920, H = S.height || 1080, FPS = S.fps || 30;
  const srcDur = sourceDurationSec(project);
  const DUR = +(srcDur || (trWords[trWords.length - 1].end + 0.5)).toFixed(3);
  const FONT = S.font || "Inter";
  const RFONT = S.rail_font || FONT;
  const CFILL = S.cfill || "#f3efe6";
  const CACC = S.cacc || "#e3c06a";
  const rail = S.rail || {};
  const cl = S.climax || null;
  const lines = (rail.lines || []).map((ws) => ws.map((t) => String(t)));
  if (!lines.length) die("rail.lines is empty");

  // ── 1. sequence-match every rail word to the transcript ─────────────────────
  let p = 0; const unmatched = [];
  const L = lines.map((ws, li) => ({
    li, words: ws.map((text) => {
      const target = norm(text);
      let found = -1;
      for (let j = p; j < Math.min(trWords.length, p + LOOKAHEAD); j++)
        if (norm(trWords[j].text) === target) { found = j; break; }
      if (found < 0) { unmatched.push(text); return { text, start: null, end: null }; }
      p = found + 1;
      return { text, start: trWords[found].start, end: trWords[found].end, ti: found };
    }),
  }));
  if (unmatched.length) die(`words not found in transcript (in order): ${unmatched.join(" ")} — fix rail.lines to match the transcript verbatim`);

  // ── 2. locate the promoted word; lift it out (hand-off by construction) ─────
  let promo = null;
  if (cl && cl.match) {
    let want = cl.occurrence || 1, seen = 0;
    outer: for (const ln of L) for (let wi = 0; wi < ln.words.length; wi++) {
      if (norm(ln.words[wi].text) === norm(cl.match)) { seen++; if (seen === want) { promo = { ln, wi, w: ln.words[wi] }; break outer; } }
    }
    if (!promo) die(`climax.match "${cl.match}" (occurrence ${cl.occurrence || 1}) not found in rail.lines`);
  }

  // split the promoted line into pre / post segments; the promoted word joins NEITHER
  const segs = []; // {words:[..], freezeUntil?:t, kind:"normal"|"pre"|"post"}
  for (const ln of L) {
    if (!promo || ln !== promo.ln) { segs.push({ words: ln.words, kind: "normal" }); continue; }
    const pre = ln.words.slice(0, promo.wi), post = ln.words.slice(promo.wi + 1);
    if (pre.length) segs.push({ words: pre, kind: "pre" });
    if (post.length) segs.push({ words: post, kind: "post" });
  }
  const segsT = segs.filter((s) => s.words.length);
  if (!segsT.length) die("rail has no words left after lifting the climax — add narration lines");

  // ── 3. timing: line enter/exit with pre-emption; hand-off freeze + page-flip ─
  const EXIT_D = 0.22, ENTER_D = 0.22, LEAD = 0.15;
  for (let i = 0; i < segsT.length; i++) {
    const s = segsT[i];
    s.first = s.words[0].start; s.last = s.words[s.words.length - 1].end;
    s.enter = Math.max(0, s.first - LEAD);
  }
  for (let i = 0; i < segsT.length; i++) {
    const s = segsT[i], nx = segsT[i + 1];
    // default: linger after last word, but ALWAYS clear before the next line needs the slot
    let exitAt = s.last + 1.1;
    if (nx) exitAt = Math.min(exitAt, nx.enter - EXIT_D - 0.02);
    // hand-off freeze: the PRE segment holds (frozen) until the page-flip moment —
    // the first word AFTER the promoted word (post segment or next line)
    if (s.kind === "pre" && nx) exitAt = nx.enter - EXIT_D - 0.02;
    s.exit = Math.max(s.enter + ENTER_D + 0.1, Math.min(exitAt, DUR - 0.05));
  }

  // climax window: enters when spoken; holds to end of THOUGHT (sentence end in the
  // transcript), so it anchors across the rail's page-flip — then exits.
  let climax = null;
  if (promo) {
    const t0 = promo.w.start;
    let tEnd;
    if (typeof cl.hold === "number") tEnd = t0 + cl.hold;
    else { // "thought": scan transcript forward for sentence-final punctuation
      tEnd = promo.w.end + 2.2;
      for (let j = promo.w.ti; j < trWords.length; j++) {
        if (/[.!?…]$/.test(String(trWords[j].text).trim())) { tEnd = trWords[j].end + 0.35; break; }
        if (j === trWords.length - 1) tEnd = trWords[j].end + 0.35;
      }
    }
    const EXIT_C = 0.5;
    climax = { text: cl.text || promo.w.text.toUpperCase(), in: Math.max(0, t0 - 0.02),
      out: Math.min(Math.max(tEnd, t0 + 1.0), DUR - 0.05), exitD: EXIT_C,
      top: cl.top_pct ?? 37, entrance: cl.entrance || "rise", exit: cl.exit || "rise-off" };
    // line-fit: shrink font_cqh if the climax text would overflow the frame width
    let cqh = cl.font_cqh ?? 44;
    const adv = ADV[FONT.toLowerCase()] ?? 0.56;
    const estW = (climax.text.replace(/\s/g, "").length + (climax.text.split(/\s+/).length - 1) * 0.5) * adv * (cqh / 100 * H);
    const maxW = W * 0.96;
    if (estW > maxW) { cqh = Math.max(8, Math.floor(cqh * maxW / estW)); console.log(`[make-standard] climax "${climax.text}" would overflow — font ${cl.font_cqh ?? 44}cqh → ${cqh}cqh`); }
    climax.cqh = cqh;
  }

  // safe-zones drives two climax decisions (the asymmetry the cold-agent fleet exposed —
  // make-cinematic already did this; make-standard didn't, costing occlusion-gate rounds):
  //  (1) verdict "fg" (subject fills the frame) → a behind-subject embed is impossible;
  //      render the climax in FRONT (caption_layer:fg, now honored by render-and-composite).
  //  (2) bright band under the hero → bare cream text washes out → scrim + heavy stroke.
  let fgVerdict = false, heroBright = false, heroBandsS = null;
  try {
    const sz = JSON.parse(fs.readFileSync(path.join(project, "safe-zones.json"), "utf8"));
    fgVerdict = sz.recommendation === "fg";
    heroBandsS = sz.heroBands || null;
    const bl = sz.heroAnchor && sz.heroAnchor.bandLuma;
    if (bl != null && bl > 160) heroBright = true;
  } catch (e) { /* no safe-zones — behave as before */ }
  // The hero WANTS occlusion (~30–55% IS the embed). fg is the LAST resort: only when no
  // height band achieves ≤62% predicted occlusion. A frame-filling subject usually still
  // has a feasible band over the hairline — keep the cinematic feel.
  let heroFeasible = heroBandsS ? heroBandsS.feasible : !fgVerdict;
  const fgClimax = climax && !heroFeasible;
  if (climax && heroFeasible && heroBandsS && heroBandsS.profile && heroBandsS.best) {
    const near = heroBandsS.profile.reduce((a, b) => Math.abs(b.topPct - climax.top) < Math.abs(a.topPct - climax.top) ? b : a);
    if (near.occPct > 62) {
      console.log(`[make-standard] climax top ${climax.top}% sits in a ${near.occPct}%-occluded band → moved to ${heroBandsS.best.topPct}% (predicted ${heroBandsS.best.occPct}%) — the hero stays EMBEDDED`);
      climax.top = +(heroBandsS.best.topPct + 6.5).toFixed(1); // band TOP edge → hero anchors at band CENTER (translate -50%)
    }
  }
  if (fgClimax) console.log(`[make-standard] no hero band ≤62% predicted occlusion → climax rendered in FRONT (fg = last resort). Or drop "climax" from standard.json for rail-only.`);
  if (climax && heroBright) console.log(`[make-standard] hero band is bright (washout risk) → climax gets a scrim + heavy stroke.`);
  if (climax) {
    // anchor = text CENTER (translate -50%): clamp so the glyphs never leave the frame
    const halfPct = climax.cqh * 1.12 / 2 + 0.6;
    const clamped = Math.min(100 - halfPct, Math.max(halfPct, climax.top));
    if (Math.abs(clamped - climax.top) > 0.2) { console.log(`[make-standard] climax top ${climax.top}% would clip (text half-height ${halfPct.toFixed(1)}%) → ${clamped.toFixed(1)}%`); climax.top = +clamped.toFixed(1); }
  }

  // ── 4. emit index.html (climax BEHIND subject via matte, unless fg verdict) ──
  function buildIndexHtml() {
  const climaxHtml = climax
    ? `<div id="climax" class="cap climax"><span class="w">${esc(climax.text)}</span></div>`
    : "";
  const climaxCss = climax ? `
  .climax{position:absolute;left:50%;top:${climax.top}%;transform:translate(-50%,-50%);white-space:nowrap;
    font-family:'${FONT}',sans-serif;${(S.climax_css || "").trim()}
    line-height:1.12;font-size:${climax.cqh}cqh;color:${CFILL};
    ${heroBright
      ? "text-shadow:0 2px 12px rgba(0,0,0,.92),0 0 34px rgba(0,0,0,.88);-webkit-text-stroke:3px rgba(0,0,0,.7);"
      : "text-shadow:0 2px 13px rgba(0,0,0,.55),0 0 48px rgba(0,0,0,.4);-webkit-text-stroke:1px rgba(0,0,0,.45);"}
    paint-order:stroke fill}
  .climax .w{display:inline-block;opacity:0}` : "";
  const entrances = {
    "rise": `gsap.fromTo(el,{opacity:0,yPercent:48},{opacity:1,yPercent:0,duration:.9,ease:'power3.out'})`,
    "scale-settle": `gsap.fromTo(el,{opacity:0,scale:1.16},{opacity:1,scale:1,duration:.7,ease:'power3.out'})`,
    "pop": `gsap.fromTo(el,{opacity:0,scale:.55},{opacity:1,scale:1,duration:.5,ease:'back.out(1.6)'})`,
  };
  const exits = {
    "rise-off": `gsap.to(el,{opacity:0,yPercent:-42,duration:${climax ? climax.exitD : 0.5},ease:'power2.in'})`,
    "fade": `gsap.to(el,{opacity:0,duration:${climax ? climax.exitD : 0.5},ease:'power2.in'})`,
    "shrink-off": `gsap.to(el,{opacity:0,scale:.8,duration:${climax ? climax.exitD : 0.5},ease:'power2.in'})`,
  };
  const indexHtml = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}
  #a-roll{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}
  #stage{position:absolute;inset:0;z-index:2;container-type:size;pointer-events:none}${climaxCss}
</style></head><body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="${W}" data-height="${H}">
    <video id="a-roll" src="source.mp4" muted playsinline data-start="0" data-duration="${DUR}" data-track-index="0"></video>
    <div id="stage">${climaxHtml}</div>
    <audio id="a-roll-audio" src="source.mp4" data-start="0" data-duration="${DUR}" data-track-index="3" data-volume="1"></audio>
  </div>
  <script>
    window.__timelines=window.__timelines||{};
    const tl=gsap.timeline({paused:true});
    tl.add(function(){},0);
${climax ? `    (function(){const el=document.querySelector('#climax .w');
      tl.add(${entrances[climax.entrance] || entrances.rise}, ${climax.in.toFixed(3)});
      tl.add(${exits[climax.exit] || exits["rise-off"]}, ${(climax.out - climax.exitD).toFixed(3)});
    })();` : ""}
    tl.add(function(){},${DUR});
    window.__timelines["main"]=tl;
  </script>
</body></html>\n`;
  return indexHtml;
  }
  let indexHtml = buildIndexHtml();

  // ── 5. emit rail.html (verbatim rail, transparent; karaoke accent; hand-off) ─
  const lineDivs = segsT.map((s, i) =>
    `      <div id="line-${i}" class="cap line"><span class="grade-pad">${s.words.map((w, wi) =>
      `<span class="w" data-i="${wi}">${esc(w.text)}</span>`).join(" ")}</span></div>`).join("\n");
  const railFontCqh = rail.font_cqh ?? 6.4;
  const railJs = segsT.map((s, i) => {
    const wordCalls = s.words.map((w, wi) =>
      `      tl.set(W[${i}][${wi}],{opacity:1,color:'${CACC}'},${w.start.toFixed(3)});\n` +
      (wi > 0 ? `      tl.set(W[${i}][${wi - 1}],{color:'${CFILL}'},${w.start.toFixed(3)});\n` : "")).join("");
    const lastIdx = s.words.length - 1;
    return `      // line ${i} (${s.kind})\n` +
      `      tl.fromTo(LN[${i}],{opacity:0,y:14},{opacity:1,y:0,duration:${ENTER_D},ease:'power2.out'},${s.enter.toFixed(3)});\n` +
      wordCalls +
      `      tl.set(W[${i}][${lastIdx}],{color:'${CFILL}'},${Math.min(s.words[lastIdx].end + 0.25, s.exit).toFixed(3)});\n` +
      `      tl.to(LN[${i}],{opacity:0,y:-10,duration:${EXIT_D},ease:'power2.in'},${s.exit.toFixed(3)});\n` +
      `      tl.set(LN[${i}],{opacity:0},${(s.exit + EXIT_D + 0.01).toFixed(3)});\n` +
      `      tl.set(W[${i}],{opacity:0},${(s.exit + EXIT_D + 0.01).toFixed(3)});\n`;
  }).join("");
  const railHtml = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden;background:transparent}
  .grade{position:absolute;inset:0;z-index:1;pointer-events:none;
    background:radial-gradient(130% 100% at 50% 28%, transparent 42%, rgba(0,0,0,.55))}
  #stage{position:absolute;inset:0;z-index:2;container-type:size}
  .rail{position:absolute;left:50%;bottom:${rail.bottom_pct ?? 9}%;transform:translateX(-50%);width:${rail.width_pct ?? 90}%}
  .line{position:absolute;left:0;right:0;bottom:0;text-align:center;opacity:0;
    font-family:'${RFONT}',sans-serif;${(S.rail_css || "").trim()}
    line-height:1.18;font-size:${railFontCqh}cqh;color:${CFILL};
    text-shadow:0 2px 10px rgba(0,0,0,.65)}
  .line .w{display:inline-block;opacity:0;margin:0 .1em;color:${CFILL}}
</style></head><body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${DUR}" data-width="${W}" data-height="${H}">
    <div class="grade"></div>
    <div id="stage"><div class="rail">
${lineDivs}
    </div></div>
  </div>
  <script>
    window.__timelines=window.__timelines||{};
    const tl=gsap.timeline({paused:true});
    const LN=[...document.querySelectorAll('.line')];
    const W=LN.map(function(l){return [...l.querySelectorAll('.w')]});
    tl.add(function(){},0);
${railJs}      tl.add(function(){},${DUR});
    window.__timelines["main"]=tl;
  </script>
</body></html>\n`;

  // ── 6. derived plan.json → existing timing/occlusion gates run for Standard ──
  // (hero:true → the hero-weak advisory applies to the climax placement.)
  const plan = {
    mode: "standard", template: S.template || "standard", compiled_by: "make-standard.cjs",
    width: W, height: H, fps: FPS, duration: DUR,
    ...(fgClimax ? { caption_layer: "fg" } : {}),
    groups: climax ? [{ id: "climax", hero: true, in: climax.in, out: climax.out, layer: fgClimax ? "fg" : "bg",
      words: [{ text: climax.text, start: promo.w.start, end: Math.min(promo.w.end, DUR - 0.05), ti: promo.w.ti }] }] : [],
  };

  fs.writeFileSync(path.join(project, "plan.json"), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(project, "index.html"), indexHtml);
  fs.writeFileSync(path.join(project, "rail.html"), railHtml);

  // REAL-measure line-fit: the ADV estimate above is a guess (fonts/letter-spacing vary);
  // measure the actual climax bbox once in Chromium and re-emit if it overflows. This is
  // what makes "cropped text" impossible regardless of font metrics.
  if (climax) {
    const midT = ((climax.in + Math.min(climax.out, climax.in + 1.2)) / 2).toFixed(2);
    cp.spawnSync("node", [path.join(__dirname, "measure-layout.cjs"), project, String(midT)], { stdio: "ignore", timeout: 60000 });
    try {
      const lay = JSON.parse(fs.readFileSync(path.join(project, "_layout.json"), "utf8"));
      const cap = ((lay.samples && lay.samples[0] && lay.samples[0].caps) || []).find((c) => c.id === "climax");
      const maxW = W * 0.96;
      if (cap && cap.cap_bbox && cap.cap_bbox.w > maxW) {
        const newCqh = Math.max(8, Math.floor(climax.cqh * maxW / cap.cap_bbox.w));
        console.log(`[make-standard] climax REAL width ${Math.round(cap.cap_bbox.w)}px > ${Math.round(maxW)}px → ${climax.cqh}cqh → ${newCqh}cqh (re-emit)`);
        climax.cqh = newCqh;
        indexHtml = buildIndexHtml();
        fs.writeFileSync(path.join(project, "index.html"), indexHtml);
        try { fs.unlinkSync(path.join(project, "_layout.json")); } catch (e) {}
      }
    } catch (e) { /* measurement unavailable — estimate already applied */ }
  }
  console.log(`[make-standard] ${segsT.length} rail line(s)${promo ? `, climax "${climax.text}" [${climax.in.toFixed(2)}–${climax.out.toFixed(2)}s] (hand-off generated)` : " (no climax)"}, canvas ${DUR}s`);
  console.log(`[make-standard] → index.html + rail.html + plan.json (gates will check timing/occlusion/hand-off)`);
}
main();
