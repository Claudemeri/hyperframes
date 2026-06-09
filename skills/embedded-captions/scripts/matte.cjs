#!/usr/bin/env node
/*
 * matte.cjs — RVM foreground matting in Node (1:1 port of matte-rvm.py).
 *
 * SAME model + logic as the Python version (RobustVideoMatting mobilenetv3, CPU,
 * recurrent state, /255 normalize, 512-shorter-edge downsample). Runs on the
 * onnxruntime-node + sharp that ship with hyperframes — NO Python.
 *
 *   node matte.cjs <project-dir>
 * Reads:  <project>/source.mp4  OR  <project>/frames_bg/f_%04d.png
 * Writes: <project>/frames_fg/f_%04d.png (RGBA, subject opaque), <project>/matte.fps
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const cp = require("child_process");

// resolve a package from the hyperframes checkout (bun store or plain node_modules)
function hfResolve(pkg) {
  const roots = [
    process.env.HYPERFRAMES_ROOT,
    path.resolve(__dirname, "..", "..", ".."), // skills/embedded-captions/scripts → repo root if in-repo
    path.join(os.homedir(), "Downloads", "hyperframes"),
  ].filter(Boolean);
  for (const root of roots) {
    const cands = [path.join(root, "node_modules", pkg)];
    const bun = path.join(root, "node_modules", ".bun");
    try {
      if (fs.existsSync(bun))
        for (const d of fs.readdirSync(bun))
          if (d.startsWith(pkg + "@")) cands.push(path.join(bun, d, "node_modules", pkg));
    } catch (e) { /* ignore */ }
    for (const c of cands) { try { if (fs.existsSync(c)) return require(c); } catch (e) {} }
  }
  console.error(`[matte] cannot find ${pkg} — set HYPERFRAMES_ROOT to a built hyperframes checkout`);
  process.exit(3);
}
const ort = hfResolve("onnxruntime-node");
const sharp = hfResolve("sharp");

const MODEL = path.resolve(__dirname, "..", "assets", "rvm_mobilenetv3_fp32.onnx");
const MODEL_URL = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx";

function ensureModel() {
  if (fs.existsSync(MODEL)) return;
  fs.mkdirSync(path.dirname(MODEL), { recursive: true });
  console.log(`[matte] downloading RVM weights (~14MB) to ${MODEL}`);
  cp.execFileSync("curl", ["-fL", "-o", MODEL, MODEL_URL], { stdio: "inherit" });
}

function ensureSource(project) {
  const src = path.join(project, "source.mp4");
  if (fs.existsSync(src)) return src;
  const EXCL = new Set(["final", "bg_plus_caps", "fg_caps", "audio"]);
  let cands = [];
  for (const f of fs.readdirSync(project)) {
    const ext = path.extname(f).slice(1).toLowerCase();
    if (["mp4", "mov", "webm", "mkv", "m4v"].includes(ext)
        && !EXCL.has(path.basename(f, path.extname(f))) && !f.startsWith("index"))
      cands.push(path.join(project, f));
  }
  let found = cands.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  if (!found) {
    const hj = path.join(project, "hyperframes.json");
    if (fs.existsSync(hj)) {
      try { const v = (JSON.parse(fs.readFileSync(hj, "utf8")).video) || ""; if (v && fs.existsSync(path.join(project, v))) found = path.join(project, v); } catch (e) {}
    }
  }
  if (found) {
    try { fs.symlinkSync(path.basename(found), src); } catch (e) { fs.copyFileSync(found, src); }
    console.log(`[matte] resolved source.mp4 -> ${path.basename(found)}`);
  }
  return src;
}

function probeFps(src) {
  try {
    const out = cp.execFileSync("ffprobe", ["-v", "0", "-select_streams", "v:0", "-show_entries",
      "stream=r_frame_rate", "-of", "default=nk=1:nw=1", src]).toString().trim();
    const [n, d] = out.split("/");
    const f = parseFloat(n) / parseFloat(d || "1");
    return f > 0 ? Math.max(1, Math.round(f)) : 24;
  } catch (e) { return 24; }
}

function extractFrames(src, dst, fps) {
  fs.mkdirSync(dst, { recursive: true });
  if (fs.readdirSync(dst).some((f) => f.endsWith(".png"))) return;
  cp.execFileSync("ffmpeg", ["-y", "-i", src, "-vf", `fps=${fps}`, path.join(dst, "f_%04d.png")], { stdio: "ignore" });
}

function downsampleForHeight(h) { return Math.round(Math.min(1.0, 512.0 / Math.max(h, 1)) * 1000) / 1000; }

async function main() {
  const project = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) { console.error("usage: matte.cjs <project-dir>"); process.exit(1); }
  const src = ensureSource(project);
  const framesBg = path.join(project, "frames_bg");
  const framesFg = path.join(project, "frames_fg");

  if (!fs.existsSync(src) && !fs.existsSync(framesBg)) {
    console.error(`[matte] no source video found in ${project}`); process.exit(2);
  }
  ensureModel();

  if (fs.existsSync(src) && !fs.existsSync(framesBg)) {
    const fps = probeFps(src);
    fs.writeFileSync(path.join(project, "matte.fps"), String(fps));
    console.log(`[matte] source fps=${fps} (native) → extracting frames_bg`);
    extractFrames(src, framesBg, fps);
  } else if (!fs.existsSync(path.join(project, "matte.fps"))) {
    fs.writeFileSync(path.join(project, "matte.fps"), String(fs.existsSync(src) ? probeFps(src) : 24));
  }

  const files = fs.readdirSync(framesBg).filter((f) => f.endsWith(".png")).sort()
    .map((f) => path.join(framesBg, f));
  if (!files.length) { console.error(`[matte] no input frames in ${framesBg}`); process.exit(2); }
  fs.mkdirSync(framesFg, { recursive: true });

  const meta = await sharp(files[0]).metadata();
  const W = meta.width, H = meta.height, N = W * H;
  const ds = downsampleForHeight(H);
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
  let rec = [0, 1, 2, 3].map(() => new ort.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]));
  const dsT = new ort.Tensor("float32", Float32Array.from([ds]), [1]);

  console.log(`[matte] ${files.length} frames, ${W}x${H}, downsample=${ds}`);
  const t0 = Date.now();
  for (let i = 0; i < files.length; i++) {
    const { data } = await sharp(files[i]).removeAlpha().raw().toBuffer({ resolveWithObject: true }); // RGB HWC uint8
    const srcArr = new Float32Array(3 * N);
    for (let p = 0; p < N; p++) { srcArr[p] = data[p * 3] / 255; srcArr[N + p] = data[p * 3 + 1] / 255; srcArr[2 * N + p] = data[p * 3 + 2] / 255; }
    const out = await session.run({
      src: new ort.Tensor("float32", srcArr, [1, 3, H, W]),
      r1i: rec[0], r2i: rec[1], r3i: rec[2], r4i: rec[3], downsample_ratio: dsT,
    });
    const pha = out.pha.data;
    rec = [out.r1o, out.r2o, out.r3o, out.r4o];
    const rgba = Buffer.allocUnsafe(N * 4);
    for (let p = 0; p < N; p++) {
      rgba[p * 4] = data[p * 3]; rgba[p * 4 + 1] = data[p * 3 + 1]; rgba[p * 4 + 2] = data[p * 3 + 2];
      rgba[p * 4 + 3] = Math.max(0, Math.min(255, Math.round(pha[p] * 255)));
    }
    await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path.join(framesFg, path.basename(files[i])));
    if (i % 30 === 0 || i === files.length - 1)
      console.log(`  ${i + 1}/${files.length} — ${((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1)} fps`);
  }
  console.log(`[matte] done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${framesFg}`);
}
main().catch((e) => { console.error("[matte]", e.message); process.exit(1); });
