// Provider layer. Ollama is the default and the one Inkwell is built for:
// local, free, private, unmetered. A cloud provider can be configured in
// Settings for people who can't run a model — a phone, a work laptop, a machine
// with 8GB of RAM — but it's opt-in and it's second class on purpose.
//
// Every provider implements the same four functions:
//   listModels() -> [{ name, ... }]
//   chatOnce({ model, messages, format, options }) -> string
//   chatStream({ model, messages, options }) -> web ReadableStream of NDJSON
//   health() -> boolean
//
// Cloud streams are translated into Ollama's NDJSON shape so the browser only
// ever has to understand one wire format.

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// Cloud model ids are prefixed so a request can be routed without guessing.
export const CLOUD_PREFIX = 'cloud:';
export const isCloudModel = (m) => typeof m === 'string' && m.startsWith(CLOUD_PREFIX);
export const bareModel = (m) => (isCloudModel(m) ? m.slice(CLOUD_PREFIX.length) : m);

// ---------------------------------------------------------------- Ollama ----
async function ollamaListModels() {
  const r = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!r.ok) throw new Error(`Ollama /api/tags ${r.status}`);
  const data = await r.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    family: m.details?.family,
    parameterSize: m.details?.parameter_size,
    context: m.details?.context_length,
    where: 'local',
  }));
}

// Non-streaming call. Returns the full assistant text.
// Pass format:'json' to ask the model for strict JSON (Ollama's grammar-constrained mode).
async function ollamaChatOnce({ model, messages, format, options }) {
  const body = { model, messages, stream: false };
  if (format) body.format = format;
  if (options) body.options = options;
  const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Ollama /api/chat ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.message?.content ?? '';
}

// Streaming call. Returns a web ReadableStream of NDJSON lines from Ollama.
// The server pipes this straight to the browser so tokens appear live.
async function ollamaChatStream({ model, messages, options }) {
  const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options }),
  });
  if (!r.ok) throw new Error(`Ollama /api/chat ${r.status}: ${await r.text()}`);
  return r.body;
}

async function ollamaHealth() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

const ollama = {
  id: 'ollama',
  listModels: ollamaListModels,
  chatOnce: ollamaChatOnce,
  chatStream: ollamaChatStream,
  health: ollamaHealth,
};

// ------------------------------------------------------- cloud plumbing ----
// Ollama's generation knobs, translated. repeat_penalty and num_ctx have no
// portable equivalent, so they're dropped rather than faked.
function cloudSampling(options = {}) {
  const out = {};
  if (Number.isFinite(+options.temperature)) out.temperature = +options.temperature;
  if (Number.isFinite(+options.top_p)) out.top_p = +options.top_p;
  if (Number.isFinite(+options.num_predict)) out.max_tokens = Math.max(1, Math.round(+options.num_predict));
  return out;
}

// Wrap a per-chunk text extractor into a stream of Ollama-shaped NDJSON.
function ndjsonFromSse(upstream, extract) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const reader = upstream.getReader();
  let buf = '';
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(enc.encode(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n'));
        controller.close();
        return;
      }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        const text = extract(json);
        if (text) {
          controller.enqueue(enc.encode(JSON.stringify({ message: { role: 'assistant', content: text }, done: false }) + '\n'));
        }
      }
    },
    cancel(reason) { reader.cancel(reason); },
  });
}

async function failed(r, who) {
  const body = await r.text().catch(() => '');
  // Surface the provider's own message — usually "invalid api key" or a quota.
  let detail = body.slice(0, 300);
  try { detail = JSON.parse(body).error?.message || detail; } catch {}
  throw new Error(`${who} ${r.status}: ${detail}`);
}

// ------------------------------------------------ OpenAI-compatible APIs ----
// Covers OpenAI itself, OpenRouter, Groq, Together, and any local server that
// speaks the same shape (LM Studio, llama.cpp, vLLM).
function openaiCompatible(cfg) {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  });

  return {
    id: 'openai',
    async listModels() {
      const r = await fetch(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) await failed(r, 'Provider /models');
      const data = await r.json();
      return (data.data || []).map((m) => ({ name: CLOUD_PREFIX + m.id, where: 'cloud' }));
    },
    async chatOnce({ model, messages, format, options }) {
      const body = { model: bareModel(model), messages, stream: false, ...cloudSampling(options) };
      if (format === 'json') body.response_format = { type: 'json_object' };
      const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      if (!r.ok) await failed(r, 'Provider /chat/completions');
      const data = await r.json();
      return data.choices?.[0]?.message?.content ?? '';
    },
    async chatStream({ model, messages, options }) {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model: bareModel(model), messages, stream: true, ...cloudSampling(options) }),
      });
      if (!r.ok) await failed(r, 'Provider /chat/completions');
      return ndjsonFromSse(r.body, (j) => j.choices?.[0]?.delta?.content || '');
    },
    async health() {
      if (!cfg.apiKey) return false;
      try {
        const r = await fetch(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(5000) });
        return r.ok;
      } catch { return false; }
    },
  };
}

// ------------------------------------------------------------- Anthropic ----
function anthropic(cfg) {
  const base = (cfg.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  const headers = () => ({
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
  });

  // Anthropic takes the system prompt as its own field rather than a message.
  const split = (messages) => ({
    system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined,
    rest: messages.filter((m) => m.role !== 'system'),
  });

  return {
    id: 'anthropic',
    async listModels() {
      const r = await fetch(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) await failed(r, 'Anthropic /models');
      const data = await r.json();
      return (data.data || []).map((m) => ({ name: CLOUD_PREFIX + m.id, where: 'cloud' }));
    },
    async chatOnce({ model, messages, options }) {
      const { system, rest } = split(messages);
      const s = cloudSampling(options);
      const r = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model: bareModel(model), system, messages: rest, max_tokens: s.max_tokens || 4096, temperature: s.temperature, top_p: s.top_p }),
      });
      if (!r.ok) await failed(r, 'Anthropic /messages');
      const data = await r.json();
      return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    },
    async chatStream({ model, messages, options }) {
      const { system, rest } = split(messages);
      const s = cloudSampling(options);
      const r = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model: bareModel(model), system, messages: rest, stream: true, max_tokens: s.max_tokens || 2048, temperature: s.temperature, top_p: s.top_p }),
      });
      if (!r.ok) await failed(r, 'Anthropic /messages');
      return ndjsonFromSse(r.body, (j) => (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' ? j.delta.text : ''));
    },
    async health() {
      if (!cfg.apiKey) return false;
      try {
        const r = await fetch(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(5000) });
        return r.ok;
      } catch { return false; }
    },
  };
}

// ---------------------------------------------------------------- routing ----
const CLOUD_BUILDERS = { openai: openaiCompatible, anthropic };

export const CLOUD_SERVICES = [
  {
    id: 'openai', label: 'OpenAI-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    hint: 'Also OpenRouter, Groq, Together, or any server speaking the same API.',
  },
  {
    id: 'anthropic', label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    hint: 'Claude models, direct.',
  },
];

export function cloudConfigured(settings) {
  const c = settings?.cloud;
  return !!(c && c.enabled && c.apiKey && CLOUD_BUILDERS[c.service]);
}

export function cloudProvider(settings) {
  if (!cloudConfigured(settings)) return null;
  const c = settings.cloud;
  return CLOUD_BUILDERS[c.service]({ apiKey: c.apiKey, baseUrl: c.baseUrl });
}

// Which adapter should handle this request? The model id decides — anything
// prefixed `cloud:` goes out to the network, everything else stays home.
export function providerFor(model, settings) {
  if (isCloudModel(model)) {
    const p = cloudProvider(settings);
    if (!p) throw new Error('That model needs a cloud provider, but none is configured in Settings.');
    return p;
  }
  return ollama;
}

const PROVIDERS = { ollama };

export function provider() {
  return PROVIDERS[process.env.INKWELL_PROVIDER || 'ollama'] || ollama;
}
export { OLLAMA_HOST, ollama };
