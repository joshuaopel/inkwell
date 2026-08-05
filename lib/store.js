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
//       design.json      page design (trim, margins, type, furniture, paper)
//       art.json         where pictures sit in the prose + the asset manifest
//       assets/
//         <assetId>.png  uploaded art and fonts, kept beside the book
//       chapters/
//         <chapterId>.md the actual prose

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDesign, normalizeArt, DEFAULT_DESIGN } from './design.js';

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
    design: await getDesign(bookId),
    art: await getArt(bookId),
    assets: await listAssets(bookId),
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
    // Word count at the last time this chapter was folded into the running
    // summary — how Inkwell knows what its memory is still missing.
    summarizedWords: Number.isFinite(+c.summarizedWords) ? +c.summarizedWords : 0,
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

// ---------- page design ----------
// Books made before the Pages view have no design.json; they inherit the
// default and only get a file once you change something.
export async function getDesign(bookId) {
  return normalizeDesign(await readJson(path.join(bookDir(bookId), 'design.json'), DEFAULT_DESIGN));
}

export async function saveDesign(bookId, design) {
  const next = normalizeDesign(design);
  await writeJson(path.join(bookDir(bookId), 'design.json'), next);
  await touch(bookId);
  return next;
}

// ---------- art placements ----------
export async function getArt(bookId) {
  return normalizeArt(await readJson(path.join(bookDir(bookId), 'art.json'), { placements: [] }));
}

export async function saveArt(bookId, art) {
  const next = normalizeArt(art);
  await writeJson(path.join(bookDir(bookId), 'art.json'), next);
  await touch(bookId);
  return next;
}

// ---------- assets (uploaded art + fonts) ----------
// Files live in the book folder so "back up the folder" still backs up
// everything. The manifest is assets/index.json.
function assetsDir(bookId) { return path.join(bookDir(bookId), 'assets'); }
function manifestPath(bookId) { return path.join(assetsDir(bookId), 'index.json'); }

const EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff': '.woff', 'application/x-font-ttf': '.ttf', 'application/x-font-otf': '.otf',
};

export async function listAssets(bookId) {
  const items = await readJson(manifestPath(bookId), []);
  return Array.isArray(items) ? items : [];
}

export async function addAsset(bookId, { name, kind, mime, buffer, w, h }) {
  const ext = EXT_BY_MIME[mime] || path.extname(String(name || '')).slice(0, 6) || '.bin';
  const assetId = id(kind === 'font' ? 'font' : 'img').replace(/[^a-z0-9_-]/gi, '');
  await ensureDir(assetsDir(bookId));
  await fs.writeFile(path.join(assetsDir(bookId), assetId + ext), buffer);
  const item = {
    id: assetId, file: assetId + ext, kind: kind === 'font' ? 'font' : 'image',
    name: String(name || 'untitled').replace(/[^\w .,'()-]+/g, '_').slice(0, 120) || 'untitled',
    mime, bytes: buffer.length,
    w: Number.isFinite(+w) ? Math.round(+w) : 0,
    h: Number.isFinite(+h) ? Math.round(+h) : 0,
    addedAt: new Date().toISOString(),
  };
  const items = await listAssets(bookId);
  items.push(item);
  await writeJson(manifestPath(bookId), items);
  await touch(bookId);
  return item;
}

export async function getAsset(bookId, assetId) {
  const item = (await listAssets(bookId)).find((a) => a.id === assetId);
  if (!item) return null;
  // item.file was generated by us, but re-check it can't escape the folder.
  const full = path.join(assetsDir(bookId), path.basename(item.file));
  return { item, buffer: await fs.readFile(full) };
}

export async function deleteAsset(bookId, assetId) {
  const items = await listAssets(bookId);
  const item = items.find((a) => a.id === assetId);
  if (!item) return false;
  await fs.rm(path.join(assetsDir(bookId), path.basename(item.file)), { force: true });
  await writeJson(manifestPath(bookId), items.filter((a) => a.id !== assetId));
  // Drop any placements that pointed at it, so pages don't render holes.
  const art = await getArt(bookId);
  await saveArt(bookId, { placements: art.placements.filter((p) => p.assetId !== assetId) });
  await touch(bookId);
  return true;
}

// ---------- app settings (settings.json beside the books folder) ----------
const SETTINGS_PATH = path.join(BOOKS_DIR, '..', 'settings.json');

export const DEFAULT_SETTINGS = {
  defaultModel: '',
  generation: { temperature: 0.8, top_p: 0.9, repeat_penalty: 1.1, num_ctx: 8192, num_predict: 700 },
  context: { localWords: 350, includeBible: true, includeSummary: true, autoSummary: true },
  editor: { fontSize: 18, lineHeight: 1.78, measure: 72, spellcheck: true },
  // Speech in and out, both on-device only. See public/voice.js.
  voice: { voiceURI: '', rate: 1, lang: 'en-US', speakQuestions: false, fixNames: true },
  // Optional escape hatch for machines that can't run a model. Off by default —
  // the whole point of Inkwell is that it doesn't need this.
  cloud: { enabled: false, service: 'openai', baseUrl: '', apiKey: '' },
};

// The key stays on this machine. The browser is told whether one is set, never
// what it is, so it can't leak through a screenshot or a shared LAN session.
export const KEY_MASK = '__saved__';
export function redactSettings(s) {
  return { ...s, cloud: { ...s.cloud, apiKey: s.cloud.apiKey ? KEY_MASK : '' } };
}

export async function getSettings() {
  const s = await readJson(SETTINGS_PATH, {});
  return {
    ...DEFAULT_SETTINGS, ...s,
    generation: { ...DEFAULT_SETTINGS.generation, ...(s.generation || {}) },
    context: { ...DEFAULT_SETTINGS.context, ...(s.context || {}) },
    editor: { ...DEFAULT_SETTINGS.editor, ...(s.editor || {}) },
    voice: { ...DEFAULT_SETTINGS.voice, ...(s.voice || {}) },
    cloud: { ...DEFAULT_SETTINGS.cloud, ...(s.cloud || {}) },
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const cloud = { ...DEFAULT_SETTINGS.cloud, ...(patch.cloud || {}) };
  // The client sends the mask back when the key was left untouched.
  if (!patch.cloud || patch.cloud.apiKey === KEY_MASK || patch.cloud.apiKey === undefined) {
    cloud.apiKey = current.cloud.apiKey;
  }
  const next = {
    ...DEFAULT_SETTINGS, ...patch,
    generation: { ...DEFAULT_SETTINGS.generation, ...(patch.generation || {}) },
    context: { ...DEFAULT_SETTINGS.context, ...(patch.context || {}) },
    editor: { ...DEFAULT_SETTINGS.editor, ...(patch.editor || {}) },
    voice: { ...DEFAULT_SETTINGS.voice, ...(patch.voice || {}) },
    cloud,
  };
  await writeJson(SETTINGS_PATH, next);
  return next;
}

export { id };
