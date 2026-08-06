// Image provider layer — the same shape as lib/ollama.js, for pictures.
//
// Ollama gained image generation in January 2026, but macOS only; Windows and
// Linux are "coming soon". So the backend you actually run today on a PC is
// ComfyUI or AUTOMATIC1111, and the Ollama entry here sits ready for the day it
// lands rather than being written later in a panic.
//
// Every backend implements:
//   health()   -> { ok, reason? }
//   models()   -> [names]           (best effort; may be empty)
//   generate({ prompt, negative, width, height, steps, seed, model })
//                 -> { buffer, mime, seed }
//
// Whatever the backend, the result comes back as PNG bytes that get saved into
// the book's own assets folder — so an illustrated book stays a folder you own.

const DEFAULTS = {
  comfyui: 'http://127.0.0.1:8188',
  automatic1111: 'http://127.0.0.1:7860',
  ollama: 'http://127.0.0.1:11434',
};

export const IMAGE_BACKENDS = [
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

async function fail(r, who) {
  let detail = (await r.text().catch(() => '')).slice(0, 300);
  try { detail = JSON.parse(detail).error || detail; } catch {}
  throw new Error(`${who} ${r.status}: ${detail}`);
}

// ------------------------------------------------------- AUTOMATIC1111 ----
// The simplest of the three: one POST, base64 PNGs back.
function automatic1111(cfg) {
  const base = resolveHost(cfg.baseUrl, DEFAULTS.automatic1111);
  return {
    id: 'automatic1111',
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
      const r = await fetch(`${base}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt, negative_prompt: negative || '',
          width, height, steps, seed: seed ?? -1,
          cfg_scale: 6, sampler_name: 'DPM++ 2M',
        }),
      });
      if (!r.ok) await fail(r, 'AUTOMATIC1111 /txt2img');
      const data = await r.json();
      const img = data.images?.[0];
      if (!img) throw new Error('AUTOMATIC1111 returned no image.');
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

const BUILDERS = { comfyui, automatic1111, ollama: ollamaImages };

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
