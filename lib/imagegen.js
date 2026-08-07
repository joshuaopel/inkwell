// Image provider layer — the same shape as lib/ollama.js, for pictures.
//
// The default is the engine Inkwell installs itself (see lib/engine.js): press
// one button and it downloads a small native binary and a model, and runs them
// for you. That engine speaks the AUTOMATIC1111 API, so it shares this file's
// simplest client and adds only process management on top.
//
// The other three are for people who already run something: ComfyUI,
// a hand-installed AUTOMATIC1111, or Ollama — whose own image generation was
// macOS-only as of early 2026, so that entry sits ready rather than being
// written later in a panic.
//
// Every backend implements:
//   health()   -> { ok, reason? }
//   models()   -> [names]           (best effort; may be empty)
//   generate({ prompt, negative, width, height, steps, seed, model })
//                 -> { buffer, mime, seed }
//
// Whatever the backend, the result comes back as PNG bytes that get saved into
// the book's own assets folder — so an illustrated book stays a folder you own.

import http from 'node:http';

import * as engine from './engine.js';

const DEFAULTS = {
  comfyui: 'http://127.0.0.1:8188',
  automatic1111: 'http://127.0.0.1:7860',
  ollama: 'http://127.0.0.1:11434',
};

export const IMAGE_BACKENDS = [
  {
    id: 'bundled', label: 'Built in — Inkwell installs it',
    defaultBaseUrl: '',
    builtIn: true,
    hint: 'One button. Inkwell downloads a small drawing engine and a model, keeps them beside your books, and runs them itself. No Python, no separate program, nothing to configure.',
  },
  {
    id: 'comfyui', label: 'ComfyUI',
    defaultBaseUrl: DEFAULTS.comfyui,
    hint: 'The usual choice on Windows with an NVIDIA card. Start it with --listen if it is on another machine.',
  },
  {
    id: 'automatic1111', label: 'AUTOMATIC1111 / SD.Next',
    defaultBaseUrl: DEFAULTS.automatic1111,
    hint: 'Launch it with --api so the endpoint exists.',
  },
  {
    id: 'ollama', label: 'Ollama (macOS only, for now)',
    defaultBaseUrl: DEFAULTS.ollama,
    hint: 'Image generation is macOS-only at present. Windows and Linux are coming.',
  },
];

// Reuse the same host-normalising lesson learned for the text provider: accept
// a bare host, a host:port or a URL, and never try to dial 0.0.0.0.
function resolveHost(raw, fallback) {
  let h = String(raw ?? '').trim();
  if (!h) return fallback;
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  let u;
  try { u = new URL(h); } catch { return fallback; }
  if (u.hostname === '0.0.0.0' || u.hostname === '::' || u.hostname === '[::]') u.hostname = '127.0.0.1';
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  return u.origin;
}

const b64 = (s) => Buffer.from(String(s).replace(/^data:image\/\w+;base64,/, ''), 'base64');

// Drawing a picture answers nothing at all until it's finished, and Node's
// fetch gives up waiting for the first response header after five minutes. On a
// machine without a graphics card one picture can take longer than that, so the
// generate call goes through node:http where the timeout is ours to set.
function postJson(url, body, timeoutMs = 45 * 60_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`No answer after ${Math.round(timeoutMs / 60000)} minutes.`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function fail(r, who) {
  let detail = (await r.text().catch(() => '')).slice(0, 300);
  try { detail = JSON.parse(detail).error || detail; } catch {}
  throw new Error(`${who} ${r.status}: ${detail}`);
}

// ------------------------------------------------------- AUTOMATIC1111 ----
// The simplest of the three: one POST, base64 PNGs back. Also what Inkwell's
// own bundled engine speaks, so this one client serves both.
function automatic1111(cfg) {
  const base = resolveHost(cfg.baseUrl, DEFAULTS.automatic1111);
  // Samplers are named differently by different servers, and the right
  // guidance scale depends on the model — a distilled model wants none at all.
  const defaults = { sampler: 'DPM++ 2M', cfg: 6, ...(cfg.tuning || {}) };
  return {
    id: cfg.id || 'automatic1111',
    base,
    async health() {
      try {
        const r = await fetch(`${base}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return { ok: false, reason: `Answered with HTTP ${r.status}. Was it started with --api?` };
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: `Nothing answering at ${base}. Start it with --api.` };
      }
    },
    async models() {
      try {
        const r = await fetch(`${base}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return [];
        return (await r.json()).map((m) => m.model_name || m.title).filter(Boolean);
      } catch { return []; }
    },
    async generate({ prompt, negative, width, height, steps, seed }) {
      const who = cfg.id === 'bundled' ? 'The drawing engine' : 'AUTOMATIC1111';
      const r = await postJson(`${base}/sdapi/v1/txt2img`, {
        prompt, negative_prompt: negative || '',
        width, height, steps: steps || 28, seed: seed ?? -1,
        cfg_scale: defaults.cfg, sampler_name: defaults.sampler,
      });
      if (r.status !== 200) {
        let detail = r.text.slice(0, 300);
        try { detail = JSON.parse(detail).error || detail; } catch {}
        throw new Error(`${who} answered ${r.status}: ${detail}`);
      }
      const data = JSON.parse(r.text);
      const img = data.images?.[0];
      if (!img) throw new Error(`${who} returned no image.`);
      let usedSeed = seed;
      try { usedSeed = JSON.parse(data.info || '{}').seed ?? seed; } catch {}
      return { buffer: b64(img), mime: 'image/png', seed: usedSeed };
    },
  };
}

// -------------------------------------------------------------- ComfyUI ----
// ComfyUI runs a node graph, so there's no "just generate" endpoint: you post a
// workflow and poll history for the result. This is a minimal SDXL-shaped
// text-to-image graph — enough to be useful, and replaceable by anyone who
// wants their own by pasting an API-format workflow into Settings.
function comfyWorkflow({ model, prompt, negative, width, height, steps, seed }) {
  return {
    3: {
      class_type: 'KSampler',
      inputs: {
        seed, steps, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
      },
    },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative || '', clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'inkwell', images: ['8', 0] } },
  };
}

function comfyui(cfg) {
  const base = resolveHost(cfg.baseUrl, DEFAULTS.comfyui);
  return {
    id: 'comfyui',
    base,
    async health() {
      try {
        const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return { ok: false, reason: `Answered with HTTP ${r.status}.` };
        return { ok: true };
      } catch {
        return { ok: false, reason: `Nothing answering at ${base}. Is ComfyUI running?` };
      }
    },
    async models() {
      try {
        const r = await fetch(`${base}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return [];
        const info = await r.json();
        const list = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
        return Array.isArray(list) ? list : [];
      } catch { return []; }
    },
    async generate({ prompt, negative, width, height, steps, seed, model, workflow, timeoutMs = 240000 }) {
      steps = steps || 28;
      const usedSeed = seed == null || seed < 0 ? Math.floor(Math.random() * 2 ** 31) : seed;
      let graph;
      if (workflow) {
        // A custom workflow gets the same values substituted into it wherever
        // the author left our placeholders.
        graph = JSON.parse(
          JSON.stringify(workflow)
            .replaceAll('{{prompt}}', JSON.stringify(prompt).slice(1, -1))
            .replaceAll('{{negative}}', JSON.stringify(negative || '').slice(1, -1))
            .replaceAll('"{{seed}}"', String(usedSeed))
            .replaceAll('"{{steps}}"', String(steps))
            .replaceAll('"{{width}}"', String(width))
            .replaceAll('"{{height}}"', String(height))
        );
      } else {
        if (!model) throw new Error('Pick a checkpoint in Settings first — ComfyUI needs to know which model to load.');
        graph = comfyWorkflow({ model, prompt, negative, width, height, steps, seed: usedSeed });
      }

      const post = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph }),
      });
      if (!post.ok) await fail(post, 'ComfyUI /prompt');
      const { prompt_id: id } = await post.json();
      if (!id) throw new Error('ComfyUI accepted the job but returned no id.');

      // Poll history. Generation is slow enough that polling is fine and much
      // simpler than holding a websocket open.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200));
        const h = await fetch(`${base}/history/${id}`).catch(() => null);
        if (!h?.ok) continue;
        const hist = await h.json().catch(() => ({}));
        const entry = hist[id];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') {
          throw new Error('ComfyUI reported an error running the workflow. Check its console.');
        }
        for (const out of Object.values(entry.outputs || {})) {
          const img = out.images?.[0];
          if (!img) continue;
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
          const file = await fetch(`${base}/view?${q}`);
          if (!file.ok) await fail(file, 'ComfyUI /view');
          return { buffer: Buffer.from(await file.arrayBuffer()), mime: 'image/png', seed: usedSeed };
        }
      }
      throw new Error(`ComfyUI didn't finish within ${Math.round(timeoutMs / 1000)}s.`);
    },
  };
}

// --------------------------------------------------------------- Ollama ----
// Present for the day image generation reaches Windows and Linux. On macOS it
// works now.
function ollamaImages(cfg) {
  const base = resolveHost(cfg.baseUrl, DEFAULTS.ollama);
  return {
    id: 'ollama',
    base,
    async health() {
      try {
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return { ok: false, reason: `Ollama answered with HTTP ${r.status}.` };
        return { ok: true };
      } catch {
        return { ok: false, reason: `Nothing answering at ${base}.` };
      }
    },
    async models() {
      try {
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return [];
        // Only the diffusion models are of interest here, and Ollama doesn't
        // flag them, so match on the names it currently ships.
        return (await r.json()).models
          .map((m) => m.name)
          .filter((n) => /z-image|flux|stable-diffusion|sdxl/i.test(n));
      } catch { return []; }
    },
    async generate({ prompt, negative, width, height, seed, model }) {
      if (!model) throw new Error('Pick an image model in Settings first.');
      const r = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, prompt, stream: false,
          options: { width, height, seed: seed ?? -1, negative_prompt: negative || '' },
        }),
      });
      if (!r.ok) await fail(r, 'Ollama /api/generate');
      const data = await r.json();
      const img = data.images?.[0] || data.image;
      if (!img) {
        throw new Error('Ollama returned no image. Image generation is macOS-only at the moment — on Windows use ComfyUI instead.');
      }
      return { buffer: b64(img), mime: 'image/png', seed };
    },
  };
}

// Scale a requested size to a model's native resolution, keeping the aspect
// ratio and staying on the 64-pixel grid diffusion models need.
function fitTo(w, h, native) {
  const grid = (n) => Math.max(256, Math.round(n / 64) * 64);
  const scale = native / Math.sqrt(w * h);
  return { width: grid(w * scale), height: grid(h * scale) };
}

// ------------------------------------------------------------- built in ----
// Inkwell's own engine. It speaks the AUTOMATIC1111 API, so the only thing
// this adds over that client is making sure the process is actually running
// and handing it the settings the installed model wants.
function bundled() {
  const base = engine.engineBaseUrl();
  const inner = automatic1111({ baseUrl: base, id: 'bundled' });

  return {
    id: 'bundled',
    base,
    async health() {
      const st = await engine.status();
      if (!st.supported) return { ok: false, reason: `There's no built-in engine for ${st.platform} yet — use ComfyUI instead.` };
      if (!st.binary) return { ok: false, reason: 'Not set up yet. Press "Set it up for me".', needsInstall: true };
      if (!st.modelsReady) return { ok: false, reason: 'The model download didn\'t finish. Press "Set it up for me" to resume.', needsInstall: true };
      if (st.running) return { ok: true, reason: '' };
      return { ok: true, reason: 'Installed. It loads the model the first time you draw.', idle: true };
    },
    async models() {
      const st = await engine.status();
      return st.tier ? [st.tierLabel] : [];
    },
    async generate(opts) {
      // First draw of a session pays for the model load; every one after is fast.
      await engine.start();
      const say = (e) => {
        // When the engine dies mid-picture the socket error says nothing useful,
        // so hand back what the engine itself printed before it went.
        const log = engine.engineLog().slice(-1200).trim();
        const dead = /ECONNRESET|socket hang up|ECONNREFUSED|EPIPE/i.test(e.message);
        const head = dead
          ? 'The drawing engine stopped part-way through the picture. That is usually memory — try a smaller picture shape, or the Sketch model.'
          : e.message;
        throw new Error(log ? `${head}\n\n--- the engine's own words ---\n${log}` : head);
      };
      const t = engine.tierById((await engine.status()).tier);
      const tuned = automatic1111({
        baseUrl: base, id: 'bundled',
        tuning: { sampler: t.sampler, cfg: t.cfg },
      });
      // Each model has a resolution it was trained at, and asking a 512-pixel
      // model for a 1024-pixel picture gets you two heads. Keep the aspect the
      // author chose, but scale it to what this model can actually draw.
      const { width, height } = fitTo(opts.width, opts.height, t.size);
      const out = await tuned.generate({ ...opts, width, height, steps: opts.steps || t.steps }).catch(say);
      return { ...out, width, height };
    },
  };
}

const BUILDERS = { bundled, comfyui, automatic1111, ollama: ollamaImages };

export function imagesConfigured(settings) {
  const i = settings?.image;
  return !!(i && i.enabled && BUILDERS[i.backend]);
}

export function imageProvider(settings) {
  if (!imagesConfigured(settings)) return null;
  return BUILDERS[settings.image.backend]({ baseUrl: settings.image.baseUrl });
}

// Picture-book pages are square more often than not; keep sizes on the 64px
// grid diffusion models expect.
export const IMAGE_SIZES = [
  { id: 'square', label: 'Square · 1024×1024', w: 1024, h: 1024 },
  { id: 'spread', label: 'Spread · 1216×832', w: 1216, h: 832 },
  { id: 'portrait', label: 'Portrait · 832×1216', w: 832, h: 1216 },
  { id: 'small', label: 'Draft · 768×768', w: 768, h: 768 },
];

export const sizeById = (id) => IMAGE_SIZES.find((s) => s.id === id) || IMAGE_SIZES[0];
