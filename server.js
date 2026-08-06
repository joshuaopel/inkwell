import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import os from 'node:os';

import { providerFor, cloudProvider, cloudConfigured, ollama, ollamaDiagnose, OLLAMA_HOST, CLOUD_SERVICES, CLOUD_PREFIX } from './lib/ollama.js';
import * as store from './lib/store.js';
import { systemPrompt, buildWriteMessages } from './lib/context.js';
import { interviewMessages, outlineMessages, bibleSeedMessages, summaryMessages, nextQuestionMessages, refineOutlineMessages, designMessages, spreadPlanMessages, visualBibleMessages, illustrationMessages } from './lib/prompts.js';
import { buildEpub } from './lib/epub.js';
import { catalog, presetDesign, normalizeDesign, findTrim, findFont, ENUMS } from './lib/design.js';
import { kindList, kindOf, isPicture, targets } from './lib/kinds.js';
import { IMAGE_BACKENDS, IMAGE_SIZES, sizeById, imagesConfigured, imageProvider } from './lib/imagegen.js';
import * as engine from './lib/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// The guide lives at the repo root, because that's the file GitHub Pages
// publishes. Keep serving it from inside the app too, so the ? button works
// with the network unplugged and there's only ever one copy of it.
app.get('/guide.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Pull the first JSON object/array out of a model response, tolerating stray
// prose or code fences that small local models sometimes add.
function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;
  // find matching end by scanning
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === open) depth++;
    else if (cleaned[i] === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const asyncH = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: String(e.message || e) });
});

// Planning calls (interview, outline, bible, summary) send large prompts and
// expect long JSON back. Ollama's default context is only 2048 tokens, which
// silently truncates a rich interview and yields broken/empty JSON. Give these
// a big context window and generous output budget, and a lower temperature so
// the structured JSON stays valid.
async function planOptions() {
  const s = await store.getSettings();
  return {
    num_ctx: Math.max(s.generation?.num_ctx || 0, 16384),
    num_predict: 4096,
    temperature: 0.5,
    top_p: s.generation?.top_p ?? 0.9,
  };
}

// Pick the adapter for a request. Local unless the model id says otherwise, so
// the default path never touches the network.
const P = async (model) => providerFor(model, await store.getSettings());

// ---- Provider / health ----
app.get('/api/health', asyncH(async (_req, res) => {
  const settings = await store.getSettings();
  const local = await ollamaDiagnose();
  const cloud = cloudConfigured(settings);
  res.json({
    ollama: local.ok,
    reason: local.reason || '',
    host: OLLAMA_HOST,
    cloud: cloud ? { enabled: true, service: settings.cloud.service, ok: await cloudProvider(settings).health() } : { enabled: false },
  });
}));

app.get('/api/models', asyncH(async (_req, res) => {
  const settings = await store.getSettings();
  const out = { models: [], errors: {} };
  try { out.models = await ollama.listModels(); }
  catch (e) { out.errors.local = String(e.message || e); }

  // Cloud models are additive and never block the local list.
  if (cloudConfigured(settings)) {
    try { out.models = out.models.concat(await cloudProvider(settings).listModels()); }
    catch (e) { out.errors.cloud = String(e.message || e); }
  }
  res.json(out);
}));

app.get('/api/cloud/services', (_req, res) => res.json({ services: CLOUD_SERVICES, prefix: CLOUD_PREFIX }));

// ---- Settings ----
// The API key is never sent back out, only whether one exists.
app.get('/api/settings', asyncH(async (_req, res) => res.json(store.redactSettings(await store.getSettings()))));
app.put('/api/settings', asyncH(async (req, res) => res.json(store.redactSettings(await store.saveSettings(req.body || {})))));
app.post('/api/settings/reset', asyncH(async (_req, res) => res.json(store.redactSettings(await store.saveSettings(store.DEFAULT_SETTINGS)))));

// ---- Books ----
app.get('/api/books', asyncH(async (_req, res) => res.json({ books: await store.listBooks() })));

app.post('/api/books', asyncH(async (req, res) => res.json(await store.createBook(req.body || {}))));

app.get('/api/books/:id', asyncH(async (req, res) => {
  const book = await store.getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'not found' });
  res.json(book);
}));

app.patch('/api/books/:id/meta', asyncH(async (req, res) => res.json(await store.updateMeta(req.params.id, req.body || {}))));
app.put('/api/books/:id/bible', asyncH(async (req, res) => res.json(await store.saveBible(req.params.id, req.body || {}))));
app.put('/api/books/:id/outline', asyncH(async (req, res) => res.json(await store.saveOutline(req.params.id, req.body || {}))));
app.put('/api/books/:id/chapters/:chapterId', asyncH(async (req, res) => {
  await store.saveChapter(req.params.id, req.params.chapterId, (req.body || {}).content || '');
  res.json({ ok: true });
}));
app.put('/api/books/:id/plan', asyncH(async (req, res) => res.json(await store.savePlan(req.params.id, req.body || {}))));
app.put('/api/books/:id/notes', asyncH(async (req, res) => {
  await store.saveNotes(req.params.id, (req.body || {}).notes || '');
  res.json({ ok: true });
}));
app.delete('/api/books/:id', asyncH(async (req, res) => {
  await store.deleteBook(req.params.id);
  res.json({ ok: true });
}));

// ---- Page design ----
app.get('/api/design/catalog', (_req, res) => res.json(catalog()));
app.get('/api/design/preset/:id', (req, res) => res.json(presetDesign(req.params.id)));

app.get('/api/books/:id/design', asyncH(async (req, res) => res.json(await store.getDesign(req.params.id))));
app.put('/api/books/:id/design', asyncH(async (req, res) => res.json(await store.saveDesign(req.params.id, req.body || {}))));

// Let the local model art-direct the book. Its answer is a set of ids, which we
// map onto a real design and clamp — never trusted straight through.
app.post('/api/design/suggest', asyncH(async (req, res) => {
  const { model, meta = {}, bible = {}, brief, base } = req.body || {};
  const cat = catalog();
  const text = await (await P(model)).chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: designMessages({ meta, bible, catalog: cat, brief }),
  });
  const d = parseJsonLoose(text);
  if (!d) return res.status(422).json({ error: 'The model did not return a usable design. Try again, or a larger model.' });

  // Start from the closest named preset so anything the model omits still hangs
  // together, then lay its specific choices on top. Anything it gets wrong
  // falls back to that preset rather than to the global default — a design the
  // model half-answered should still look like the look it was aiming at.
  const start = cat.presets.some((p) => p.id === d.closestPreset)
    ? presetDesign(d.closestPreset)
    : normalizeDesign(base || {});

  const one = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  const nOr = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);
  const cOr = (v, fallback) => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(v)) ? v : fallback);
  const font = findFont(d.font);
  const marg = d.margins && typeof d.margins === 'object' ? d.margins : {};

  const design = normalizeDesign({
    ...start,
    preset: 'custom',
    trim: findTrim(d.trim) ? { id: d.trim } : start.trim,
    margins: {
      top: nOr(marg.top, start.margins.top), bottom: nOr(marg.bottom, start.margins.bottom),
      inner: nOr(marg.inner, start.margins.inner), outer: nOr(marg.outer, start.margins.outer),
    },
    type: {
      ...start.type,
      fontId: font ? font.id : start.type.fontId,
      stack: font ? font.stack : start.type.stack,
      size: nOr(d.size, start.type.size),
      leading: nOr(d.leading, start.type.leading),
      indent: nOr(d.indent, start.type.indent),
      spacing: nOr(d.spacing, start.type.spacing),
      align: one(d.align, ENUMS.align, start.type.align),
      firstLine: one(d.firstLine, ENUMS.firstLine, start.type.firstLine),
    },
    opener: {
      ...start.opener,
      style: one(d.openerStyle, ENUMS.openerStyle, start.opener.style),
      numbering: one(d.numbering, ENUMS.numbering, start.opener.numbering),
      ornament: typeof d.ornament === 'string' && d.ornament.trim() ? d.ornament : start.opener.ornament,
    },
    furniture: {
      runningHead: one(d.runningHead, ENUMS.runningHead, start.furniture.runningHead),
      folio: one(d.folio, ENUMS.folio, start.furniture.folio),
      sceneBreak: typeof d.sceneBreak === 'string' && d.sceneBreak.trim() ? d.sceneBreak : start.furniture.sceneBreak,
    },
    paper: {
      ...start.paper,
      tint: cOr(d.tint, start.paper.tint),
      ink: cOr(d.ink, start.paper.ink),
      accent: cOr(d.accent, start.paper.accent),
      texture: one(d.texture, ENUMS.texture, start.paper.texture),
    },
  });

  res.json({ design, rationale: String(d.rationale || '').slice(0, 400) });
}));

// ---- Art: placements + uploaded assets ----
app.get('/api/books/:id/art', asyncH(async (req, res) => res.json(await store.getArt(req.params.id))));
app.put('/api/books/:id/art', asyncH(async (req, res) => res.json(await store.saveArt(req.params.id, req.body || {}))));

app.get('/api/books/:id/assets', asyncH(async (req, res) => res.json({ assets: await store.listAssets(req.params.id) })));

// Uploads come up as a raw body — no multipart dependency needed for one file
// at a time, and it keeps big images out of the JSON parser.
const ASSET_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif',
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf',
  'application/font-woff', 'application/x-font-ttf', 'application/x-font-otf', 'application/octet-stream',
];
app.post(
  '/api/books/:id/assets',
  express.raw({ type: ASSET_TYPES, limit: '30mb' }),
  asyncH(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'No file body received.' });
    }
    const mime = String(req.get('content-type') || '').split(';')[0];
    const kind = req.query.kind === 'font' || mime.startsWith('font/') ? 'font' : 'image';
    if (kind === 'image' && !mime.startsWith('image/')) {
      return res.status(415).json({ error: `Unsupported file type: ${mime}` });
    }
    const item = await store.addAsset(req.params.id, {
      name: req.query.name, kind, mime, buffer: req.body, w: req.query.w, h: req.query.h,
    });
    res.json(item);
  })
);

app.get('/api/books/:id/assets/:assetId/raw', asyncH(async (req, res) => {
  const found = await store.getAsset(req.params.id, req.params.assetId);
  if (!found) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', found.item.mime || 'application/octet-stream');
  // Asset ids are unique per upload, so the bytes behind one never change.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(found.buffer);
}));

app.delete('/api/books/:id/assets/:assetId', asyncH(async (req, res) => {
  const ok = await store.deleteAsset(req.params.id, req.params.assetId);
  res.status(ok ? 200 : 404).json({ ok });
}));

// ---- Illustrated books ----
app.get('/api/kinds', (_req, res) => res.json({ kinds: kindList() }));
app.get('/api/image/backends', (_req, res) => res.json({ backends: IMAGE_BACKENDS, sizes: IMAGE_SIZES }));

app.get('/api/image/health', asyncH(async (_req, res) => {
  const settings = await store.getSettings();
  if (!imagesConfigured(settings)) return res.json({ enabled: false });
  const p = imageProvider(settings);
  const h = await p.health();
  res.json({ enabled: true, backend: settings.image.backend, host: p.base, ...h, models: h.ok ? await p.models() : [] });
}));

// ---- The drawing engine Inkwell installs for you ----
app.get('/api/image/engine', asyncH(async (_req, res) => res.json(await engine.status())));

// Downloading gigabytes with no sign of life is indistinguishable from a hang,
// so the install streams its progress as NDJSON while it works.
app.post('/api/image/engine/install', asyncH(async (req, res) => {
  const { tier, accel } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();

  // Closing the tab shouldn't leave a download running forever. This has to
  // hang off the RESPONSE: the request's own 'close' fires the moment its body
  // has been read, which is immediately, and would cancel every install.
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };

  try {
    const st = await engine.install({ tier, accel, signal: ctl.signal, onProgress: send });
    send({ stage: 'installed', status: st });
  } catch (e) {
    send({ stage: 'error', error: ctl.signal.aborted ? 'Cancelled.' : String(e.message || e) });
  }
  res.end();
}));

// Loading the model takes a while the first time; this lets the UI ask for it
// up front rather than making the first drawing look broken.
app.post('/api/image/engine/start', asyncH(async (_req, res) => {
  await engine.start();
  res.json(await engine.status());
}));

app.post('/api/image/engine/stop', asyncH(async (_req, res) => {
  await engine.stop();
  res.json(await engine.status());
}));

app.delete('/api/image/engine', asyncH(async (_req, res) => res.json(await engine.remove())));

// Plan a picture book as spreads: the words on each page, and a note on what
// the picture shows. Kept separate from the novel outline because the shape,
// the length and the craft are all different.
app.post('/api/plan/spreads', asyncH(async (req, res) => {
  const { model, premise, answers, spreads, wordsPerSpread, ageLabel } = req.body || {};
  const text = await (await P(model)).chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: spreadPlanMessages({ premise, answers, spreads: spreads || 14, wordsPerSpread: wordsPerSpread || 45, ageLabel }),
  });
  res.json(parseJsonLoose(text) || { spreads: [], synopsis: '', refrain: '' });
}));

// The locked look: one style line for the whole book plus a fixed physical
// description per character. This is what stops the protagonist changing shape
// between pages.
app.post('/api/plan/visual', asyncH(async (req, res) => {
  const { model, premise, answers, characters, brief } = req.body || {};
  const text = await (await P(model)).chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: visualBibleMessages({ premise, answers, characters, brief }),
  });
  const d = parseJsonLoose(text) || {};
  res.json({
    style: String(d.style || '').slice(0, 400),
    palette: Array.isArray(d.palette) ? d.palette.slice(0, 8).map((x) => String(x).slice(0, 40)) : [],
    characters: Array.isArray(d.characters)
      ? d.characters.slice(0, 20).map((c) => ({ name: String(c.name || '').slice(0, 80), look: String(c.look || '').slice(0, 400) }))
      : [],
  });
}));

// Turn one spread into an image prompt, carrying the locked style and the
// character looks in verbatim.
app.post('/api/illustrate/prompt', asyncH(async (req, res) => {
  const { model, text, art, style, palette, looks, previous } = req.body || {};
  const out = await (await P(model)).chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: illustrationMessages({ text, art, style, palette, looks, previous }),
  });
  const d = parseJsonLoose(out) || {};
  res.json({ prompt: String(d.prompt || '').slice(0, 2000), negative: String(d.negative || '').slice(0, 600) });
}));

// Render a prompt and keep the result in the book's own assets folder.
app.post('/api/books/:id/illustrate', asyncH(async (req, res) => {
  const settings = await store.getSettings();
  if (!imagesConfigured(settings)) {
    return res.status(400).json({ error: 'No image backend is configured. Settings → Illustration.' });
  }
  const { prompt, negative, seed, name } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'Nothing to draw — the prompt is empty.' });

  const size = sizeById(settings.image.size);
  const provider = imageProvider(settings);
  const img = await provider.generate({
    prompt: String(prompt).slice(0, 2000),
    negative: [settings.image.negative, negative].filter(Boolean).join(', '),
    width: size.w, height: size.h,
    // Zero means "whatever this model wants" — the built-in engine knows the
    // right step count for the model it installed, and guessing on its behalf
    // would ruin a four-step model by giving it twenty-eight.
    steps: Math.min(80, Math.max(0, +settings.image.steps || 0)),
    seed: Number.isFinite(+seed) ? +seed : -1,
    model: settings.image.model,
    workflow: settings.image.workflow ? parseJsonLoose(settings.image.workflow) : null,
  });

  const asset = await store.addAsset(req.params.id, {
    name: name || 'illustration', kind: 'image', mime: img.mime || 'image/png',
    buffer: img.buffer, w: img.width || size.w, h: img.height || size.h,
  });
  res.json({ asset, seed: img.seed });
}));

// ---- Plan mode ----
app.post('/api/plan/interview', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense } = req.body || {};
  const text = await (await P(model)).chatOnce({ model, messages: interviewMessages({ premise, genre, pov, tense }), format: 'json' });
  const data = parseJsonLoose(text) || { questions: [] };
  res.json(data);
}));

// One question at a time, aware of everything already said.
app.post('/api/plan/next-question', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense, transcript, kind } = req.body || {};
  const text = await (await P(model)).chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: nextQuestionMessages({ premise, genre, pov, tense, transcript, kind: kindOf({ kind }) }),
  });
  const data = parseJsonLoose(text) || {};
  res.json({ question: data.question || '', probing: data.probing || '' });
}));

app.post('/api/plan/outline', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense, answers } = req.body || {};
  const text = await (await P(model)).chatOnce({ model, messages: outlineMessages({ premise, genre, pov, tense, answers }), format: 'json', options: await planOptions() });
  const data = parseJsonLoose(text) || { synopsis: '', chapters: [] };
  res.json(data);
}));

app.post('/api/plan/bible', asyncH(async (req, res) => {
  const { model, premise, genre, answers, synopsis } = req.body || {};
  const text = await (await P(model)).chatOnce({ model, messages: bibleSeedMessages({ premise, genre, answers, synopsis }), format: 'json', options: await planOptions() });
  const data = parseJsonLoose(text) || { characters: [], locations: [], themes: [], styleGuide: '' };
  res.json(data);
}));

// Refine an existing outline against structural notes.
app.post('/api/plan/refine-outline', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense, synopsis, answers, currentOutline, notes, targetChapters } = req.body || {};
  const text = await (await P(model)).chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: refineOutlineMessages({ premise, genre, pov, tense, synopsis, answers, currentOutline, notes, targetChapters }),
  });
  const data = parseJsonLoose(text) || { acts: [], chapters: [] };
  res.json(data);
}));

app.post('/api/summary', asyncH(async (req, res) => {
  const { model, previousSummary, newChapterTitle, newChapterText } = req.body || {};
  const text = await (await P(model)).chatOnce({ model, messages: summaryMessages({ previousSummary, newChapterTitle, newChapterText }), format: 'json', options: await planOptions() });
  const data = parseJsonLoose(text) || { summary: previousSummary || '' };
  res.json(data);
}));

// ---- Writing (streaming) ----
// Assembles the 3-layer context, streams Ollama's NDJSON straight to the browser.
app.post('/api/write', asyncH(async (req, res) => {
  const { model, meta, bible, chapter, priorText, followingText, selection, instruction, action, notes, previousAttempt } = req.body || {};
  // Generation + context knobs come from settings.json unless the client overrides.
  const settings = await store.getSettings();
  const options = { ...settings.generation, ...(req.body.options || {}) };
  const ctx = { ...settings.context, ...(req.body.ctx || {}) };
  const messages = [
    { role: 'system', content: systemPrompt(meta, bible || {}) },
    ...buildWriteMessages({
      meta, bible: bible || {}, chapter, priorText, followingText, selection, instruction, action,
      notes, previousAttempt,
      localWords: ctx.localWords, includeBible: ctx.includeBible, includeSummary: ctx.includeSummary,
    }),
  ];
  const body = await (await P(model)).chatStream({ model, messages, options });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  Readable.fromWeb(body).pipe(res);
}));

// ---- Export ----
app.get('/api/books/:id/export.epub', asyncH(async (req, res) => {
  const book = await store.getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'not found' });
  const buf = await buildEpub({
    meta: book.meta, outline: book.outline,
    design: book.design, art: book.art, assets: book.assets,
    readAsset: async (assetId) => (await store.getAsset(req.params.id, assetId))?.buffer,
  });
  const safe = (book.meta.title || 'book').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'book';
  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.epub"`);
  res.send(buf);
}));

// Every LAN address this machine answers on, so you can open Inkwell from a
// phone or tablet without hunting for your IP.
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

const PORT = process.env.PORT || 4321;
// Bind to every interface so other devices on your network can reach it. Set
// INKWELL_HOST=127.0.0.1 to keep it strictly on this machine.
const HOST = process.env.INKWELL_HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  const lan = lanAddresses();
  console.log(`\n  Inkwell  ·  your local AI writing studio`);
  console.log(`  ▸ http://localhost:${PORT}`);
  if (HOST === '0.0.0.0' && lan.length) {
    for (const ip of lan) console.log(`  ▸ http://${ip}:${PORT}   ← from your phone, on the same network`);
  } else if (HOST !== '0.0.0.0') {
    console.log(`  ▸ bound to ${HOST} only (set INKWELL_HOST=0.0.0.0 to allow LAN devices)`);
  }
  console.log(`  ▸ Ollama: ${OLLAMA_HOST}\n`);
});
