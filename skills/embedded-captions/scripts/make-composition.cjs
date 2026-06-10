#!/usr/bin/env node
/*
 * make-composition.cjs — compile plan.json + template → index.html (TEMPLATE MODE).
 * 1:1 Node port of make-composition.py (pure string templating, no Python).
 *   node make-composition.cjs <project-dir>
 */
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const SKILL_ROOT = path.resolve(__dirname, "..");
const TEMPLATES = path.join(SKILL_ROOT, "modes", "cinematic");

// Source clip duration (seconds) via ffprobe. The COMPOSITION/background length must
// follow the SOURCE, not the last caption — see the Bug-1 note in main().
function sourceDurationSec(project) {
  let cands = ["source.mp4"];
  try {
    cands = cands.concat(fs.readdirSync(project).filter(
      (f) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(f) && !/^(final|bg_plus_caps|fg_caps|rail|index)/.test(f)));
  } catch {}
  for (const c of cands) {
    const p = path.isAbsolute(c) ? c : path.join(project, c);
    if (!fs.existsSync(p)) continue;
    try {
      const out = cp.execFileSync("ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", p],
        { encoding: "utf8" }).trim();
      const d = parseFloat(out);
      if (d > 0) return d;
    } catch {}
  }
  return null;
}

function hexLum(hex) {
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  if ([r, g, b].some(Number.isNaN)) return 0.9;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
const defaultTextShadow = (c) => hexLum(c) < 0.45
  ? "0 2px 6px rgba(0, 0, 0, 0.28)"
  : "0 0 18px rgba(255, 220, 170, 0.55), 0 3px 8px rgba(0, 0, 0, 0.85)";
const defaultTextFilter = (c) => hexLum(c) < 0.45 ? "contrast(1.08)" : "brightness(1.1) contrast(1.05)";

function findTemplate(name) {
  const p = path.join(TEMPLATES, name, "template.html");
  if (fs.existsSync(p)) return p;
  const avail = fs.readdirSync(TEMPLATES).filter((d) => fs.existsSync(path.join(TEMPLATES, d, "template.html"))).sort();
  console.error(`[compile] unknown template: ${name}. Available: ${avail.join(", ")}`);
  process.exit(1);
}
function escBr(t) {
  const e = String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return e.replace(/&lt;br&gt;/g, "<br>").replace(/&lt;br\/&gt;/g, "<br>").replace(/&lt;br \/&gt;/g, "<br>");
}
function renderCap(g) {
  const slot = g.slot ?? g.style ?? "";
  const layerAttr = g.layer ? ` data-layer="${g.layer}"` : "";
  const cls = slot ? `cap cap-${slot}` : "cap";
  const spans = g.words.map((w, i) => `<span class="w" data-i="${i}">${escBr(w.text)}</span>`).join("\n            ");
  return `<div id="${g.id}" class="${cls}"${layerAttr}>\n            ${spans}\n          </div>`;
}
function buildGroupsHtml(groups, planes) {
  if (!planes) return groups.map(renderCap).join("\n        ");
  const order = Object.keys(planes); const grouped = {}; order.forEach((p) => (grouped[p] = [])); const free = [];
  for (const g of groups) { const pid = g.plane; if (pid && pid in grouped) grouped[pid].push(g); else free.push(g); }
  const parts = [];
  for (const pid of order) parts.push(`<div id="plane-${pid}" class="plane plane-${pid}">\n          ${grouped[pid].map(renderCap).join("\n          ")}\n        </div>`);
  for (const g of free) parts.push(renderCap(g));
  return parts.join("\n        ");
}
function buildPlanesCss(planes) {
  if (!planes) return "";
  return Object.entries(planes).map(([pid, p]) => {
    // Accept BOTH plane shapes: { body: { css: "..." } } and the bare-string
    // { body: "..." } (matches how groups write css). Reading only p.css silently
    // dropped the string form → empty CSS → planes collapsed to (0,0).
    let css = (typeof p === "string" ? p : (p || {}).css || "").trim(); if (!css) return null; if (!css.endsWith(";")) css += ";";
    return `      .plane-${pid} { ${css} }`;
  }).filter(Boolean).join("\n");
}
function buildPerGroupCss(groups) {
  return groups.map((g) => {
    const parts = []; if (g.scale != null) parts.push(`--s: ${g.scale};`);
    let css = (g.css || "").trim(); if (css) parts.push(css.endsWith(";") ? css : css + ";");
    return parts.length ? `      #${g.id} { ${parts.join(" ")} }` : null;
  }).filter(Boolean).join("\n");
}
function buildGroupsJson(groups) {
  return JSON.stringify(groups.map((g) => ({
    id: g.id, in: g.in, out: g.out, tone: g.tone ?? "soft",
    words: g.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
  })), null, 10);
}

function main() {
  const project = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) { console.error("usage: make-composition.cjs <project-dir>"); process.exit(1); }
  const planPath = path.join(project, "plan.json");
  if (!fs.existsSync(planPath)) { console.error(`[compile] missing ${planPath}`); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (plan.mode === "custom") {
    console.error("[compile] mode=custom — skip this script and hand-write index.html."); process.exit(1);
  }
  if (plan.mode === "standard") {
    console.error("[compile] mode=standard — this plan.json is DERIVED by make-standard.cjs; compile Standard projects with make-standard.cjs (from standard.json), not this script."); process.exit(1);
  }
  let src = fs.readFileSync(findTemplate(plan.template), "utf8");
  // Bug-1: the canvas/background length = SOURCE clip length, NOT the last-caption time.
  // If plan.duration < source, the bg video ends before the matte → the tail shows only
  // the foreground subject on black. Caption groups keep their own in/out (they may end
  // earlier); only the composition duration follows the source.
  const srcDur = sourceDurationSec(project);
  const renderDur = srcDur && srcDur > 0 ? srcDur : plan.duration;
  if (srcDur && Math.abs(srcDur - (plan.duration || 0)) > 0.2)
    console.log(`[compile] canvas duration → source length ${renderDur.toFixed(2)}s (plan.duration=${plan.duration}); captions keep their own times.`);
  const plane = plan.plane || {}, header = plan.header || {}, crown = plan.crown || {};
  // LOCKED DNA — Cinematic mode does NOT let the plan override colour / blend / shadow /
  // filter. Picking a template commits to its visual identity; only layout + per-group
  // typography stay agent-authored. If a scene's luminance fights the look, pick a
  // DIFFERENT template — never recolour this one. (plan.cap_color / blend_mode /
  // text_shadow / text_filter are intentionally ignored.)
  const capColor = "#fff5df";
  const g = (o, k, d) => (o && o[k] != null ? o[k] : d);
  const subs = {
    DURATION: `${renderDur}`, FPS: `${plan.fps ?? 24}`, WIDTH: `${plan.width}`, HEIGHT: `${plan.height}`,
    FONT_SCALE: `${plan.font_scale ?? 1.0}`,
    PLANE_TOP: `${g(plane, "top", 0)}`, PLANE_LEFT: `${g(plane, "left", "")}`, PLANE_RIGHT: `${g(plane, "right", "")}`,
    PLANE_WIDTH: `${g(plane, "width", 0)}`, PLANE_HEIGHT: `${g(plane, "height", 0)}`,
    ROTATE_Y: `${g(plane, "rotateY", 0)}`, ROTATE_X: `${g(plane, "rotateX", 0)}`,
    HEADER_TOP: `${g(header, "top", 0)}`, HEADER_HEIGHT: `${g(header, "height", 0)}`,
    CROWN_TOP: `${g(crown, "top", plan.crown_top ?? g(plan.crown_position || {}, "top", 440))}`,
    CROWN_LEFT: `${g(crown, "left", 0)}`, CROWN_RIGHT: `${g(crown, "right", 0)}`,
    CROWN_ALIGN: `${g(crown, "align", "center")}`, CROWN_SCALE: `${g(crown, "scale", 1.0)}`,
    BLEND_MODE: "screen", CAP_COLOR: capColor,
    TEXT_SHADOW: defaultTextShadow(capColor),
    TEXT_FILTER: defaultTextFilter(capColor),
    GROUPS_HTML: buildGroupsHtml(plan.groups, plan.planes), PLANES_CSS: buildPlanesCss(plan.planes),
    CUSTOM_CSS: buildPerGroupCss(plan.groups), GROUPS_JSON: buildGroupsJson(plan.groups),
  };
  const cg = plan.crown_group;
  if (cg) {
    const layerAttr = cg.layer ? ` data-layer="${cg.layer}"` : "";
    const spans = cg.words.map((w, i) => `<span class="w" data-i="${i}">${escBr(w.text)}</span>`).join("\n          ");
    subs.CROWN_HTML = `<div id="${cg.id}" class="cap cap-crown"${layerAttr}>\n          ${spans}\n        </div>`;
    subs.CROWN_JSON = JSON.stringify({ id: cg.id, in: cg.in, out: cg.out, tone: cg.tone ?? "present",
      words: cg.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) }, null, 10);
  } else { subs.CROWN_HTML = ""; subs.CROWN_JSON = "null"; }

  for (const [k, v] of Object.entries(subs)) src = src.split(`{{${k}}}`).join(v);
  fs.writeFileSync(path.join(project, "index.html"), src);
  console.log(`[compile] template=${plan.template} → ${path.join(project, "index.html")}`);

  // per-group FG → index_fg.html (same strategy as the Python version)
  const fgGroups = plan.groups.filter((x) => x.layer === "fg");
  if (fgGroups.length || (plan.crown_group || {}).layer === "fg") {
    const fgCss = `
    <style>
      html.fg-only body { background: #000 !important; }
      html.fg-only #fg-cover { position: absolute; inset: 0; background: #000; z-index: 1; pointer-events: none; }
      html.fg-only .cap:not([data-layer="fg"]) { display: none !important; }
    </style>
`;
    let fg = src.replace("<html ", '<html class="fg-only" ');
    fg = fg.replace("</head>", fgCss + "  </head>");
    fg = fg.replace('<div id="stage"', '<div id="fg-cover"></div>\n      <div id="stage"');
    fs.writeFileSync(path.join(project, "index_fg.html"), fg);
    console.log(`[compile] ${fgGroups.length} fg group(s) → ${path.join(project, "index_fg.html")}`);
  }
}
main();
