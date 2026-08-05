// Inkwell frontend. Vanilla ES modules — no build step, works offline.

import { initPageView, renderPages, syncPageView } from './pageview.js';
import * as voice from './voice.js';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const els = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wc = (t) => (t && t.trim() ? t.trim().split(/\s+/).length : 0);
// Models sometimes echo a "3. " / "Chapter 3: " prefix into the title when they
// see a numbered list. Strip it so titles stay clean and prose-matching works.
const cleanTitle = (t) => String(t ?? '').replace(/^\s*(?:chapter\s+)?\d+\s*[.:)–—-]\s*/i, '').trim() || 'Untitled';
const nf = (n) => n.toLocaleString();
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

let toastT;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), kind === 'err' ? 5000 : 2400);
}

// Turn a raw API/Ollama failure into something the writer can act on. The most
// common real-world cause is a selected model that isn't actually installed,
// which Ollama reports as a 404 — that used to surface only as a red 500 in the
// console with no guidance.
function friendlyError(err) {
  const msg = String(err?.message || err || '');
  const notFound = msg.match(/model ['"]?([\w.:\/-]+)['"]? not found/i);
  if (notFound) {
    const m = notFound[1];
    return {
      kind: 'model-missing', model: m,
      html: `The model <b>${esc(m)}</b> isn't installed in Ollama.
        Pick an installed model in the top-right, or pull it:
        <div class="fixrow"><code>ollama pull ${esc(m)}</code></div>`,
    };
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return { kind: 'offline', html: `Can't reach the Inkwell server. Is <code>npm start</code> still running?` };
  }
  if (/ECONNREFUSED|11434|not reachable|ollama/i.test(msg)) {
    return { kind: 'ollama', html: `Ollama isn't responding. Start it, then click Retry.` };
  }
  return { kind: 'generic', html: esc(msg || 'Something went wrong.') };
}

function showPlanError(elId, err, onRetry) {
  const box = $(elId);
  const f = friendlyError(err);
  box.innerHTML = f.html + `<div class="fixrow"><button class="btn ghost sm" data-retry>Retry</button>
    ${f.kind === 'model-missing' ? '<button class="btn ghost sm" data-refresh>Refresh model list</button>' : ''}</div>`;
  box.hidden = false;
  box.querySelector('[data-retry]')?.addEventListener('click', () => { box.hidden = true; onRetry?.(); });
  box.querySelector('[data-refresh]')?.addEventListener('click', async () => { await refreshProvider(); toast('Model list refreshed — pick one in the top bar.'); });
}
const clearPlanError = (elId) => { const b = $(elId); if (b) b.hidden = true; };

// Is the model the app will actually send installed right now?
function modelInstalled(name) { return state.models.some((m) => m.name === name); }

const ACT_COLORS = ['violet', 'teal', 'green', 'gold'];

// ---------- state ----------
const state = {
  model: localStorage.getItem('inkwell.model') || '',
  books: [], book: null, chapterId: null,
  view: 'home', mapMode: 'map',
  revision: null, lastSuggestion: null, refine: null,
  settings: null, models: [],
};

const chapters = () => state.book?.outline.chapters || [];
const acts = () => state.book?.outline.acts || [];
const currentChapter = () => chapters().find((c) => c.id === state.chapterId) || null;

// ============================================================
//  BOOT
// ============================================================
async function boot() {
  // Any stray async failure becomes a visible toast instead of a silent red
  // line in the console.
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled:', e.reason);
    toast(friendlyError(e.reason).html.replace(/<[^>]+>/g, ''), 'err');
  });
  wire();
  await loadSettings();
  await initPageView({
    api,
    toast,
    book: () => state.book,
    chapterId: () => state.chapterId,
    setChapter: (id) => { state.chapterId = id; renderChapterRail(); },
    model: () => state.model,
    view: () => state.view,
  });
  await initVoice();
  await refreshProvider();
  await loadLibrary();
  const last = localStorage.getItem('inkwell.lastBook');
  if (last && state.books.some((b) => b.id === last)) await openBook(last);
  else go('home');
}

// A cloud model is anything the server prefixed. Kept as a helper so the
// distinction is visible everywhere it matters.
const isCloud = (name) => typeof name === 'string' && name.startsWith('cloud:');
const modelLabel = (m) => (isCloud(m.name) ? m.name.slice(6) : m.name);

async function refreshProvider() {
  try {
    const h = await api('/health');
    state.health = h;
    const dot = $('health');
    const anyCloud = h.cloud?.enabled && h.cloud.ok;
    dot.className = 'health ' + (h.ollama ? 'ok' : anyCloud ? 'cloud' : 'bad');
    dot.title = h.ollama
      ? `Ollama connected (${h.host})`
      : anyCloud ? `Ollama not running — cloud (${h.cloud.service}) is available`
        : `Ollama not reachable at ${h.host}`;
    if (!h.ollama && !anyCloud) toast('Ollama not running — start it, then reload.', 'err');
  } catch {}
  try {
    const { models, errors } = await api('/models');
    state.models = models;

    // Group the picker so it's always obvious which model costs money.
    const group = (where, label) => {
      const list = models.filter((m) => (where === 'cloud' ? isCloud(m.name) : !isCloud(m.name)));
      if (!list.length) return '';
      return `<optgroup label="${label}">` +
        list.map((m) => `<option value="${esc(m.name)}">${esc(modelLabel(m))}</option>`).join('') +
        '</optgroup>';
    };
    const opts = group('local', 'On your machine') + group('cloud', 'Cloud · billed per word');
    $('modelSelect').innerHTML = opts;
    $('set-model').innerHTML = opts;

    // Prefer the saved default, then whatever this browser last used, and only
    // fall back to a cloud model if there's nothing local.
    const preferred = state.settings?.defaultModel || state.model;
    if (!models.find((m) => m.name === preferred)) {
      state.model = (models.find((m) => !isCloud(m.name)) || models[0])?.name || '';
    } else state.model = preferred;
    $('modelSelect').value = state.model;
    $('set-model').value = state.model;

    if (errors?.cloud) toast('Cloud provider: ' + errors.cloud, 'err');
  } catch (e) { toast('Could not list models: ' + e.message, 'err'); }
}

// ============================================================
//  SETTINGS
// ============================================================
async function loadSettings() {
  try { state.settings = await api('/settings'); }
  catch { state.settings = null; }
  applySettings();
}

// Editor preferences are pure CSS custom properties.
function applySettings() {
  const e = state.settings?.editor;
  if (!e) return;
  const r = document.documentElement.style;
  r.setProperty('--ed-size', e.fontSize + 'px');
  r.setProperty('--ed-lh', e.lineHeight);
  r.setProperty('--ed-measure', e.measure);
  $('editor').spellcheck = !!e.spellcheck;
}

const SET_FIELDS = [
  ['set-temp', 'out-temp', 'generation', 'temperature', (v) => (+v).toFixed(2)],
  ['set-topp', 'out-topp', 'generation', 'top_p', (v) => (+v).toFixed(2)],
  ['set-rep', 'out-rep', 'generation', 'repeat_penalty', (v) => (+v).toFixed(2)],
  ['set-ctx', 'out-ctx', 'generation', 'num_ctx', (v) => nf(+v)],
  ['set-pred', 'out-pred', 'generation', 'num_predict', (v) => nf(+v)],
  ['set-local', 'out-local', 'context', 'localWords', (v) => nf(+v)],
  ['set-fs', 'out-fs', 'editor', 'fontSize', (v) => v + 'px'],
  ['set-lh', 'out-lh', 'editor', 'lineHeight', (v) => (+v).toFixed(2)],
  ['set-measure', 'out-measure', 'editor', 'measure', (v) => v + 'ch'],
];

function openSettings() {
  const s = state.settings;
  if (!s) return toast('Settings unavailable.', 'err');
  for (const [input, output, group, key, fmt] of SET_FIELDS) {
    $(input).value = s[group][key];
    $(output).textContent = fmt(s[group][key]);
  }
  $('set-bible').checked = s.context.includeBible;
  $('set-summary').checked = s.context.includeSummary;
  $('set-autosummary').checked = s.context.autoSummary;
  $('set-spell').checked = s.editor.spellcheck;
  $('set-model').value = s.defaultModel || state.model;
  renderCloudSettings();
  renderVoiceSettings();
  renderConn();
  $('settingsModal').hidden = false;
}

async function renderVoiceSettings() {
  const v = vset();
  $('set-speak-questions').checked = !!v.speakQuestions;
  $('set-fix-names').checked = v.fixNames !== false;
  $('set-rate').value = v.rate ?? 1;
  $('out-rate').textContent = (+(v.rate ?? 1)).toFixed(2) + '×';

  const voices = await voice.localVoices();
  const sel = $('set-voice');
  sel.innerHTML = voices.length
    ? voices.map((x) => `<option value="${esc(x.voiceURI)}">${esc(x.name)} — ${esc(x.lang)}</option>`).join('')
    : '<option value="">No on-device voices found</option>';
  sel.value = v.voiceURI || voices[0]?.voiceURI || '';
  sel.disabled = !voices.length;

  const st = state.listen;
  $('voiceStatus').innerHTML = voices.length
    ? `Reading: <span class="ok">● ${voices.length} on-device voice${voices.length === 1 ? '' : 's'}</span><br>
       Dictation: ${st === 'ready'
        ? '<span class="ok">● on-device, ready</span>'
        : `<span class="bad">● unavailable</span> — ${esc(LISTEN_MESSAGE[st] || '')}`}`
    : 'No on-device voices are installed. Your operating system\'s accessibility settings can add some.';
}

async function renderConn() {
  try {
    const h = await api('/health');
    const local = state.models.filter((m) => !isCloud(m.name)).length;
    $('connInfo').innerHTML = `Host <b>${esc(h.host)}</b><br>
      Status <span class="${h.ollama ? 'ok' : 'bad'}">${h.ollama ? '● connected' : '● not reachable'}</span><br>
      Models installed <b>${local}</b>` +
      (h.ollama ? '' : `<br><span class="submeta">Start Ollama, then hit refresh. Nothing here costs anything.</span>`);
    if (h.cloud?.enabled) {
      $('cloudHint').innerHTML = h.cloud.ok
        ? `<span class="ok">● key accepted</span> — cloud models appear in the picker under “Cloud”.`
        : `<span class="bad">● the provider rejected that key</span> — check it and the base URL.`;
    } else {
      $('cloudHint').textContent = '';
    }
  } catch {
    $('connInfo').textContent = 'Could not reach the Inkwell server.';
  }
}

// Cloud config lives entirely in the settings modal; local needs no setup.
async function renderCloudSettings() {
  const s = state.settings;
  if (!state.cloudServices) {
    try { state.cloudServices = (await api('/cloud/services')).services; }
    catch { state.cloudServices = []; }
  }
  const sel = $('set-cloud-service');
  sel.innerHTML = state.cloudServices
    .map((x) => `<option value="${esc(x.id)}" title="${esc(x.hint)}">${esc(x.label)}</option>`).join('');
  sel.value = s.cloud?.service || 'openai';
  $('set-cloud-enabled').checked = !!s.cloud?.enabled;
  $('set-cloud-base').value = s.cloud?.baseUrl || '';
  $('set-cloud-base').placeholder = state.cloudServices.find((x) => x.id === sel.value)?.defaultBaseUrl || '';
  // The server sends a mask, never the key itself.
  $('set-cloud-key').value = s.cloud?.apiKey || '';
  $('cloudBox').hidden = !s.cloud?.enabled;
}

function collectSettings() {
  const s = JSON.parse(JSON.stringify(state.settings));
  for (const [input, , group, key] of SET_FIELDS) s[group][key] = +$(input).value;
  s.context.includeBible = $('set-bible').checked;
  s.context.includeSummary = $('set-summary').checked;
  s.context.autoSummary = $('set-autosummary').checked;
  s.editor.spellcheck = $('set-spell').checked;
  s.defaultModel = $('set-model').value;
  s.voice = {
    ...s.voice,
    voiceURI: $('set-voice').value,
    rate: +$('set-rate').value,
    speakQuestions: $('set-speak-questions').checked,
    fixNames: $('set-fix-names').checked,
  };
  s.cloud = {
    enabled: $('set-cloud-enabled').checked,
    service: $('set-cloud-service').value,
    baseUrl: $('set-cloud-base').value.trim(),
    // Unchanged means the masked value goes back; the server keeps what it has.
    apiKey: $('set-cloud-key').value,
  };
  return s;
}

async function saveSettings() {
  state.settings = await api('/settings', { method: 'PUT', body: collectSettings() });
  state.model = state.settings.defaultModel || state.model;
  applySettings();
  // Cloud config changes the model list, so rebuild it before closing.
  await refreshProvider();
  $('modelSelect').value = state.model;
  $('settingsModal').hidden = true;
  toast('Settings saved.', 'ok');
}

async function resetSettings() {
  if (!confirm('Reset all settings to their defaults?')) return;
  state.settings = await api('/settings/reset', { method: 'POST' });
  applySettings();
  openSettings();
  toast('Settings reset to defaults.', 'ok');
}

// ============================================================
//  VOICE
// ============================================================
// Everything here is on-device. Dictation refuses to run rather than fall back
// to a browser's server-side recogniser — see public/voice.js for why.
// Defaults merged here too: an older settings.json, or a settings fetch that
// failed, shouldn't quietly turn features off while the UI says they're on.
const VOICE_DEFAULTS = { voiceURI: '', rate: 1, lang: 'en-US', speakQuestions: false, fixNames: true };
const vset = () => ({ ...VOICE_DEFAULTS, ...(state.settings?.voice || {}) });

async function initVoice() {
  // Reading aloud works nearly everywhere; dictation is the fussy half.
  $('readAloudBtn').hidden = !voice.canSpeak();
  $('speakQBtn').hidden = !voice.canSpeak();

  state.listen = await voice.listenAvailability(vset().lang || 'en-US');
  // Surfaced for diagnostics: "why is the mic button missing?" should be
  // answerable without a debugger.
  window.__listenState = state.listen;
  renderMicState();
}

const LISTEN_MESSAGE = {
  ready: '',
  downloadable: 'One-time download needed for on-device speech.',
  downloading: 'Downloading the speech model…',
  'no-local': 'This browser can only transcribe on a server, so Inkwell won\'t use it. Chrome or Edge can do it on-device.',
  unsupported: 'This browser has no speech recognition. Chrome or Edge can transcribe on-device.',
};

function renderMicState() {
  const btn = $('micBtn');
  const note = $('voiceNote');
  if (!btn) return;
  const st = state.listen;
  btn.hidden = st === 'unsupported' || st === 'no-local';
  note.textContent = st === 'ready' ? '' : (LISTEN_MESSAGE[st] || '');
  note.className = 'voicenote' + (st === 'ready' ? '' : ' warn');

  if (st === 'downloadable') {
    btn.hidden = false;
    $('micLabel').textContent = 'Enable speech';
    btn.classList.remove('on');
  } else if (st === 'downloading') {
    btn.hidden = false;
    btn.disabled = true;
    $('micLabel').textContent = 'Downloading…';
  } else {
    btn.disabled = false;
    $('micLabel').textContent = voice.isListening() ? 'Stop' : 'Speak';
    btn.classList.toggle('on', voice.isListening());
  }
}

let dictationBase = '';

async function toggleMic() {
  if (voice.isListening()) { voice.stopListening(); return; }

  if (state.listen === 'downloadable') {
    state.listen = 'downloading';
    renderMicState();
    const ok = await voice.installLocalRecognition(vset().lang || 'en-US');
    state.listen = ok ? 'ready' : 'no-local';
    renderMicState();
    if (!ok) toast('Could not install on-device speech.', 'err');
    return;
  }
  if (state.listen !== 'ready') return;

  const box = $('answerInput');
  dictationBase = box.value ? box.value.replace(/\s*$/, ' ') : '';
  $('nameFixes').hidden = true;

  const ok = await voice.startListening({
    lang: vset().lang || 'en-US',
    onInterim: (t) => { box.value = dictationBase + t; },
    onFinal: (t) => { box.value = dictationBase + t; },
    onEnd: (t) => {
      box.value = applyNameFixes(dictationBase + t);
      box.focus();
      renderMicState();
    },
    onError: (e) => {
      toast(LISTEN_MESSAGE[e] || ('Dictation stopped: ' + e), 'err');
      renderMicState();
    },
  });
  if (ok) renderMicState();
}

// Put the book's proper nouns right, and show what changed so a wrong guess is
// visible rather than silently baked into the answer.
function applyNameFixes(text) {
  if (!vset().fixNames || !state.book) return text;
  const names = voice.bibleNames(state.book.bible || {});
  window.__names = names;
  const { text: fixed, fixes } = voice.correctNames(text, names);
  const box = $('nameFixes');
  if (fixes.length) {
    box.innerHTML = `Corrected from your story bible: ` +
      fixes.map((f) => `<b>${esc(f.from)} → ${esc(f.to)}</b>`).join(', ') +
      ` <button class="linkbtn" id="undoNames">undo</button>`;
    box.hidden = false;
    $('undoNames').onclick = () => { $('answerInput').value = text; box.hidden = true; };
  } else {
    box.hidden = true;
  }
  return fixed;
}

function speakText(text) {
  if (!text?.trim()) return;
  voice.speak(text, { voiceURI: vset().voiceURI, rate: vset().rate ?? 1 });
}

// Read the chapter — or just the selection — aloud, moving the editor's own
// selection along with it so you can see where you are.
function readAloud() {
  const ed = $('editor');
  if (voice.isSpeaking()) { voice.stopSpeaking(); $('readAloudBtn').textContent = '🔊 Read this aloud'; return; }

  const from = ed.selectionStart, to = ed.selectionEnd;
  const whole = ed.value;
  const hasSel = to > from;
  const text = hasSel ? whole.slice(from, to) : whole;
  const offset = hasSel ? from : 0;
  if (!text.trim()) return toast('Nothing to read yet.', 'err');

  $('readAloudBtn').textContent = '■ Stop reading';
  ed.focus();
  voice.speak(text, {
    voiceURI: vset().voiceURI,
    rate: vset().rate ?? 1,
    onChunk: (c) => ed.setSelectionRange(offset + c.start, offset + c.end),
    onEnd: () => { $('readAloudBtn').textContent = '🔊 Read this aloud'; ed.setSelectionRange(from, hasSel ? to : from); },
    onStop: () => { $('readAloudBtn').textContent = '🔊 Read this aloud'; },
    onError: (e) => { toast('Could not read aloud: ' + e, 'err'); },
  });
}

// ============================================================
//  ROUTER
// ============================================================
function go(view) {
  if (view !== 'home' && !state.book) view = 'home';
  // Leaving the editor is the natural moment to update the book's memory.
  if (state.view === 'write' && view !== 'write') foldOnLeave(state.chapterId);
  state.view = view;
  els('.view').forEach((v) => (v.hidden = true));
  $('view-' + view).hidden = false;
  els('.railbtn').forEach((b) => b.classList.toggle('on', b.dataset.nav === view));
  els('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.seg === view));

  const hasBook = !!state.book;
  $('workspace').className = 'workspace' + (hasBook ? (view === 'outline' ? '' : ' nocontext') : ' solo');
  $('sidebar').hidden = !hasBook;
  $('context').hidden = !hasBook || view !== 'outline';
  $('seg').hidden = !hasBook;
  $('bookTitleInput').hidden = !hasBook;
  $('exportBtn').hidden = !hasBook;
  // Mobile chrome: the interview drawer only exists on the outline, and the AI
  // panel only on the writing view.
  $('ctxBtn').hidden = !hasBook || view !== 'outline';
  $('aiFab').hidden = !hasBook || view !== 'write';
  closeDrawers();

  if (view === 'home') renderLibrary();
  if (view === 'outline') renderOutline();
  if (view === 'write') renderWrite();
  if (view === 'bible') renderBible();
  if (view === 'notes') $('notesPad').value = state.book?.notes || '';
  if (view === 'cards') renderCards();
  if (view === 'pages') renderPages({ rebuild: true });
  if (view === 'export') renderExport();
}

// ---------- mobile drawers ----------
// On a phone the sidebar, the interview panel and the AI panel slide in over
// the canvas instead of sitting beside it.
function openDrawer(which) {
  const el = $(which);
  const already = el.classList.contains('open');
  closeDrawers();
  if (already) return;
  el.hidden = false;
  el.classList.add('open');
  document.body.classList.add('drawered');
  $('scrim').hidden = false;
}

function closeDrawers() {
  ['sidebar', 'context'].forEach((id) => $(id).classList.remove('open'));
  document.querySelector('.aipanel')?.classList.remove('open');
  document.body.classList.remove('drawered');
  $('scrim').hidden = true;
}

// ============================================================
//  LIBRARY / BOOK
// ============================================================
async function loadLibrary() {
  const { books } = await api('/books');
  state.books = books;
  renderSidebarBooks();
  renderLibrary();
}

function renderLibrary() {
  const l = $('libList');
  l.innerHTML = state.books.length
    ? state.books.map((b) => `<div class="libcard" data-open="${b.id}">
        <div><h4>${esc(b.title || 'Untitled')}</h4>
        <div class="m">${esc(b.author || 'Unknown')} · ${b.chapterCount || 0} chapters · edited ${new Date(b.updatedAt).toLocaleDateString()}</div></div>
        <button class="iconbtn del" data-del="${b.id}" title="Delete">🗑</button></div>`).join('')
    : '<div class="empty">No books yet. Create one to the right →</div>';
}

function renderSidebarBooks() {
  $('bookList').innerHTML = state.books.map((b) => `
    <div class="bookrow ${state.book?.meta.id === b.id ? 'on' : ''}" data-open="${b.id}">
      <svg viewBox="0 0 24 24"><path d="M4 4h7a2 2 0 012 2v14a2 2 0 00-2-2H4z"/><path d="M20 4h-7a2 2 0 00-2 2v14a2 2 0 012-2h7z"/></svg>
      <div><div class="bt">${esc(b.title || 'Untitled')}</div><div class="bm">${b.chapterCount || 0} chapters</div></div>
    </div>`).join('');
}

async function openBook(id) {
  state.book = await api('/books/' + id);
  localStorage.setItem('inkwell.lastBook', id);
  state.chapterId = chapters()[0]?.id || null;
  $('bookTitleInput').value = state.book.meta.title || '';
  syncPageView();
  renderSidebarBooks();
  renderChapterRail();
  renderQuote();
  renderContext();
  go('outline');
}

function renderQuote() {
  const b = state.book;
  const line = b.bible?.tone || b.meta.premise;
  $('quoteCard').hidden = !line;
  if (!line) return;
  $('quoteText').textContent = '“' + line + '”';
  $('quoteAttr').textContent = '— ' + (b.meta.title || 'Untitled');
}

function renderChapterRail() {
  $('chapterList').innerHTML = chapters().map((c, i) => {
    const w = wc(c.content);
    const cls = w > 400 ? 'written' : w > 0 ? 'draft' : '';
    return `<div class="chaprow ${c.id === state.chapterId ? 'on' : ''}" data-ch="${c.id}">
      <div class="ct"><span class="dot ${cls}"></span>${i + 1}. ${esc(c.title || 'Untitled')}</div>
      <div class="cw">${nf(w)} words</div></div>`;
  }).join('');
}

// ============================================================
//  OUTLINE — act bar, map, list, stats
// ============================================================
const CARD_W = 200, CARD_H = 96, GAP_X = 46, GAP_Y = 42, COLS = 3;

function autoLayout() {
  chapters().forEach((c, i) => {
    c.x = (i % COLS) * (CARD_W + GAP_X);
    c.y = Math.floor(i / COLS) * (CARD_H + GAP_Y);
  });
}

function actColor(actId) {
  const i = acts().findIndex((a) => a.id === actId);
  return ACT_COLORS[(i < 0 ? 0 : i) % 4];
}

function renderOutline() {
  const chs = chapters();
  $('outlineMeta').textContent = chs.length
    ? `${chs.length} chapters · ${acts().length} acts`
    : 'No chapters yet';
  $('emptyOutline').hidden = chs.length > 0;
  $('mapWrap').hidden = !chs.length || state.mapMode !== 'map';
  $('listWrap').hidden = !chs.length || state.mapMode !== 'list';
  $('stats').hidden = !chs.length;
  $('actBar').hidden = !chs.length;
  $('rebuildBtn').hidden = !chs.length;
  $('refineBtn').hidden = !chs.length;

  // Sync indicator: has the interview moved ahead of the outline?
  const built = state.book.meta.outlineBuiltAnswers ?? 0;
  const nowAnswers = transcriptPairs().length;
  const behind = nowAnswers - built;
  const sync = $('syncBar');
  if (chs.length && behind > 0) {
    sync.innerHTML = `<span class="st">You've answered <b>${behind} more question${behind === 1 ? '' : 's'}</b> since this outline was built. Rebuild to fold ${behind === 1 ? 'it' : 'them'} into your structure and bible.</span>
      <button class="btn primary sm" id="syncRebuildBtn">↻ Rebuild now</button>`;
    sync.hidden = false;
    $('syncRebuildBtn').onclick = () => buildOutline({ rebuild: true, btn: $('rebuildBtn') });
  } else {
    sync.hidden = true;
  }

  if (!chs.length) { $('actBar').innerHTML = ''; $('stats').innerHTML = ''; return; }

  // act bar
  const bar = $('actBar');
  bar.style.gridTemplateColumns = `repeat(${acts().length}, 1fr)`;
  bar.innerHTML = acts().map((a, i) => `<div class="act" data-c="${ACT_COLORS[i % 4]}">
      <div class="an">Act ${['I','II','III','IV','V','VI'][i] || i + 1}</div>
      <div class="at">${esc(a.subtitle || a.title || '')}</div>
      <div class="ab"></div></div>`).join('');

  if (chs.some((c) => c.x == null || c.y == null)) autoLayout();
  state.mapMode === 'map' ? renderMap() : renderList();
  renderStats();
}

function renderMap() {
  const chs = chapters();
  const maxX = Math.max(...chs.map((c) => c.x)) + CARD_W;
  const maxY = Math.max(...chs.map((c) => c.y)) + CARD_H;
  const wrap = $('mapWrap');
  wrap.style.height = maxY + 20 + 'px';
  wrap.style.width = maxX + 20 + 'px';

  $('nodes').innerHTML = chs.map((c, i) => {
    const w = wc(c.content);
    const st = w > 400 ? 'written' : w > 0 ? 'draft' : '';
    return `<div class="node ${c.id === state.chapterId ? 'on' : ''}" data-c="${actColor(c.actId)}" data-node="${c.id}"
        style="left:${c.x}px;top:${c.y}px">
        ${st ? `<span class="status ${st}"></span>` : ''}
        <div class="nn">${i + 1}</div>
        <div class="nt">${esc(c.title || 'Untitled')}</div>
        <div class="nw"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>${nf(w)}</div>
      </div>`;
  }).join('');

  // wires between consecutive chapters
  const svg = $('wires');
  let d = `<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 1l6 3-6 3z" fill="#39405a"/></marker></defs>`;
  for (let i = 0; i < chs.length - 1; i++) {
    const a = chs[i], b = chs[i + 1];
    const sameRow = Math.abs(a.y - b.y) < 4 && b.x > a.x;
    if (sameRow) {
      const y = a.y + CARD_H / 2;
      d += `<path d="M${a.x + CARD_W} ${y} L${b.x - 6} ${y}" marker-end="url(#ah)"/>`;
    } else {
      const ax = a.x + CARD_W / 2, ay = a.y + CARD_H;
      const bx = b.x + CARD_W / 2, by = b.y;
      d += `<path class="soft" d="M${ax} ${ay} C${ax} ${ay + 34}, ${bx} ${by - 34}, ${bx} ${by - 4}"/>`;
    }
  }
  svg.innerHTML = d;
  svg.setAttribute('viewBox', `0 0 ${maxX + 20} ${maxY + 20}`);
  svg.style.width = maxX + 20 + 'px';
  svg.style.height = maxY + 20 + 'px';
}

function renderList() {
  $('listWrap').innerHTML = chapters().map((c, i) => `
    <div class="lrow" data-node="${c.id}">
      <div class="ln">${i + 1}</div>
      <div style="flex:1">
        <div class="lt">${esc(c.title || 'Untitled')}</div>
        ${c.summary ? `<div class="ls">${esc(c.summary)}</div>` : ''}
        ${c.beats?.length ? `<div class="lb">${c.beats.map((b) => `<b>•</b>${esc(b)}`).join('<br/>')}</div>` : ''}
      </div>
      <div class="lw">${nf(wc(c.content))} words</div>
    </div>`).join('');
}

function renderStats() {
  const chs = chapters();
  const words = chs.map((c) => wc(c.content));
  const total = words.reduce((a, b) => a + b, 0);
  const written = words.filter((w) => w > 0);
  const avg = written.length ? Math.round(total / written.length) : 0;
  // Pacing: how evenly the written chapters are sized.
  let pace = '—';
  if (written.length >= 2) {
    const mean = total / written.length;
    const sd = Math.sqrt(written.reduce((s, w) => s + (w - mean) ** 2, 0) / written.length);
    pace = sd / mean < 0.35 ? 'Balanced' : sd / mean < 0.6 ? 'Varied' : 'Uneven';
  }
  $('stats').innerHTML = `
    <div class="stat"><div class="v">${nf(total)}</div><div class="k">Total words</div></div>
    <div class="stat"><div class="v">${chs.length}</div><div class="k">Chapters</div></div>
    <div class="stat"><div class="v">${acts().length}</div><div class="k">Acts</div></div>
    <div class="stat"><div class="v">${avg ? '~' + nf(avg) : '—'}</div><div class="k">Avg. words / chapter</div></div>
    <div class="stat pace"><div class="v">${pace}</div><div class="k">Pacing</div></div>`;
}

const saveOutlineDebounced = debounce(async () => {
  await api(`/books/${state.book.meta.id}/outline`, {
    method: 'PUT',
    body: { acts: acts(), chapters: chapters().map(stripContent) },
  });
}, 700);

function stripContent(c) { const { content, ...rest } = c; return rest; }

// ---------- node dragging ----------
// Pointer events, so a chapter card can be dragged with a mouse, a finger or a
// stylus. `touch-action: none` on the nodes keeps the browser from stealing the
// gesture for scrolling.
function initDrag() {
  let drag = null;
  $('nodes').addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const node = e.target.closest('[data-node]');
    if (!node) return;
    const ch = chapters().find((c) => c.id === node.dataset.node);
    if (!ch) return;
    drag = { node, ch, id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: ch.x, oy: ch.y, moved: false };
    node.classList.add('dragging');
    node.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  $('nodes').addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    drag.ch.x = Math.max(0, drag.ox + dx);
    drag.ch.y = Math.max(0, drag.oy + dy);
    drag.node.style.left = drag.ch.x + 'px';
    drag.node.style.top = drag.ch.y + 'px';
  });
  const end = (e) => {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
    drag.node.classList.remove('dragging');
    drag.node.releasePointerCapture?.(drag.id);
    if (drag.moved) { renderMap(); saveOutlineDebounced(); }
    else { state.chapterId = drag.ch.id; renderChapterRail(); go('write'); }
    drag = null;
  };
  $('nodes').addEventListener('pointerup', end);
  $('nodes').addEventListener('pointercancel', end);
}

// ============================================================
//  INTERVIEW (context panel)
// ============================================================
// The question currently waiting for an answer, if any.
function pendingQuestion() {
  const msgs = state.book?.plan?.messages || [];
  const last = msgs.at(-1);
  return last?.role === 'assistant' ? last.content : '';
}

function transcriptPairs() {
  const msgs = state.book?.plan?.messages || [];
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant' && msgs[i + 1]?.role === 'user') {
      out.push({ question: msgs[i].content, answer: msgs[i + 1].content });
    }
  }
  return out;
}

function renderContext() {
  if (!state.book) return;
  const plan = state.book.plan || { messages: [], suggested: null };
  const msgs = plan.messages || [];

  $('transcript').innerHTML = msgs.length
    ? msgs.map((m) => `<div class="bub ${m.role === 'user' ? 'me' : 'ai'}">${esc(m.content)}</div>`).join('')
    : '<div class="bub ai">Tell me about your book and I\'ll help you find its shape. I\'ll ask one question at a time.</div>';
  $('transcript').scrollTop = $('transcript').scrollHeight;

  const pending = msgs.length > 0 && msgs.at(-1).role === 'assistant';
  $('answerBox').hidden = !pending;
  $('speakQBtn').hidden = !pending || !voice.canSpeak();

  // Read a newly-arrived question aloud, once, if you've asked for that.
  const q = pendingQuestion();
  if (pending && q && vset().speakQuestions && q !== state.spokenQuestion) {
    state.spokenQuestion = q;
    speakText(q);
  }
  if (pending) renderMicState();
  $('suggestQ').hidden = pending || !plan.suggested?.question;
  if (plan.suggested?.question) $('sqText').textContent = plan.suggested.question;
  const showStart = !pending && !plan.suggested?.question;
  $('startInterviewBtn').hidden = !showStart;
  $('startInterviewBtn').textContent = msgs.length ? 'Ask another question' : 'Start the interview';

  renderMemory();
  renderBiblePeek();
}

function renderMemory() {
  const b = state.book.bible || {};
  const rows = [
    ['Characters', (b.characters || []).length, '#7b6cf6'],
    ['Locations', (b.locations || []).length, '#e5757b'],
    ['Themes', (b.themes || []).length, '#46c5bd'],
    ['Timeline events', (b.timeline || []).length, '#e0a94d'],
  ];
  $('memList').innerHTML = rows.map(([k, v, c]) =>
    `<div class="memrow"><span class="mi" style="background:${c}22;color:${c}">◆</span>
     <span class="mk">${k}</span><span class="mv">${v}</span></div>`).join('');

  // Say something true about the running summary rather than "just now".
  const { written, folded } = memoryCoverage();
  setMemoryStatus(
    !written ? 'nothing written yet'
      : folded >= written ? `${written} chapter${written === 1 ? '' : 's'} folded in`
        : `${folded}/${written} chapters folded in`
  );
}

function renderBiblePeek() {
  const b = state.book.bible || {}, m = state.book.meta;
  const rows = [
    ['Premise', m.premise],
    ['Themes', (b.themes || []).join(', ')],
    ['Tone', b.tone],
    ['POV / Tense', `${m.pov} / ${m.tense}`],
  ].filter(([, v]) => v);
  $('biblePeek').innerHTML = rows.map(([k, v]) =>
    `<div class="bp"><div class="bpk">${k}</div><div class="bpv">${esc(v)}</div></div>`).join('');
}

const savePlan = () => api(`/books/${state.book.meta.id}/plan`, { method: 'PUT', body: state.book.plan });

async function askNext() {
  clearPlanError('interviewErr');
  if (!ensureModel('interviewErr', askNext)) return;
  const btn = $('startInterviewBtn');
  const wasHidden = btn.hidden;
  if (!wasHidden) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Thinking…'; }
  try {
    const m = state.book.meta;
    const data = await api('/plan/next-question', {
      method: 'POST',
      body: {
        model: state.model, premise: m.premise, genre: m.genre, pov: m.pov, tense: m.tense,
        transcript: state.book.plan.messages,
      },
    });
    if (!data.question) throw new Error('The model returned an empty question — try a more capable model.');
    state.book.plan.suggested = data;
    await savePlan();
    renderContext();
  } catch (e) {
    showPlanError('interviewErr', e, askNext);
  } finally {
    btn.disabled = false;
    btn.textContent = state.book.plan.messages.length ? 'Ask another question' : 'Start the interview';
  }
}

// Block a generation before it 500s if the chosen model isn't installed.
function ensureModel(errEl, retry) {
  if (state.model && modelInstalled(state.model)) return true;
  const first = state.models[0]?.name;
  if (!state.models.length) {
    showPlanError(errEl, new Error('Ollama isn\'t responding'), retry);
    return false;
  }
  // Auto-recover: fall back to the saved default if it's installed, else the
  // first available model, and tell the user what happened.
  showPlanError(errEl, new Error(`model '${state.model || 'none selected'}' not found`), retry);
  const fallback = modelInstalled(state.settings?.defaultModel) ? state.settings.defaultModel : first;
  if (fallback) {
    state.model = fallback; $('modelSelect').value = fallback;
    localStorage.setItem('inkwell.model', fallback);
  }
  return false;
}

async function askThis() {
  const q = state.book.plan.suggested?.question;
  if (!q) return;
  state.book.plan.messages.push({ role: 'assistant', content: q });
  state.book.plan.suggested = null;
  await savePlan();
  renderContext();
  $('answerInput').focus();
}

async function sendAnswer() {
  const v = $('answerInput').value.trim();
  if (!v) return;
  state.book.plan.messages.push({ role: 'user', content: v });
  $('answerInput').value = '';
  await savePlan();
  renderContext();
  askNext();
}

// ---------- build / rebuild the outline from the interview ----------
// Merge helper: union two bible lists by name, keeping the author's existing
// entries (and any edits) and adding only genuinely new ones.
function mergeByName(existing = [], generated = []) {
  const out = existing.map((e) => ({ ...e }));
  const have = new Set(out.map((e) => (e.name || '').trim().toLowerCase()).filter(Boolean));
  for (const g of generated) {
    const k = (g.name || '').trim().toLowerCase();
    if (k && !have.has(k)) { out.push(g); have.add(k); }
  }
  return out;
}

// Normalize raw model acts into Inkwell act objects (id + colour).
function actsFrom(rawActs) {
  return (rawActs?.length ? rawActs : [1, 2, 3, 4].map((n) => ({ n, title: `Act ${n}` })))
    .map((a, i) => ({ id: `act-${i + 1}`, title: `Act ${i + 1}`, subtitle: a.title || '', color: ACT_COLORS[i % 4] }));
}

// Turn raw model chapters into stored chapters, NEVER destroying prose: any
// existing chapter with writing keeps its id (so its .md file follows) by
// matching titles into the new structure, or is appended if it fell out.
function chaptersPreservingProse(newActs, rawChapters) {
  let newChs = (rawChapters || []).map((c) => ({
    title: cleanTitle(c.title), summary: c.summary, beats: c.beats || [],
    actId: newActs[Math.min(Math.max((c.act || 1) - 1, 0), newActs.length - 1)].id,
    x: null, y: null,
  }));
  const written = chapters().filter((c) => wc(c.content) > 0);
  const preservedIds = new Set();
  if (written.length) {
    newChs = newChs.map((nc) => {
      const w = written.find((x) => !preservedIds.has(x.id) && (x.title || '').trim().toLowerCase() === nc.title.trim().toLowerCase());
      if (w) { preservedIds.add(w.id); return { ...nc, id: w.id, title: w.title }; }
      return nc;
    });
    for (const w of written) {
      if (!preservedIds.has(w.id)) { newChs.push({ id: w.id, title: w.title, summary: w.summary || '', beats: w.beats || [], actId: newActs.at(-1).id, x: null, y: null }); preservedIds.add(w.id); }
    }
  }
  return { chapters: newChs, preservedIds };
}

// ============================================================
//  REFINE STRUCTURE (notes → revised outline, with preview)
// ============================================================
const REFINE_CHIPS = ['More chapters', 'Fewer chapters', 'Slower middle act', 'Tighten act one', 'Move the climax earlier', 'Add a subplot thread', 'More rising action', 'Add a denouement', 'Even out the pacing'];

function openRefine() {
  if (!chapters().length) return toast('Build an outline first, then refine it.', 'err');
  $('refineCompose').hidden = false;
  $('refinePreview').hidden = true;
  $('refineRun').hidden = false;
  $('refineAccept').hidden = true;
  $('refineBack').hidden = true;
  $('refineNotes').value = '';
  $('refineTarget').value = '';
  $('refineCurrent').textContent = `Currently ${chapters().length} chapters across ${acts().length} acts.`;
  $('refineChips').innerHTML = REFINE_CHIPS.map((c) => `<button class="chip" data-rchip="${esc(c)}">${esc(c)}</button>`).join('');
  state.refine = null;
  $('refineModal').hidden = false;
  $('refineNotes').focus();
}
const closeRefine = () => ($('refineModal').hidden = true);
function refineBackToNotes() {
  $('refineCompose').hidden = false; $('refinePreview').hidden = true;
  $('refineRun').hidden = false; $('refineAccept').hidden = true; $('refineBack').hidden = true;
}

async function runRefine() {
  const notes = $('refineNotes').value.trim();
  if (!notes) return toast('Add a note describing what to change.', 'err');
  if (!state.model || !modelInstalled(state.model)) return toast('Pick an installed model first (top-right).', 'err');
  const btn = $('refineRun');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Refining the structure…';
  const m = state.book.meta;
  try {
    const target = parseInt($('refineTarget').value, 10) || undefined;
    const data = await api('/plan/refine-outline', {
      method: 'POST',
      body: {
        model: state.model, premise: m.premise, genre: m.genre, pov: m.pov, tense: m.tense,
        synopsis: m.synopsis, answers: transcriptPairs(),
        currentOutline: { acts: acts(), chapters: chapters().map((c) => ({ title: c.title, summary: c.summary })) },
        notes, targetChapters: target,
      },
    });
    if (!data.chapters?.length) throw new Error('The model returned an empty structure — rephrase your notes, or try a more capable model.');
    const rawChapters = data.chapters.map((c) => ({ ...c, title: cleanTitle(c.title) }));
    state.refine = { notes, acts: actsFrom(data.acts), rawChapters };
    renderRefinePreview();
  } catch (e) {
    toast(friendlyError(e).html.replace(/<[^>]+>/g, ''), 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Refine structure →';
  }
}

function renderRefinePreview() {
  const r = state.refine;
  const oldChs = chapters();
  const oldTitles = oldChs.map((c) => (c.title || '').trim().toLowerCase());
  const newTitles = r.rawChapters.map((c) => (c.title || '').trim().toLowerCase());
  const writtenTitles = new Set(oldChs.filter((c) => wc(c.content) > 0).map((c) => (c.title || '').trim().toLowerCase()));

  $('refineOld').innerHTML = oldChs.map((c, i) => {
    const removed = !newTitles.includes((c.title || '').trim().toLowerCase());
    return `<div class="rd-item ${removed ? 'removed' : ''}"><span class="rn">${i + 1}</span><span class="rt">${esc(c.title || 'Untitled')}</span></div>`;
  }).join('');

  let html = '', curAct = -1;
  r.rawChapters.forEach((c, i) => {
    const actN = Math.min(Math.max(c.act || 1, 1), r.acts.length);
    if (actN !== curAct) { curAct = actN; html += `<div class="rd-act">${esc(r.acts[actN - 1]?.subtitle || 'Act ' + actN)}</div>`; }
    const t = (c.title || '').trim().toLowerCase();
    let cls = '';
    if (!oldTitles.includes(t)) cls = 'added';
    else if (writtenTitles.has(t)) cls = 'kept-written';
    else if (oldTitles.indexOf(t) !== i) cls = 'moved';
    html += `<div class="rd-item ${cls}"><span class="rn">${i + 1}</span><span class="rt">${esc(c.title || 'Untitled')}</span></div>`;
  });
  $('refineNew').innerHTML = html;

  $('rdOldCount').textContent = `(${oldChs.length})`;
  $('rdNewCount').textContent = `(${r.rawChapters.length})`;
  const delta = r.rawChapters.length - oldChs.length;
  const deltaTxt = delta > 0 ? `+${delta}` : delta === 0 ? 'same count' : `${delta}`;
  $('refineSummary').innerHTML = `Proposed: <b>${r.rawChapters.length} chapters · ${r.acts.length} acts</b> (${deltaTxt}). <span style="color:var(--green)">green = new</span>, <span style="color:var(--amber)">gold = moved</span>, <span style="color:var(--violet)">violet = your written chapters (kept)</span>.`;

  $('refineCompose').hidden = true;
  $('refinePreview').hidden = false;
  $('refineRun').hidden = true;
  $('refineAccept').hidden = false;
  $('refineBack').hidden = false;
}

async function acceptRefine() {
  const r = state.refine;
  if (!r) return;
  const btn = $('refineAccept');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Applying…';
  try {
    const { chapters: newChs, preservedIds } = chaptersPreservingProse(r.acts, r.rawChapters);
    const m = state.book.meta;
    await api(`/books/${m.id}/outline`, { method: 'PUT', body: { acts: r.acts, chapters: newChs } });
    state.book = await api('/books/' + m.id);
    if (!chapters().some((c) => c.id === state.chapterId)) state.chapterId = chapters()[0]?.id || null;
    autoLayout(); saveOutlineDebounced();
    renderChapterRail(); renderQuote(); renderOutline();
    await loadLibrary();
    closeRefine();
    const kept = preservedIds.size ? ` · kept ${preservedIds.size} written chapter${preservedIds.size === 1 ? '' : 's'}` : '';
    toast(`Structure updated — ${newChs.length} chapters${kept}.`, 'ok');
  } catch (e) {
    toast('Could not apply: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Accept new structure';
  }
}

async function buildOutline({ rebuild = false, btn = $('buildOutlineBtn') } = {}) {
  clearPlanError('outlineErr');
  const again = () => buildOutline({ rebuild, btn });
  if (!ensureModel('outlineErr', again)) return;

  const m = state.book.meta;
  const answers = transcriptPairs();
  if (!answers.length) {
    return showPlanError('outlineErr', new Error('Answer at least one interview question first — that\'s what the outline is built from.'), again);
  }

  // Rebuilding over existing work: confirm, and reassure about written prose.
  if (rebuild && chapters().length) {
    const writtenCount = chapters().filter((c) => wc(c.content) > 0).length;
    const msg = writtenCount
      ? `Rebuild the outline & bible from all ${answers.length} of your interview answers?\n\nThe ${writtenCount} chapter(s) you've already written will be KEPT (matched by title). The rest of the structure will be regenerated to include your latest answers. Your story bible will be added to, not overwritten.`
      : `Rebuild the outline & bible from all ${answers.length} of your interview answers?\n\nThis replaces the current ${chapters().length}-chapter outline with a fresh one that reflects everything you've said. You haven't written any prose yet, so nothing is lost.`;
    if (!confirm(msg)) return;
  }

  const setBtn = (t) => (btn.innerHTML = `<span class="spin"></span> ${t}`);
  const original = btn.textContent;
  btn.disabled = true;
  try {
    setBtn(rebuild ? 'Rebuilding the outline…' : 'Designing the outline…');
    const outline = await api('/plan/outline', {
      method: 'POST',
      body: { model: state.model, premise: m.premise, genre: m.genre, pov: m.pov, tense: m.tense, answers },
    });
    if (!outline.chapters?.length) {
      throw new Error('The model returned an empty outline. Try a more capable model (e.g. gemma4:e4b), or answer another interview question first.');
    }
    setBtn('Extracting the story bible…');
    const bibleGen = await api('/plan/bible', {
      method: 'POST',
      body: { model: state.model, premise: m.premise, genre: m.genre, answers, synopsis: outline.synopsis },
    });

    const newActs = actsFrom(outline.acts);
    const { chapters: newChs, preservedIds } = chaptersPreservingProse(newActs, outline.chapters);
    const preserved = preservedIds.size;

    const mergedBible = {
      ...state.book.bible,
      characters: mergeByName(state.book.bible.characters, bibleGen.characters),
      locations: mergeByName(state.book.bible.locations, bibleGen.locations),
      themes: [...new Set([...(state.book.bible.themes || []), ...(bibleGen.themes || [])])],
      tone: state.book.bible.tone || bibleGen.tone || '',
      styleGuide: state.book.bible.styleGuide || bibleGen.styleGuide || '',
    };

    await api(`/books/${m.id}/meta`, { method: 'PATCH', body: { synopsis: outline.synopsis || '', outlineBuiltAnswers: answers.length } });
    await api(`/books/${m.id}/outline`, { method: 'PUT', body: { acts: newActs, chapters: newChs } });
    await api(`/books/${m.id}/bible`, { method: 'PUT', body: mergedBible });

    state.book = await api('/books/' + m.id);
    state.chapterId = chapters()[0]?.id || null;
    autoLayout(); saveOutlineDebounced();
    renderChapterRail(); renderQuote(); renderContext(); renderOutline();
    await loadLibrary();
    const kept = preserved ? ` · kept ${preserved} written chapter${preserved === 1 ? '' : 's'}` : '';
    toast(`${rebuild ? 'Rebuilt' : 'Built'} ${outline.chapters.length} chapters across ${newActs.length} acts${kept}.`, 'ok');
  } catch (e) {
    showPlanError('outlineErr', e, again);
  } finally {
    btn.disabled = false; btn.textContent = original || 'Build outline & bible →';
  }
}

// ============================================================
//  WRITE
// ============================================================
function renderWrite() {
  if (!state.chapterId) state.chapterId = chapters()[0]?.id || null;
  const ch = currentChapter();
  renderChapterRail();
  if (!ch) { $('editor').value = ''; $('ed-chapter-title').value = ''; $('ed-chapter-summary').textContent = ''; return; }
  $('ed-chapter-title').value = ch.title || '';
  $('ed-chapter-summary').textContent = ch.summary || '';
  $('editor').value = ch.content || '';
  updateWordcount(); updateSelInfo();
}

function updateWordcount() { $('wordcount').textContent = nf(wc($('editor').value)) + ' words'; }

const saveChapterDebounced = debounce(async () => {
  const ch = currentChapter();
  if (!ch) return;
  ch.content = $('editor').value;
  ch.title = $('ed-chapter-title').value;
  $('saveState').textContent = 'saving…';
  try {
    await api(`/books/${state.book.meta.id}/chapters/${ch.id}`, { method: 'PUT', body: { content: ch.content } });
    await api(`/books/${state.book.meta.id}/outline`, { method: 'PUT', body: { acts: acts(), chapters: chapters().map(stripContent) } });
    $('saveState').textContent = 'saved ✓';
    renderChapterRail();
    if (state.view === 'pages') renderPages();
  } catch { $('saveState').textContent = 'save failed'; }
}, 900);

async function addChapter() {
  const list = chapters().map(stripContent);
  list.push({ title: `Chapter ${list.length + 1}`, summary: '', beats: [], actId: acts()[0]?.id, x: null, y: null });
  await api(`/books/${state.book.meta.id}/outline`, { method: 'PUT', body: { acts: acts(), chapters: list } });
  state.book = await api('/books/' + state.book.meta.id);
  state.chapterId = chapters().at(-1).id;
  autoLayout(); saveOutlineDebounced();
  renderChapterRail();
  state.view === 'outline' ? renderOutline() : renderWrite();
}

// ============================================================
//  RUNNING MEMORY
// ============================================================
// The whole-book layer of the context engine is a running "story so far".
// Nothing keeps it current unless we fold finished chapters into it, so when
// you leave a chapter you've meaningfully added to, that chapter gets summarised
// and merged. One model call, in the background, never blocking the editor.
const FOLD_MIN_WORDS = 120;      // too short to be worth summarising
const FOLD_GROWTH = 200;         // new words needed before we re-fold a chapter

const foldable = (ch) => {
  const w = wc(ch?.content);
  return w >= FOLD_MIN_WORDS && w - (ch.summarizedWords || 0) >= FOLD_GROWTH;
};

function setMemoryStatus(text) {
  const el = $('memWhen');
  if (el) el.textContent = text;
}

// How much of the written book the running summary actually covers.
function memoryCoverage() {
  const written = chapters().filter((c) => wc(c.content) >= FOLD_MIN_WORDS);
  const folded = written.filter((c) => (c.summarizedWords || 0) >= wc(c.content) - FOLD_GROWTH);
  return { written: written.length, folded: folded.length };
}

let folding = false;

async function foldChapter(ch, { force = false } = {}) {
  if (!ch || !state.book || folding) return false;
  if (!force && !foldable(ch)) return false;
  if (wc(ch.content) < FOLD_MIN_WORDS) return false;
  if (!state.model || !modelInstalled(state.model)) return false;

  folding = true;
  setMemoryStatus('folding in ' + (ch.title || 'chapter') + '…');
  try {
    const data = await api('/summary', {
      method: 'POST',
      body: {
        model: state.model,
        previousSummary: state.book.bible.runningSummary || '',
        newChapterTitle: ch.title,
        newChapterText: ch.content,
      },
    });
    if (!data.summary) throw new Error('empty summary');

    // Re-read the bible first: the author may have edited it while this ran.
    state.book.bible = { ...state.book.bible, runningSummary: data.summary };
    await api(`/books/${state.book.meta.id}/bible`, { method: 'PUT', body: state.book.bible });

    ch.summarizedWords = wc(ch.content);
    await api(`/books/${state.book.meta.id}/outline`, {
      method: 'PUT',
      body: { acts: acts(), chapters: chapters().map(stripContent) },
    });

    if (state.view === 'bible') $('bi-summary').value = state.book.bible.runningSummary;
    renderMemory();
    return true;
  } catch (e) {
    console.warn('Could not fold chapter into memory:', e.message);
    renderMemory();
    return false;
  } finally {
    folding = false;
  }
}

// Called when you move away from a chapter you were writing in.
function foldOnLeave(chapterId) {
  if (!state.settings?.context?.autoSummary) return;
  const ch = chapters().find((c) => c.id === chapterId);
  if (foldable(ch)) foldChapter(ch);
}

// Catch-up pass for a book written before any of this existed, or after
// auto-fold was switched off.
async function foldEverything() {
  const btn = $('foldMemoryBtn');
  const pending = chapters().filter((c) => wc(c.content) >= FOLD_MIN_WORDS && (c.summarizedWords || 0) < wc(c.content));
  if (!pending.length) return toast('Memory is already up to date.', 'ok');
  if (!ensureModel('outlineErr', foldEverything)) return toast('Pick an installed model first.', 'err');

  btn.disabled = true;
  let done = 0;
  for (const ch of pending) {
    btn.innerHTML = `<span class="spin"></span> Folding in ${done + 1} of ${pending.length}…`;
    if (await foldChapter(ch, { force: true })) done++;
  }
  btn.disabled = false;
  btn.textContent = '↻ Fold in written chapters';
  $('bi-summary').value = state.book.bible.runningSummary || '';
  toast(done ? `Folded ${done} chapter${done === 1 ? '' : 's'} into memory.` : 'Nothing could be folded in.', done ? 'ok' : 'err');
}

// ---------- AI actions ----------
let currentAbort = null;

async function runAI(action) {
  const ch = currentChapter();
  if (!ch) return toast('Add a chapter first.', 'err');
  const editor = $('editor');
  const instruction = $('ai-instruction').value.trim();

  let selection = '', priorText = editor.value, followingText = '';
  let notes = '', previousAttempt = null, selStart = null, selEnd = null, caret = null;

  if (action === 'revise') {
    const rv = state.revision;
    if (!rv?.original) return toast('Select a passage first.', 'err');
    selection = rv.original; selStart = rv.selStart; selEnd = rv.selEnd;
    notes = rv.notes; previousAttempt = rv.previousAttempt;
    priorText = editor.value.slice(0, rv.selStart);
    followingText = editor.value.slice(rv.selEnd);
  } else if (action === 'rewrite' || action === 'expand') {
    selStart = editor.selectionStart; selEnd = editor.selectionEnd;
    selection = editor.value.slice(selStart, selEnd);
    if (!selection) return toast('Select some text first.', 'err');
    priorText = editor.value.slice(0, selStart);
    followingText = editor.value.slice(selEnd);
  } else if (action === 'describe') {
    caret = editor.selectionStart;
    priorText = editor.value.slice(0, caret);
  }

  openSuggestion();
  $('sug-body').textContent = '';
  $('sug-label').innerHTML = '<span class="spin"></span> ' + labelFor(action);

  currentAbort = new AbortController();
  let acc = '';
  try {
    const r = await fetch('/api/write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: currentAbort.signal,
      body: JSON.stringify({
        model: state.model, meta: state.book.meta, bible: state.book.bible,
        chapter: { title: ch.title, summary: ch.summary, beats: ch.beats },
        priorText, followingText, selection, instruction, action, notes, previousAttempt,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { acc += JSON.parse(line).message?.content || ''; } catch {}
      }
      renderSuggestion(action, acc, selection);
      $('sug-body').scrollTop = $('sug-body').scrollHeight;
    }
    let finalText = acc.trim();
    if (action === 'rewrite' || action === 'expand' || action === 'revise') {
      finalText = spliceClean(finalText, priorText, followingText);
    }
    renderSuggestion(action, finalText, selection);
    $('sug-body').scrollTop = 0; // streaming scrolled to the bottom; show the start
    $('sug-label').textContent = labelFor(action);
    state.lastSuggestion = { action, text: finalText, selection, selStart, selEnd, caret };
    $('sug-again').hidden = action !== 'revise';
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast('Generation failed: ' + e.message, 'err');
    closeSuggestion();
  } finally { currentAbort = null; }
}

const labelFor = (a) => ({ continue: 'Continuation', rewrite: 'Rewrite', expand: 'Expansion', describe: 'Description', revise: 'Revision (your notes applied)' }[a] || 'Suggestion');

function openSuggestion() { $('suggestion').hidden = false; $('sug-again').hidden = true; }
function closeSuggestion() { $('suggestion').hidden = true; state.lastSuggestion = null; }

function renderSuggestion(action, text, selection) {
  const body = $('sug-body');
  if ((action === 'rewrite' || action === 'revise') && selection) body.innerHTML = wordDiff(selection, text);
  else body.textContent = text;
}

function acceptSuggestion() {
  const s = state.lastSuggestion;
  if (!s?.text) return;
  const editor = $('editor'), v = editor.value;
  if (s.action === 'continue' || s.action === 'describe') {
    const at = s.action === 'describe' && s.caret != null ? s.caret : v.length;
    const before = v.slice(0, at);
    const sep = before && !before.endsWith('\n') ? '\n\n' : '';
    editor.value = before + sep + s.text + v.slice(at);
  } else {
    let start = s.selStart, end = s.selEnd;
    if (!(start != null && v.slice(start, end) === s.selection)) {
      start = v.indexOf(s.selection);
      end = start === -1 ? -1 : start + s.selection.length;
    }
    if (start === -1) { editor.value = v + '\n\n' + s.text; toast('Original passage moved — appended instead.', 'err'); }
    else editor.value = v.slice(0, start) + s.text + v.slice(end);
  }
  updateWordcount(); saveChapterDebounced(); closeSuggestion();
  state.revision = null;
  toast('Added to your draft.', 'ok');
}

// ---------- splice cleanup ----------
function longestCommonSubstring(a, b) {
  if (!a || !b) return '';
  let best = 0, bestEnd = 0, prev = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint32Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) { best = cur[j]; bestEnd = i; } }
    }
    prev = cur;
  }
  return a.slice(bestEnd - best, bestEnd);
}
const bare = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();

function stripLeadingEcho(text, before) {
  if (!before?.trim()) return text;
  const b = before.trim().split(/\s+/), t = text.trim().split(/\s+/);
  for (let k = Math.min(12, b.length, t.length - 1); k >= 1; k--) {
    if (bare(b.slice(-k).join(' ')) && bare(b.slice(-k).join(' ')) === bare(t.slice(0, k).join(' '))) return t.slice(k).join(' ');
  }
  return text;
}
function stripTrailingEcho(text, after) {
  if (!after?.trim()) return text;
  const overlap = longestCommonSubstring(text.slice(-400).toLowerCase(), after.slice(0, 400).toLowerCase()).trim();
  if (overlap.length >= 20) {
    const idx = text.toLowerCase().lastIndexOf(overlap.slice(0, 30));
    if (idx > 0) return text.slice(0, idx);
  }
  return text;
}
const DANGLING = new Set(['a','an','the','and','but','or','nor','so','yet','as','like','of','with','without','in','on','at','to','into','onto','from','by','for','than','that','which','while','when','where','whose','her','his','their','its','my','our','your','this','these','those','is','was','were','had','has','have','been','be']);
function trimDangling(t) {
  let out = t.trim().replace(/[\s,;:—–-]+$/, '');
  for (let i = 0; i < 6; i++) {
    const m = out.match(/\s+([A-Za-z']+)$/);
    if (!m || !DANGLING.has(m[1].toLowerCase())) break;
    out = out.slice(0, m.index).replace(/[\s,;:—–-]+$/, '');
  }
  return out;
}
function fixSeam(text, after) {
  let t = trimDangling(text);
  if (/^\s*[,;:]/.test(after) || /^\s*[a-z]/.test(after)) t = t.replace(/[.!?]+$/, '');
  return trimDangling(t);
}
const spliceClean = (text, before, after) => fixSeam(stripTrailingEcho(stripLeadingEcho(text.trim(), before), after), after);

function diffSegments(a, b) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const segs = [];
  const push = (type, text) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += text; else segs.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', A[i]); i++; }
    else { push('ins', B[j]); j++; }
  }
  while (i < n) { push('del', A[i]); i++; }
  while (j < m) { push('ins', B[j]); j++; }
  return segs;
}

// A word-level diff is only readable when the revision still resembles the
// original. Heavy rewrites shred into alternating fragments ("She screameddid
// atnot Aldous,scream furious,"), so those fall back to clean Before/After blocks.
function wordDiff(a, b) {
  const segs = diffSegments(a, b);
  const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  const kept = segs.filter((s) => s.type === 'same').reduce((t, s) => t + words(s.text), 0);
  const longest = Math.max(words(a), words(b)) || 1;
  const changes = segs.filter((s) => s.type !== 'same' && s.text.trim()).length;

  if (kept / longest < 0.35 || changes > 14) {
    return `<div class="diffblock"><span class="dlabel">Before</span><del>${esc(a.trim())}</del></div>
            <div class="diffblock"><span class="dlabel">After</span><ins>${esc(b.trim())}</ins></div>`;
  }
  return segs.map((s) => {
    const t = esc(s.text);
    if (s.type === 'same' || !s.text.trim()) return t;
    return s.type === 'del' ? `<del>${t}</del>` : `<ins>${t}</ins>`;
  }).join('');
}

// ---------- notes composer ----------
const NOTE_CHIPS = ['Tighten — cut 30%','Raise the tension','More dialogue','Deepen the POV','Show, don\'t tell','Slow it down','Darker tone','Simpler prose','Add sensory detail','Cut the exposition'];

function updateSelInfo() {
  const e = $('editor');
  const n = wc(e.value.slice(e.selectionStart, e.selectionEnd));
  const i = $('selInfo');
  if (n > 0) { i.textContent = `${n} word${n === 1 ? '' : 's'} selected`; i.classList.add('has'); }
  else { i.textContent = 'Select a passage to revise it'; i.classList.remove('has'); }
}

function openComposer(mode = 'new') {
  const e = $('editor');
  if (mode === 'new') {
    const start = e.selectionStart, end = e.selectionEnd;
    const original = e.value.slice(start, end);
    if (!original.trim()) return toast('Select the passage you want to revise first.', 'err');
    state.revision = { selStart: start, selEnd: end, original, notes: '', previousAttempt: null };
    $('nc-title').textContent = 'Your notes on this passage';
    $('nc-excerpt').textContent = original;
    $('nc-run').textContent = 'Revise this passage →';
  } else {
    const s = state.lastSuggestion;
    if (!s || !state.revision) return;
    state.revision.previousAttempt = s.text;
    $('nc-title').textContent = 'What still needs work?';
    $('nc-excerpt').textContent = s.text;
    $('nc-run').textContent = 'Revise again →';
    closeSuggestion();
  }
  $('nc-notes').value = '';
  $('nc-chips').innerHTML = NOTE_CHIPS.map((c) => `<button class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
  $('notesComposer').hidden = false;
  $('nc-notes').focus();
}
const closeComposer = () => ($('notesComposer').hidden = true);
function runRevise() {
  const notes = $('nc-notes').value.trim();
  if (!notes) return toast('Add a note describing what should change.', 'err');
  state.revision.notes = notes;
  closeComposer();
  runAI('revise');
}

// ============================================================
//  BIBLE / CARDS / EXPORT
// ============================================================
function renderBible() {
  const b = state.book.bible;
  renderEntries('charList', b.characters || [], 'character');
  renderEntries('locList', b.locations || [], 'location');
  $('bi-themes').value = (b.themes || []).join(', ');
  $('bi-tone').value = b.tone || '';
  $('bi-style').value = b.styleGuide || '';
  $('bi-summary').value = b.runningSummary || '';

  const { written, folded } = memoryCoverage();
  $('memCoverage').textContent = !written
    ? 'No chapters long enough to summarise yet.'
    : folded >= written
      ? `Up to date — all ${written} written chapter${written === 1 ? '' : 's'} are in here.`
      : `${written - folded} written chapter${written - folded === 1 ? '' : 's'} not folded in yet.`;
}
function renderEntries(id, arr, kind) {
  $(id).innerHTML = arr.map((e, i) => `<div class="entry" data-kind="${kind}" data-i="${i}">
      <button class="iconbtn sm remove" data-rm>✕</button>
      <div class="row2"><input class="ename" data-f="name" placeholder="Name" value="${esc(e.name)}"/>
      ${kind === 'character' ? `<input data-f="role" placeholder="Role" value="${esc(e.role || '')}"/>` : ''}</div>
      <textarea data-f="description" rows="2" placeholder="Description">${esc(e.description || '')}</textarea>
      ${kind === 'character' ? `<textarea data-f="arc" rows="1" placeholder="Character arc">${esc(e.arc || '')}</textarea>` : ''}
    </div>`).join('');
}
function collectBible() {
  const grab = (id) => els('#' + id + ' .entry').map((entry) => {
    const o = {}; els('[data-f]', entry).forEach((f) => (o[f.dataset.f] = f.value)); return o;
  });
  return {
    ...state.book.bible,
    characters: grab('charList'), locations: grab('locList'),
    themes: $('bi-themes').value.split(',').map((s) => s.trim()).filter(Boolean),
    tone: $('bi-tone').value, styleGuide: $('bi-style').value, runningSummary: $('bi-summary').value,
  };
}
async function saveBible() {
  const bible = collectBible();
  await api('/books/' + state.book.meta.id + '/bible', { method: 'PUT', body: bible });
  state.book.bible = bible;
  renderQuote(); renderContext();
  toast('Bible saved.', 'ok');
}

function renderCards() {
  $('cardGrid').innerHTML = chapters().map((c, i) => `
    <div class="icard" data-node="${c.id}">
      <div class="in">Chapter ${i + 1}</div>
      <div class="it">${esc(c.title || 'Untitled')}</div>
      <div class="is">${esc(c.summary || 'No summary yet.')}</div>
      <div class="iw">${nf(wc(c.content))} words</div>
    </div>`).join('') || '<div class="empty">No chapters yet.</div>';
}

function renderExport() {
  const chs = chapters();
  const total = chs.reduce((a, c) => a + wc(c.content), 0);
  const withProse = chs.filter((c) => wc(c.content) > 0).length;
  $('exportStats').innerHTML = `
    <div class="stat"><div class="v">${nf(total)}</div><div class="k">Words</div></div>
    <div class="stat"><div class="v">${withProse}/${chs.length}</div><div class="k">Chapters written</div></div>
    <div class="stat"><div class="v">${acts().length}</div><div class="k">Acts</div></div>
    <div class="stat"><div class="v">${Math.max(1, Math.round(total / 250))}</div><div class="k">Est. pages</div></div>`;
}

const doExport = () => { window.location = '/api/books/' + state.book.meta.id + '/export.epub'; };

// ============================================================
//  WIRING
// ============================================================
function wire() {
  els('.railbtn').forEach((b) => (b.onclick = () => go(b.dataset.nav)));
  els('#seg button').forEach((b) => (b.onclick = () => go(b.dataset.seg)));
  $('modelSelect').onchange = (e) => { state.model = e.target.value; localStorage.setItem('inkwell.model', state.model); };
  // settings
  $('settingsBtn').onclick = openSettings;
  $('setClose').onclick = $('setCancel').onclick = () => ($('settingsModal').hidden = true);
  $('setSave').onclick = saveSettings;
  $('setReset').onclick = resetSettings;
  $('set-refresh').onclick = async () => { await refreshProvider(); renderConn(); toast('Models refreshed.'); };
  $('set-cloud-enabled').addEventListener('change', (e) => { $('cloudBox').hidden = !e.target.checked; });
  $('set-cloud-service').addEventListener('change', (e) => {
    const svc = state.cloudServices?.find((x) => x.id === e.target.value);
    $('set-cloud-base').placeholder = svc?.defaultBaseUrl || '';
    if (!$('set-cloud-base').value.trim()) $('set-cloud-base').value = '';
  });
  $('settingsModal').onclick = (e) => { if (e.target.id === 'settingsModal') $('settingsModal').hidden = true; };
  // live-preview every slider as it moves
  for (const [input, output, group, key, fmt] of SET_FIELDS) {
    $(input).addEventListener('input', (e) => {
      $(output).textContent = fmt(e.target.value);
      if (group === 'editor') {
        const r = document.documentElement.style;
        if (key === 'fontSize') r.setProperty('--ed-size', e.target.value + 'px');
        if (key === 'lineHeight') r.setProperty('--ed-lh', e.target.value);
        if (key === 'measure') r.setProperty('--ed-measure', e.target.value);
      }
    });
  }
  $('set-spell').addEventListener('change', (e) => ($('editor').spellcheck = e.target.checked));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('settingsModal').hidden) $('settingsModal').hidden = true;
    if (!$('refineModal').hidden) closeRefine();
  });

  // library + sidebar
  const openHandler = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (confirm('Delete this book permanently? This removes its folder from disk.')) {
        await api('/books/' + del.dataset.del, { method: 'DELETE' });
        if (state.book?.meta.id === del.dataset.del) { state.book = null; localStorage.removeItem('inkwell.lastBook'); }
        await loadLibrary(); go('home');
      }
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) openBook(open.dataset.open);
  };
  $('libList').onclick = openHandler;
  $('bookList').onclick = openHandler;
  $('newBookBtn').onclick = () => go('home');

  $('createBookBtn').onclick = async () => {
    const meta = await api('/books', {
      method: 'POST',
      body: {
        title: $('nb-title').value.trim() || 'Untitled', author: $('nb-author').value.trim(),
        genre: $('nb-genre').value.trim(), premise: $('nb-premise').value.trim(),
        pov: $('nb-pov').value, tense: $('nb-tense').value,
      },
    });
    ['nb-title','nb-author','nb-genre','nb-premise'].forEach((i) => ($(i).value = ''));
    await loadLibrary();
    await openBook(meta.id);
    if (state.book.meta.premise) askNext();
  };

  $('bookTitleInput').oninput = debounce(async () => {
    if (!state.book) return;
    state.book.meta.title = $('bookTitleInput').value;
    await api('/books/' + state.book.meta.id + '/meta', { method: 'PATCH', body: { title: state.book.meta.title } });
    await loadLibrary();
  }, 700);

  // mobile drawers
  $('menuBtn').onclick = () => openDrawer('sidebar');
  $('ctxBtn').onclick = () => openDrawer('context');
  $('aiFab').onclick = () => {
    const p = document.querySelector('.aipanel');
    const open = p.classList.toggle('open');
    document.body.classList.toggle('drawered', open);
    $('scrim').hidden = !open;
  };
  $('scrim').onclick = closeDrawers;

  $('chapterList').onclick = (e) => {
    const row = e.target.closest('[data-ch]');
    if (!row) return;
    if (row.dataset.ch !== state.chapterId) foldOnLeave(state.chapterId);
    state.chapterId = row.dataset.ch;
    renderChapterRail();
    // Reading pages? Stay there and turn to that chapter.
    if (state.view === 'pages') { closeDrawers(); renderPages({ rebuild: true }); return; }
    go('write');
  };
  $('addChapterBtn').onclick = addChapter;
  $('addChapterLink').onclick = addChapter;

  // outline
  els('#mapSeg button').forEach((b) => (b.onclick = () => {
    state.mapMode = b.dataset.map;
    els('#mapSeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderOutline();
  }));
  $('autoArrangeBtn').onclick = () => { autoLayout(); renderMap(); saveOutlineDebounced(); toast('Arranged.'); };
  $('buildOutlineBtn').onclick = () => buildOutline();
  $('rebuildBtn').onclick = () => buildOutline({ rebuild: true, btn: $('rebuildBtn') });

  // refine structure
  $('refineBtn').onclick = openRefine;
  $('refineClose').onclick = $('refineCancel').onclick = closeRefine;
  $('refineRun').onclick = runRefine;
  $('refineAccept').onclick = acceptRefine;
  $('refineBack').onclick = refineBackToNotes;
  $('refineChips').onclick = (e) => {
    const c = e.target.closest('[data-rchip]');
    if (!c) return;
    const ta = $('refineNotes');
    ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, '') + '\n' + c.dataset.rchip : c.dataset.rchip;
    ta.focus();
  };
  $('refineNotes').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runRefine(); }
  });
  $('refineModal').onclick = (e) => { if (e.target.id === 'refineModal') closeRefine(); };
  initDrag();
  const nodeOpen = (e) => {
    const n = e.target.closest('[data-node]');
    if (!n) return;
    state.chapterId = n.dataset.node;
    renderChapterRail(); go('write');
  };
  $('listWrap').onclick = nodeOpen;
  $('cardGrid').onclick = nodeOpen;

  // interview
  $('startInterviewBtn').onclick = askNext;
  $('askThisBtn').onclick = askThis;
  $('skipQBtn').onclick = askNext;
  $('answerSend').onclick = sendAnswer;
  $('answerInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendAnswer(); }
  });
  $('resumeBtn').onclick = () => { $('transcript').scrollTop = $('transcript').scrollHeight; $('answerInput')?.focus(); };

  // voice
  $('micBtn').onclick = toggleMic;
  $('speakQBtn').onclick = () => {
    if (voice.isSpeaking()) return voice.stopSpeaking();
    speakText(pendingQuestion());
  };
  $('readAloudBtn').onclick = readAloud;
  $('set-rate').addEventListener('input', (e) => ($('out-rate').textContent = (+e.target.value).toFixed(2) + '×'));
  // Typing or clicking in the editor cancels playback — the selection is about
  // to be yours again.
  $('editor').addEventListener('keydown', () => { if (voice.isSpeaking()) voice.stopSpeaking(); });
  $('editor').addEventListener('mousedown', () => { if (voice.isSpeaking()) voice.stopSpeaking(); });
  $('openBibleBtn').onclick = () => go('bible');

  // write
  $('editor').addEventListener('input', () => {
    // Keep the in-memory chapter current immediately; the network save is the
    // part that waits. Otherwise leaving a chapter can fold in stale text.
    const ch = currentChapter();
    if (ch) ch.content = $('editor').value;
    updateWordcount(); saveChapterDebounced(); updateSelInfo();
  });
  ['select','mouseup','keyup','focus'].forEach((ev) => $('editor').addEventListener(ev, updateSelInfo));
  $('ed-chapter-title').addEventListener('input', saveChapterDebounced);
  els('[data-action]').forEach((b) => (b.onclick = () => runAI(b.dataset.action)));
  $('reviseBtn').onclick = () => openComposer('new');
  $('nc-close').onclick = closeComposer;
  $('nc-run').onclick = runRevise;
  $('sug-again').onclick = () => openComposer('again');
  $('nc-chips').onclick = (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    const ta = $('nc-notes');
    ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, '') + '\n' + chip.dataset.chip : chip.dataset.chip;
    ta.focus();
  };
  $('nc-notes').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runRevise(); }
  });
  $('sug-accept').onclick = acceptSuggestion;
  $('sug-reject').onclick = closeSuggestion;
  $('sug-close').onclick = () => { currentAbort?.abort(); closeSuggestion(); };
  $('sug-retry').onclick = () => { const a = state.lastSuggestion?.action; if (a) runAI(a); };

  // bible
  $('view-bible').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const key = add.dataset.add;
      state.book.bible[key] = state.book.bible[key] || [];
      state.book.bible[key].push({ name: '', description: '' });
      renderBible(); return;
    }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const entry = rm.closest('.entry');
      const kind = entry.dataset.kind === 'character' ? 'characters' : 'locations';
      state.book.bible = collectBible();
      state.book.bible[kind].splice(+entry.dataset.i, 1);
      renderBible();
    }
  });
  $('saveBibleBtn').onclick = saveBible;
  $('foldMemoryBtn').onclick = foldEverything;

  // notes
  $('notesPad').addEventListener('input', debounce(async () => {
    state.book.notes = $('notesPad').value;
    await api('/books/' + state.book.meta.id + '/notes', { method: 'PUT', body: { notes: state.book.notes } });
    $('notesSaved').textContent = 'saved ✓';
  }, 800));

  // export
  $('exportBtn').onclick = doExport;
  $('exportEpubBtn').onclick = doExport;
}

boot();
