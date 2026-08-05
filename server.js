import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import { provider, OLLAMA_HOST } from './lib/ollama.js';
import * as store from './lib/store.js';
import { systemPrompt, buildWriteMessages } from './lib/context.js';
import { interviewMessages, outlineMessages, bibleSeedMessages, summaryMessages, nextQuestionMessages, refineOutlineMessages } from './lib/prompts.js';
import { buildEpub } from './lib/epub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const P = provider();

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

// ---- Provider / health ----
app.get('/api/health', asyncH(async (_req, res) => {
  const ok = await P.health();
  res.json({ ollama: ok, host: OLLAMA_HOST });
}));

app.get('/api/models', asyncH(async (_req, res) => {
  res.json({ models: await P.listModels() });
}));

// ---- Settings ----
app.get('/api/settings', asyncH(async (_req, res) => res.json(await store.getSettings())));
app.put('/api/settings', asyncH(async (req, res) => res.json(await store.saveSettings(req.body || {}))));
app.post('/api/settings/reset', asyncH(async (_req, res) => res.json(await store.saveSettings(store.DEFAULT_SETTINGS))));

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

// ---- Plan mode ----
app.post('/api/plan/interview', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense } = req.body || {};
  const text = await P.chatOnce({ model, messages: interviewMessages({ premise, genre, pov, tense }), format: 'json' });
  const data = parseJsonLoose(text) || { questions: [] };
  res.json(data);
}));

// One question at a time, aware of everything already said.
app.post('/api/plan/next-question', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense, transcript } = req.body || {};
  const text = await P.chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: nextQuestionMessages({ premise, genre, pov, tense, transcript }),
  });
  const data = parseJsonLoose(text) || {};
  res.json({ question: data.question || '', probing: data.probing || '' });
}));

app.post('/api/plan/outline', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense, answers } = req.body || {};
  const text = await P.chatOnce({ model, messages: outlineMessages({ premise, genre, pov, tense, answers }), format: 'json', options: await planOptions() });
  const data = parseJsonLoose(text) || { synopsis: '', chapters: [] };
  res.json(data);
}));

app.post('/api/plan/bible', asyncH(async (req, res) => {
  const { model, premise, genre, answers, synopsis } = req.body || {};
  const text = await P.chatOnce({ model, messages: bibleSeedMessages({ premise, genre, answers, synopsis }), format: 'json', options: await planOptions() });
  const data = parseJsonLoose(text) || { characters: [], locations: [], themes: [], styleGuide: '' };
  res.json(data);
}));

// Refine an existing outline against structural notes.
app.post('/api/plan/refine-outline', asyncH(async (req, res) => {
  const { model, premise, genre, pov, tense, synopsis, answers, currentOutline, notes, targetChapters } = req.body || {};
  const text = await P.chatOnce({
    model, format: 'json', options: await planOptions(),
    messages: refineOutlineMessages({ premise, genre, pov, tense, synopsis, answers, currentOutline, notes, targetChapters }),
  });
  const data = parseJsonLoose(text) || { acts: [], chapters: [] };
  res.json(data);
}));

app.post('/api/summary', asyncH(async (req, res) => {
  const { model, previousSummary, newChapterTitle, newChapterText } = req.body || {};
  const text = await P.chatOnce({ model, messages: summaryMessages({ previousSummary, newChapterTitle, newChapterText }), format: 'json', options: await planOptions() });
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
  const body = await P.chatStream({ model, messages, options });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  Readable.fromWeb(body).pipe(res);
}));

// ---- Export ----
app.get('/api/books/:id/export.epub', asyncH(async (req, res) => {
  const book = await store.getBook(req.params.id);
  if (!book) return res.status(404).json({ error: 'not found' });
  const buf = await buildEpub({ meta: book.meta, outline: book.outline });
  const safe = (book.meta.title || 'book').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'book';
  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.epub"`);
  res.send(buf);
}));

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
  console.log(`\n  Inkwell  ·  your local AI writing studio`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ Ollama: ${OLLAMA_HOST}\n`);
});
