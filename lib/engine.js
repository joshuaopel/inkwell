// The drawing engine Inkwell installs for you.
//
// The point of this file is that a writer should not have to install Python, a
// virtual environment, CUDA, or a node-graph program in order to get a picture
// onto a page. Inkwell downloads one small binary and one model file, keeps
// them in a folder next to your books, and runs the binary itself.
//
// The binary is stable-diffusion.cpp — the same idea as llama.cpp, but for
// pictures: one native executable, no runtime, a single model file. It ships a
// `sd-server` that speaks the AUTOMATIC1111 HTTP API, which means once it's
// running, Inkwell talks to it with exactly the same client it uses for a
// hand-installed AUTOMATIC1111. Nothing downstream knows the difference.
//
// Everything here is on-demand and reversible: nothing is downloaded until you
// press the button, and Remove deletes the folder.

import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sits beside books/ so a backup of your Inkwell folder is everything, and so
// it's obvious what to delete when you want the disk space back.
export const ENGINE_DIR = process.env.INKWELL_ENGINE || path.join(__dirname, '..', 'engine');
const BIN_DIR = path.join(ENGINE_DIR, 'bin');
const MODEL_DIR = path.join(ENGINE_DIR, 'models');
const STATE_FILE = path.join(ENGINE_DIR, 'state.json');

const REPO = 'leejet/stable-diffusion.cpp';

// If GitHub can't be asked which release is current — offline, rate-limited,
// API changed — fall back to one that is known to exist and known to work.
// Verified against this exact tag.
const PINNED_TAG = 'master-813-bfbef5b';

// ---------------------------------------------------------------- platform ---
// Vulkan is the default on Windows and Linux on purpose. The CUDA build is
// 345 MB and needs a 537 MB CUDA runtime beside it; the Vulkan build is 36 MB,
// runs on NVIDIA, AMD and Intel alike, and gets most of the same speed. For a
// thing that is supposed to install itself while you make a cup of tea, that
// trade is not close.
const TARGETS = {
  'win32-x64': [
    { accel: 'vulkan', label: 'GPU (Vulkan)', re: /bin-win-vulkan-x64\.zip$/ },
    { accel: 'cpu', label: 'CPU only', re: /bin-win-cpu-x64\.zip$/ },
  ],
  'linux-x64': [
    { accel: 'vulkan', label: 'GPU (Vulkan)', re: /bin-Linux-.*x86_64-vulkan\.zip$/ },
    { accel: 'cpu', label: 'CPU only', re: /bin-Linux-.*x86_64\.zip$/ },
  ],
  'darwin-arm64': [
    { accel: 'metal', label: 'GPU (Metal)', re: /bin-Darwin-.*arm64\.zip$/ },
  ],
};

export function platformKey() {
  return `${os.platform()}-${os.arch()}`;
}

export function platformSupported() {
  return !!TARGETS[platformKey()];
}

// ------------------------------------------------------------------ models ---
// Three tiers, all single-purpose and all downloadable without an account.
// Licences are stated because someone is going to sell the book they make.
export const TIERS = [
  {
    id: 'sketch',
    label: 'Sketch',
    hint: 'Stable Diffusion 1.5. Small and quick — good for roughing out a spread, and the only realistic choice on a laptop without a graphics card.',
    bytes: 2_132_696_762,
    licence: 'CreativeML OpenRAIL-M',
    steps: 20,
    cfg: 7,
    sampler: 'euler_a',
    size: 512,
    files: [{
      name: 'sd15.safetensors',
      url: 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors',
      bytes: 2_132_696_762,
      arg: '-m',
    }],
  },
  {
    id: 'storybook',
    label: 'Storybook',
    hint: 'Stable Diffusion XL. The sensible default: much better at illustration than 1.5, still one file, still fits on a mid-range graphics card.',
    bytes: 6_938_040_682,
    licence: 'CreativeML Open RAIL++-M',
    steps: 26,
    cfg: 6,
    sampler: 'dpm++2m',
    size: 1024,
    files: [{
      name: 'sdxl.safetensors',
      url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      bytes: 6_938_040_682,
      arg: '-m',
    }],
  },
  {
    id: 'finest',
    label: 'Finest',
    hint: 'FLUX.1-schnell, quantised. The best pictures and the only one under a plain Apache licence — but four files and a big download, and it wants a lot of memory.',
    bytes: 10_270_000_000,
    licence: 'Apache 2.0',
    // Schnell is distilled to four steps and wants no classifier-free guidance.
    steps: 4,
    cfg: 1,
    sampler: 'euler',
    size: 1024,
    files: [
      {
        name: 'flux1-schnell-Q4_K_S.gguf',
        url: 'https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q4_K_S.gguf',
        bytes: 6_781_000_000,
        arg: '--diffusion-model',
      },
      {
        name: 't5xxl-Q4_K_M.gguf',
        url: 'https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf',
        bytes: 2_900_000_000,
        arg: '--t5xxl',
      },
      {
        name: 'clip_l.safetensors',
        url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
        bytes: 246_144_152,
        arg: '--clip_l',
      },
      {
        name: 'flux-ae.safetensors',
        url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors',
        bytes: 335_304_388,
        arg: '--vae',
      },
    ],
  },
];

export const tierById = (id) => TIERS.find((t) => t.id === id) || TIERS[1];

// ------------------------------------------------------------------- state ---
const readState = async () => {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch { return {}; }
};
const writeState = async (patch) => {
  const next = { ...(await readState()), ...patch };
  await fs.mkdir(ENGINE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
};

const exeName = () => (os.platform() === 'win32' ? 'sd-server.exe' : 'sd-server');
const serverPath = () => path.join(BIN_DIR, exeName());
const cliPath = () => path.join(BIN_DIR, os.platform() === 'win32' ? 'sd-cli.exe' : 'sd-cli');

// Which build was downloaded and what the machine actually has are different
// questions. The Vulkan build runs perfectly well on a machine with no Vulkan
// device — it quietly falls back to the processor, and then a picture takes ten
// minutes instead of ten seconds. Ask the engine itself rather than claiming
// "GPU" because that's the file we fetched.
async function probeDevices() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(cliPath(), ['--list-devices'], {
      cwd: BIN_DIR,
      env: { ...process.env, LD_LIBRARY_PATH: BIN_DIR, DYLD_LIBRARY_PATH: BIN_DIR },
    });
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      // Lines are "name<TAB>description"; the loader chatters on the same
      // streams, so keep only the ones that look like a device.
      const devices = out.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('\t') && !l.startsWith('load_backend'))
        .map((l) => {
          const [name, ...rest] = l.split('\t');
          return { name: name.trim(), description: rest.join(' ').trim() };
        });
      resolve(devices.length ? devices : null);
    });
    setTimeout(() => { try { p.kill(); } catch {} }, 20000);
  });
}

// A device whose name isn't CPU is one that will make this fast.
const isGpu = (d) => !/^cpu$/i.test(d.name);

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function fileSize(p) {
  try { return (await fs.stat(p)).size; } catch { return 0; }
}

// Everything the UI needs to decide what to show, in one call.
export async function status() {
  const st = await readState();
  const binary = await exists(serverPath());
  const tier = st.tier ? tierById(st.tier) : null;

  let modelBytes = 0;
  let modelsReady = false;
  if (tier) {
    const sizes = await Promise.all(tier.files.map((f) => fileSize(path.join(MODEL_DIR, f.name))));
    modelBytes = sizes.reduce((a, b) => a + b, 0);
    // A download interrupted halfway leaves a short file; only call it ready if
    // every file is at least almost the size it should be.
    modelsReady = tier.files.every((f, i) => sizes[i] > f.bytes * 0.97);
  }

  // What the machine actually offered, not what the download was called.
  const devices = st.devices || [];
  const gpu = devices.find(isGpu);
  const deviceLabel = gpu ? (gpu.description || gpu.name)
    : devices.length ? (devices[0].description || devices[0].name)
    : null;

  return {
    supported: platformSupported(),
    platform: platformKey(),
    dir: ENGINE_DIR,
    binary,
    accel: st.accel || null,
    accelLabel: st.accelLabel || null,
    devices,
    deviceLabel,
    usingGpu: !!gpu,
    release: st.tag || null,
    tier: tier?.id || null,
    tierLabel: tier?.label || null,
    modelsReady,
    ready: binary && modelsReady,
    bytes: modelBytes + (st.binBytes || 0),
    // Ask the port rather than trusting a variable: if Inkwell was killed
    // outright last time, its engine survives and is still answering, and
    // reporting "not running" would be a lie the user pays for in a wasted
    // model load.
    running: binary && modelsReady ? await alive(600) : false,
    port: PORT,
    tiers: TIERS.map(({ id, label, hint, bytes, licence }) => ({ id, label, hint, bytes, licence })),
  };
}

// ---------------------------------------------------------------- download ---
// Resumable, because a 7 GB download that has to start again from zero because
// a laptop lid closed is not a feature.
async function download(url, dest, { onProgress, signal, expected = 0 } = {}) {
  const part = dest + '.part';
  let have = await fileSize(part);

  // A finished file that's the right size needs no work.
  const done = await fileSize(dest);
  if (done && (!expected || done > expected * 0.97)) return done;

  const headers = {};
  if (have > 0) headers.Range = `bytes=${have}-`;

  const res = await fetch(url, { headers, redirect: 'follow', signal });
  if (res.status === 416) {
    // Already had the whole thing; the server says there's nothing beyond it.
    await fs.rename(part, dest);
    return have;
  }
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${url.split('/').pop()}`);
  if (have > 0 && res.status !== 206) have = 0; // server ignored the range — start over

  const total = have + Number(res.headers.get('content-length') || 0);
  let got = have;
  let lastTick = 0;

  const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
  const meter = new TransformStreamCounter((n) => {
    got += n;
    // Report about five times a second; the client is reading this over HTTP.
    const now = Date.now();
    if (now - lastTick > 200) { lastTick = now; onProgress?.({ got, total: total || expected }); }
  });

  await pipeline(res.body, meter, out);
  onProgress?.({ got, total: total || expected });
  await fs.rename(part, dest);
  return got;
}

// A tiny counting pass-through; a Transform in a few lines rather than a
// dependency.
import { Transform } from 'node:stream';
class TransformStreamCounter extends Transform {
  constructor(onChunk) { super(); this.onChunk = onChunk; }
  _transform(chunk, _enc, cb) { this.onChunk(chunk.length); cb(null, chunk); }
}

// ---------------------------------------------------------------- releases ---
async function resolveRelease(signal, preferAccel) {
  let targets = TARGETS[platformKey()];
  if (!targets) throw new Error(`Inkwell has no drawing engine build for ${platformKey()} yet.`);
  // An explicit choice moves to the front; the rest stay as fallbacks, so
  // asking for a GPU build on a machine without one still ends up working.
  if (preferAccel) {
    targets = [...targets].sort((a, b) => (b.accel === preferAccel) - (a.accel === preferAccel));
  }

  // Ask GitHub what's current; fall back to the pinned tag if it won't answer.
  let assets = null;
  let tag = PINNED_TAG;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }, signal,
    });
    if (r.ok) {
      const d = await r.json();
      if (d.tag_name && Array.isArray(d.assets) && d.assets.length) {
        tag = d.tag_name;
        assets = d.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
      }
    }
  } catch { /* offline or rate-limited — the pinned release still works */ }

  if (!assets) {
    // Without the asset list, reconstruct the download URL from the pinned tag.
    // Its names are known because the tag is pinned.
    const stamp = PINNED_TAG.replace(/^master-\d+-/, '');
    const guesses = {
      'win32-x64': [
        { accel: 'vulkan', label: 'GPU (Vulkan)', name: `sd-master-${stamp}-bin-win-vulkan-x64.zip` },
        { accel: 'cpu', label: 'CPU only', name: `sd-master-${stamp}-bin-win-cpu-x64.zip` },
      ],
      'linux-x64': [
        { accel: 'vulkan', label: 'GPU (Vulkan)', name: `sd-master-${stamp}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip` },
        { accel: 'cpu', label: 'CPU only', name: `sd-master-${stamp}-bin-Linux-Ubuntu-24.04-x86_64.zip` },
      ],
      'darwin-arm64': [
        { accel: 'metal', label: 'GPU (Metal)', name: `sd-master-${stamp}-bin-Darwin-macOS-26.5.2-arm64.zip` },
      ],
    }[platformKey()];
    assets = guesses.map((g) => ({
      name: g.name, size: 0,
      url: `https://github.com/${REPO}/releases/download/${PINNED_TAG}/${g.name}`,
    }));
  }

  for (const t of targets) {
    const hit = assets.find((a) => t.re.test(a.name));
    if (hit) return { tag, accel: t.accel, accelLabel: t.label, asset: hit };
  }
  throw new Error(`No drawing engine build in release ${tag} matches ${platformKey()}.`);
}

// ------------------------------------------------------------------ install ---
// Reports progress as it goes; the caller streams these objects to the browser.
export async function install({ tier = 'storybook', accel, onProgress = () => {}, signal } = {}) {
  const t = tierById(tier);
  await fs.mkdir(BIN_DIR, { recursive: true });
  await fs.mkdir(MODEL_DIR, { recursive: true });

  const step = (stage, extra = {}) => onProgress({ stage, ...extra });

  // ---- the binary
  if (!(await exists(serverPath()))) {
    step('resolving', { note: 'Finding the right build for this machine…' });
    const rel = await resolveRelease(signal, accel);
    const zipPath = path.join(ENGINE_DIR, rel.asset.name);
    step('engine', { note: `Downloading the drawing engine — ${rel.accelLabel}`, got: 0, total: rel.asset.size });
    const gotBytes = await download(rel.asset.url, zipPath, {
      expected: rel.asset.size, signal,
      onProgress: (p) => step('engine', { note: `Downloading the drawing engine — ${rel.accelLabel}`, ...p }),
    });

    step('unpacking', { note: 'Unpacking the engine…' });
    await unzipInto(zipPath, BIN_DIR);
    await fs.rm(zipPath, { force: true });
    await writeState({ tag: rel.tag, accel: rel.accel, accelLabel: rel.accelLabel, binBytes: gotBytes });

    step('probing', { note: 'Asking it what hardware it can see…' });
    await writeState({ devices: await probeDevices() });
  }

  // ---- the model
  for (const [i, f] of t.files.entries()) {
    const dest = path.join(MODEL_DIR, f.name);
    const note = t.files.length > 1
      ? `Downloading the ${t.label} model — file ${i + 1} of ${t.files.length}`
      : `Downloading the ${t.label} model`;
    // Open on however much is already on disk rather than a hardcoded zero, so
    // resuming a 7 GB download doesn't show the bar snapping back to the start.
    const already = (await fileSize(dest)) || (await fileSize(dest + '.part'));
    step('model', { note, got: already, total: f.bytes, file: f.name });
    await download(f.url, dest, {
      expected: f.bytes, signal,
      onProgress: (p) => step('model', { note, ...p, file: f.name }),
    });
  }

  await writeState({ tier: t.id, installedAt: new Date().toISOString() });
  step('done', { note: 'Ready to draw.' });
  return status();
}

// JSZip is already here for the EPUB writer, and it reads zips too — so
// unpacking works identically on Windows, macOS and Linux with no unzip
// command, no tar, and no new dependency.
async function unzipInto(zipPath, dir) {
  const zip = await JSZip.loadAsync(await fs.readFile(zipPath));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    // Flatten: releases sometimes nest everything under a build folder, and the
    // binary needs its shared libraries beside it either way.
    const name = path.basename(entry.name);
    if (!name || name.startsWith('.')) continue;
    const dest = path.join(dir, name);
    await fs.writeFile(dest, await entry.async('nodebuffer'));
    // The executable bit does not survive a zip round trip on POSIX.
    if (os.platform() !== 'win32' && /^sd(-cli|-server)?$/.test(name)) {
      await fs.chmod(dest, 0o755);
    }
  }
}

export async function remove() {
  await stop();
  await fs.rm(ENGINE_DIR, { recursive: true, force: true });
  return status();
}

// -------------------------------------------------------------------- run ---
// One child process, started on first use and left running so the model stays
// in memory between pictures — loading several gigabytes per image would make
// the whole feature unusable.
const PORT = Number(process.env.INKWELL_ENGINE_PORT || 7801);
let child = null;
let starting = null;
let stopping = false;
let lastLog = [];

const BASE = `http://127.0.0.1:${PORT}`;
export const engineBaseUrl = () => BASE;

async function alive(ms = 2000) {
  try {
    const r = await fetch(`${BASE}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

export async function start({ onProgress } = {}) {
  // Check what's installed BEFORE checking the port. The other way round, a
  // stranger's server on the same port would be adopted and drawn with — and
  // "it isn't installed" is the honest answer even if something is answering.
  const ready = await status();
  if (!ready.ready) throw new Error('The drawing engine isn\'t installed yet.');
  if (await alive()) return { ok: true, base: BASE };
  if (starting) return starting;

  starting = (async () => {
    const st = ready;
    const t = tierById(st.tier);

    const args = ['-l', '127.0.0.1', '--listen-port', String(PORT)];
    for (const f of t.files) args.push(f.arg, path.join(MODEL_DIR, f.name));
    // Keeping the weights in RAM and paging them to the GPU is what lets a
    // 6 GB model run on a 6 GB card at all.
    if (st.accel !== 'cpu') args.push('--offload-to-cpu');
    args.push('--diffusion-fa');

    onProgress?.({ stage: 'loading', note: `Loading the ${t.label} model…` });
    lastLog = [];
    child = spawn(serverPath(), args, {
      cwd: BIN_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The shared libraries sit beside the binary rather than on the system path.
      env: { ...process.env, LD_LIBRARY_PATH: BIN_DIR, DYLD_LIBRARY_PATH: BIN_DIR },
    });
    const keep = (b) => {
      lastLog.push(String(b));
      if (lastLog.length > 40) lastLog.shift();
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code) => {
      if (!stopping && code) console.error('[engine] sd-server exited', code, lastLog.slice(-6).join(''));
      child = null;
    });

    // Loading several gigabytes off a spinning disk is slow; wait generously,
    // but give up rather than hang forever.
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (!child) throw new Error(`The drawing engine stopped while starting.\n${lastLog.slice(-4).join('')}`.trim());
      if (await alive(1500)) {
        onProgress?.({ stage: 'ready', note: 'Loaded.' });
        return { ok: true, base: BASE };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await stop();
    throw new Error('The drawing engine did not finish loading within ten minutes.');
  })().finally(() => { starting = null; });

  return starting;
}

export async function stop() {
  if (!child) return;
  stopping = true;
  const c = child;
  c.kill();
  await new Promise((r) => {
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} r(); }, 4000);
    c.once('exit', () => { clearTimeout(t); r(); });
  });
  child = null;
  stopping = false;
}

export const engineLog = () => lastLog.join('');

// A child process that outlives its parent is somebody's mystery GPU usage
// three days later.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child?.kill(); } catch {} if (sig !== 'exit') process.exit(0); });
}
