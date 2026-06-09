#!/usr/bin/env node
/*
 * transcribe.cjs — word-level transcription via hyperframes' native Whisper
 * (replaces the Python ElevenLabs Scribe path; no Python, no API key).
 *
 *   node transcribe.cjs <project-dir> [model] [language]
 * Reads:  <project>/source.mp4 (audio track)
 * Writes: <project>/transcript.json  — { text, language_code, words:[{text,start,end,type}] }
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const cp = require("child_process");

function hfRoot() {
  const roots = [
    process.env.HYPERFRAMES_ROOT,
    path.resolve(__dirname, "..", "..", ".."),
    path.join(os.homedir(), "Downloads", "hyperframes"),
  ].filter(Boolean);
  for (const r of roots) if (fs.existsSync(path.join(r, "packages", "cli", "dist", "cli.js"))) return r;
  console.error("[transcribe] hyperframes CLI not found — set HYPERFRAMES_ROOT"); process.exit(3);
}
function ensureSource(project) {
  const src = path.join(project, "source.mp4");
  if (fs.existsSync(src)) return src;
  const EXCL = new Set(["final", "bg_plus_caps", "fg_caps", "audio"]);
  let cands = fs.readdirSync(project)
    .filter((f) => ["mp4", "mov", "webm", "mkv", "m4v"].includes(path.extname(f).slice(1).toLowerCase())
      && !EXCL.has(path.basename(f, path.extname(f))) && !f.startsWith("index"))
    .map((f) => path.join(project, f));
  let found = cands.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  if (found) { try { fs.symlinkSync(path.basename(found), src); } catch (e) { fs.copyFileSync(found, src); } }
  return src;
}
function usableWords(d) {
  return d && Array.isArray(d.words) && d.words.some((w) => w && "start" in w && "end" in w);
}
// Mean loudness of the audio, for the no-speech guard below. Silence → whisper
// hallucinates (famously "Thank you."), and the decision gate refuses "no speech".
function meanVolumeDb(audio) {
  try {
    // ffmpeg writes volumedetect stats to STDERR — capture it (spawnSync, no throw).
    const r = cp.spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", audio, "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8" });
    const out = (r.stderr || "") + (r.stdout || "");
    const m = out.match(/mean_volume:\s*(-?[\d.]+) dB/);
    return m ? parseFloat(m[1]) : null;
  } catch (e) { return null; }
}

function main() {
  const project = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) { console.error("usage: transcribe.cjs <project-dir> [model] [language]"); process.exit(1); }
  // Default = multilingual `small`, NOT `small.en`. Per hyperframes-media: ".en models
  // mistranslate non-English and mis-handle accented speech; default to small (auto-detects
  // language)." We hardcoded small.en before — it hallucinated a wrong transcript on an
  // accented speaker. Pass `small.en` only for known-clean-English; tough accents → a larger model.
  const model = process.argv[3] || process.env.WHISPER_MODEL || "small";
  const language = process.argv[4] || process.env.WHISPER_LANG || "";
  const out = path.join(project, "transcript.json");

  // already in our schema? skip.
  if (fs.existsSync(out)) {
    try {
      const d = JSON.parse(fs.readFileSync(out, "utf8"));
      if (d && d.words && d.language_code) { console.log("[transcribe] already normalized, skipping"); return; }
    } catch (e) {}
  }

  const src = ensureSource(project);
  if (!fs.existsSync(src)) { console.error(`[transcribe] no source in ${project}`); process.exit(2); }
  const audio = path.join(project, "audio.mp3");
  if (!fs.existsSync(audio))
    cp.execFileSync("ffmpeg", ["-y", "-i", src, "-vn", "-acodec", "libmp3lame", "-q:a", "2", audio], { stdio: "ignore" });

  // run hyperframes Whisper → writes a flat word array to <dir>/transcript.json
  const cli = path.join(hfRoot(), "packages", "cli", "dist", "cli.js");
  const args = ["transcribe", audio, "-d", project, "--json", "--model", model];
  if (language) args.push("--language", language);
  let info = {};
  try {
    const so = cp.execFileSync("node", [cli, ...args], { encoding: "utf8" });
    const line = so.trim().split("\n").filter(Boolean).pop();
    info = JSON.parse(line);
  } catch (e) {
    console.error("[transcribe] hyperframes whisper failed:", e.message); process.exit(1);
  }
  const flatPath = info.transcriptPath || out;
  const flat = JSON.parse(fs.readFileSync(flatPath, "utf8"));
  const arr = Array.isArray(flat) ? flat : flat.words || [];

  // normalize to our schema
  const words = arr
    .filter((w) => (w.text ?? w.word) != null)
    .map((w) => ({ text: w.text ?? w.word, start: w.start ?? w.t0, end: w.end ?? w.t1, type: "word" }));
  const text = words.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1").trim();
  fs.writeFileSync(out, JSON.stringify({ text, language_code: language || "en", words }, null, 2));
  console.log(`[transcribe] whisper(${model}) ${words.length} words → ${out}`);
  console.log(`[transcribe] text: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);

  // No-speech guard: whisper returns confident hallucinations over silence (e.g. the
  // whole clip as "Thank you."). The decision gate REFUSES "no speech" — operationalize
  // it so an agent trusting the transcript can't sail past the gate.
  const meanDb = meanVolumeDb(audio);
  if (meanDb != null && meanDb < -45) {
    console.error(`\n[transcribe] ⚠ NEAR-SILENT AUDIO — mean ${meanDb.toFixed(1)} dB (real speech ≈ -16..-26 dB).`);
    console.error(`  This transcript is almost certainly a Whisper hallucination, NOT real speech.`);
    console.error(`  Per the decision gate, REFUSE "no speech" — confirm with \`ffmpeg -i <src> -af silencedetect\`;`);
    console.error(`  do NOT author captions from fabricated words.`);
  }
}
main();
