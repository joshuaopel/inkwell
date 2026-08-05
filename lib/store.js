// File-based storage. Every book is a folder on disk so your work is portable,
// backup-able, and git-able — nothing is trapped in a browser or a database.
//
//   books/
//     <bookId>/
//       book.json        meta (title, author, premise, POV, tense, settings)
//       bible.json       characters, locations, lore, themes, style, runningSummary
//       outline.json     { acts: [...], chapters: [{ id, title, summary, beats, actId, x, y }] }
//       plan.json        the interview transcript, so Plan mode can be resumed
//       notes.md         freeform project notes
//       chapters/
//         <chapterId>.md the actual prose

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BOOKS_DIR = process.env.INKWELL_BOOKS || path.join(__dirname, '..', 'books');

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJson(p, obj) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}
function bookDir(bookId) { return path.join(BOOKS_DIR, bookId); }

// The four-act spine Inkwell defaults to. Colours drive the act bar and the
// card borders in Map view.
export const DEFAULT_ACTS = [
  { id: 'act-1', title: 'Act I', subtitle: 'Setup', color: 'violet' },
  { id: 'act-2', title: 'Act II', subtitle: 'Complication', color: 'teal' },
  { id: 'act-3', title: 'Act III', subtitle: 'Escalation', color: 'green' },
  { id: 'act-4', title: 'Act IV', subtitle: 'Resolution', color: 'gold' },
];

export async function listBooks() {
  await ensureDir(BOOKS_DIR);
  const entries = await fs.readdir(BOOKS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readJson(path.join(BOOKS_DIR, e.name, 'book.json'), null);
    if (!meta) continue;
    const outline = await readJson(path.join(BOOKS_DIR, e.name, 'outline.json'), { chapters: [] });
    out.push({
      id: meta.id, title: meta.title, author: meta.author,
      updatedAt: meta.updatedAt, chapterCount: (outline.chapters || []).length,
    });
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function createBook({ title, author, premise, genre, pov, tense, wordTarget }) {
  const bookId = id('book');
  const now = new Date().toISOString();
  const meta = {
    id: bookId, title: title || 'Untitled', author: author || '', genre: genre || '',
    premise: premise || '', synopsis: '',
    pov: pov || 'Third person limited', tense: tense || 'Past',
    wordTarget: wordTarget || 0, createdAt: now, updatedAt: now,
  };
  await writeJson(path.join(bookDir(bookId), 'book.json'), meta);
  await writeJson(path.join(bookDir(bookId), 'bible.json'), {
    characters: [], locations: [], lore: [], themes: [], timeline: [],
    styleGuide: '', tone: '', runningSummary: '',
  });
  await writeJson(path.join(bookDir(bookId), 'outline.json'), { acts: DEFAULT_ACTS, chapters: [] });
  await writeJson(path.join(bookDir(bookId), 'plan.json'), { messages: [], suggested: null });
  await fs.writeFile(path.join(bookDir(bookId), 'notes.md'), '', 'utf8');
  await ensureDir(path.join(bookDir(bookId), 'chapters'));
  return meta;
}

export async function getBook(bookId) {
  const meta = await readJson(path.join(bookDir(bookId), 'book.json'), null);
  if (!meta) return null;
  const bible = await readJson(path.join(bookDir(bookId), 'bible.json'), {});
  const outline = await readJson(path.join(bookDir(bookId), 'outline.json'), { acts: DEFAULT_ACTS, chapters: [] });
  const plan = await readJson(path.join(bookDir(bookId), 'plan.json'), { messages: [], suggested: null });
  let notes = '';
  try { notes = await fs.readFile(path.join(bookDir(bookId), 'notes.md'), 'utf8'); } catch {}

  const chapters = [];
  for (const ch of outline.chapters || []) {
    chapters.push({ ...ch, content: await readChapter(bookId, ch.id) });
  }
  return {
    meta, bible, plan, notes,
    outline: { acts: outline.acts?.length ? outline.acts : DEFAULT_ACTS, chapters },
  };
}

export async function updateMeta(bookId, patch) {
  const p = path.join(bookDir(bookId), 'book.json');
  const meta = await readJson(p, null);
  if (!meta) throw new Error('book not found');
  const next = { ...meta, ...patch, id: meta.id, updatedAt: new Date().toISOString() };
  await writeJson(p, next);
  return next;
}

export async function saveBible(bookId, bible) {
  await writeJson(path.join(bookDir(bookId), 'bible.json'), bible);
  await touch(bookId);
  return bible;
}

// Structure only — prose lives in the chapter files.
export async function saveOutline(bookId, outline) {
  const acts = (outline.acts?.length ? outline.acts : DEFAULT_ACTS).map((a, i) => ({
    id: a.id || `act-${i + 1}`,
    title: a.title || `Act ${i + 1}`,
    subtitle: a.subtitle || '',
    color: a.color || DEFAULT_ACTS[i % 4].color,
  }));
  const chapters = (outline.chapters || []).map((c) => ({
    id: c.id || id('ch'),
    title: c.title || 'Untitled chapter',
    summary: c.summary || '',
    beats: c.beats || [],
    actId: c.actId || acts[0].id,
    status: c.status || 'planned',
    wordTarget: c.wordTarget || 0,
    // Map-view node position. null means "auto-arrange me".
    x: typeof c.x === 'number' ? c.x : null,
    y: typeof c.y === 'number' ? c.y : null,
  }));
  await writeJson(path.join(bookDir(bookId), 'outline.json'), { acts, chapters });
  await touch(bookId);
  return { acts, chapters };
}

export async function savePlan(bookId, plan) {
  await writeJson(path.join(bookDir(bookId), 'plan.json'), plan || { messages: [], suggested: null });
  await touch(bookId);
  return plan;
}

export async function saveNotes(bookId, notes) {
  await fs.writeFile(path.join(bookDir(bookId), 'notes.md'), notes ?? '', 'utf8');
  await touch(bookId);
  return true;
}

export async function readChapter(bookId, chapterId) {
  try { return await fs.readFile(path.join(bookDir(bookId), 'chapters', `${chapterId}.md`), 'utf8'); }
  catch { return ''; }
}

export async function saveChapter(bookId, chapterId, content) {
  await ensureDir(path.join(bookDir(bookId), 'chapters'));
  await fs.writeFile(path.join(bookDir(bookId), 'chapters', `${chapterId}.md`), content ?? '', 'utf8');
  await touch(bookId);
  return true;
}

async function touch(bookId) { try { await updateMeta(bookId, {}); } catch {} }

export async function deleteBook(bookId) {
  await fs.rm(bookDir(bookId), { recursive: true, force: true });
}

// ---------- app settings (settings.json beside the books folder) ----------
const SETTINGS_PATH = path.join(BOOKS_DIR, '..', 'settings.json');

export const DEFAULT_SETTINGS = {
  defaultModel: '',
  generation: { temperature: 0.8, top_p: 0.9, repeat_penalty: 1.1, num_ctx: 8192, num_predict: 700 },
  context: { localWords: 350, includeBible: true, includeSummary: true },
  editor: { fontSize: 18, lineHeight: 1.78, measure: 72, spellcheck: true },
};

export async function getSettings() {
  const s = await readJson(SETTINGS_PATH, {});
  return {
    ...DEFAULT_SETTINGS, ...s,
    generation: { ...DEFAULT_SETTINGS.generation, ...(s.generation || {}) },
    context: { ...DEFAULT_SETTINGS.context, ...(s.context || {}) },
    editor: { ...DEFAULT_SETTINGS.editor, ...(s.editor || {}) },
  };
}

export async function saveSettings(patch) {
  const next = {
    ...DEFAULT_SETTINGS, ...patch,
    generation: { ...DEFAULT_SETTINGS.generation, ...(patch.generation || {}) },
    context: { ...DEFAULT_SETTINGS.context, ...(patch.context || {}) },
    editor: { ...DEFAULT_SETTINGS.editor, ...(patch.editor || {}) },
  };
  await writeJson(SETTINGS_PATH, next);
  return next;
}

export { id };
