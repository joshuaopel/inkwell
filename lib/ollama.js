// Provider layer. Ollama is the default (local, free, private).
// This file is intentionally small and pluggable: to add OpenAI / Anthropic /
// OpenRouter later, add another entry to PROVIDERS with the same shape and
// point PROVIDER at it (or make it configurable per-request). The rest of the
// app only talks to these three functions: listModels, chatOnce, chatStream.

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

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

const PROVIDERS = {
  ollama: {
    listModels: ollamaListModels,
    chatOnce: ollamaChatOnce,
    chatStream: ollamaChatStream,
    health: ollamaHealth,
  },
  // openai:   { ... }   // add later — same shape
  // anthropic:{ ... }
};

const PROVIDER = process.env.INKWELL_PROVIDER || 'ollama';

export function provider() {
  return PROVIDERS[PROVIDER];
}
export { OLLAMA_HOST };
