// Voice — Inkwell listening and talking, both strictly on-device.
//
// The rule this module exists to enforce: your voice and your prose never
// travel. That is not the default behaviour of either browser API, so both
// halves are deliberately constrained:
//
//   Speaking   speechSynthesis mixes on-device and network voices in one list.
//              We only ever use voices whose localService flag is true.
//   Listening  SpeechRecognition streams audio to Google/Apple by default.
//              We only start when processLocally can be set, and refuse to run
//              at all otherwise — no silent fallback, ever.
//
// The cost is that dictation is Chrome/Edge-only for now. That's the right
// trade for a tool whose whole premise is that nothing leaves your machine.

const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

// ============================================================
//  SPEAKING
// ============================================================
let voicesReady = null;

// getVoices() is empty until the engine warms up; resolve once it has.
function loadVoices() {
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const got = () => {
      const all = speechSynthesis.getVoices();
      if (all.length) { resolve(all); return true; }
      return false;
    };
    if (got()) return;
    speechSynthesis.addEventListener('voiceschanged', got, { once: true });
    // Some engines never fire the event; don't hang the UI on it.
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);
  });
  return voicesReady;
}

export function canSpeak() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Only voices that run on this machine. A network voice would ship your prose
// to a server to be read back to you, which rather defeats the point.
export async function localVoices() {
  if (!canSpeak()) return [];
  const all = await loadVoices();
  return all.filter((v) => v.localService);
}

// Split into speakable chunks, keeping each one's offsets in the source text so
// the caller can follow along — and keeping them short, because long utterances
// stall in some engines.
const MAX_CHUNK = 240;

export function splitForSpeech(text) {
  const out = [];
  const src = String(text || '');
  // Sentence-ish boundaries, then hard-wrap anything still too long.
  const re = /[^.!?…]+(?:[.!?…]+["'”’)]*|\s*$)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let start = m.index;
    let piece = m[0];
    if (!piece.trim()) continue;
    while (piece.length > MAX_CHUNK) {
      // Break at the last space inside the limit so words stay whole.
      let cut = piece.lastIndexOf(' ', MAX_CHUNK);
      if (cut <= 0) cut = MAX_CHUNK;
      const head = piece.slice(0, cut);
      if (head.trim()) out.push({ text: head.trim(), start: start + (head.length - head.trimStart().length), end: start + head.length });
      start += cut;
      piece = piece.slice(cut);
    }
    if (piece.trim()) {
      const lead = piece.length - piece.trimStart().length;
      out.push({ text: piece.trim(), start: start + lead, end: start + piece.length });
    }
  }
  return out;
}

let speakQueue = [];
let speakIndex = 0;
let speakOpts = null;
let speaking = false;
let keepAlive = null;

export function isSpeaking() { return speaking; }

export function stopSpeaking() {
  speaking = false;
  speakQueue = [];
  speakIndex = 0;
  clearInterval(keepAlive);
  keepAlive = null;
  if (canSpeak()) speechSynthesis.cancel();
  speakOpts?.onStop?.();
}

// Speak text, calling onChunk with each fragment's offsets as it starts, so the
// caller can highlight along. Returns immediately; playback is asynchronous.
export async function speak(text, opts = {}) {
  if (!canSpeak()) return false;
  stopSpeaking();

  const chunks = splitForSpeech(text);
  if (!chunks.length) return false;

  const voices = await localVoices();
  const chosen = voices.find((v) => v.voiceURI === opts.voiceURI) || voices[0] || null;

  speakQueue = chunks;
  speakIndex = 0;
  speakOpts = opts;
  speaking = true;

  // Chrome pauses long synthesis runs after ~15s; nudging it keeps it going.
  clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    if (!speaking) return;
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      speechSynthesis.resume();
    }
  }, 9000);

  const next = () => {
    if (!speaking) return;
    if (speakIndex >= speakQueue.length) {
      const done = speakOpts?.onEnd;
      stopSpeaking();
      done?.();
      return;
    }
    const chunk = speakQueue[speakIndex++];
    const u = new SpeechSynthesisUtterance(chunk.text);
    if (chosen) { u.voice = chosen; u.lang = chosen.lang; }
    u.rate = opts.rate ?? 1;
    u.pitch = opts.pitch ?? 1;
    u.onstart = () => opts.onChunk?.(chunk);
    u.onend = next;
    u.onerror = (e) => {
      // 'interrupted' and 'canceled' are what stopSpeaking() looks like.
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      opts.onError?.(e.error || 'speech failed');
      stopSpeaking();
    };
    speechSynthesis.speak(u);
  };
  next();
  return true;
}

// ============================================================
//  LISTENING
// ============================================================
// Availability, honestly reported:
//   'ready'        on-device recognition is installed and usable
//   'downloadable' available, but the language pack needs fetching once
//   'downloading'  pack is being fetched right now
//   'no-local'     the browser has recognition, but only the server kind
//   'unsupported'  no speech recognition at all
export async function listenAvailability(lang = 'en-US') {
  if (!SR) return 'unsupported';
  // Without this property we cannot pin recognition to the device, so we treat
  // the whole feature as unavailable rather than quietly uploading audio.
  if (!('processLocally' in SR.prototype) && typeof SR.available !== 'function') return 'no-local';
  if (typeof SR.available !== 'function') return 'no-local';
  try {
    const r = await SR.available({ langs: [lang], processLocally: true });
    // The API returned a boolean in earlier drafts and a string now.
    if (typeof r === 'boolean') return r ? 'ready' : 'no-local';
    if (r === 'available') return 'ready';
    if (r === 'downloadable' || r === 'downloading' || r === 'unavailable') {
      return r === 'unavailable' ? 'no-local' : r;
    }
    return 'no-local';
  } catch {
    return 'no-local';
  }
}

// Fetch the on-device language pack. One time, then it works offline forever.
export async function installLocalRecognition(lang = 'en-US') {
  if (!SR || typeof SR.install !== 'function') return false;
  try {
    const ok = await SR.install({ langs: [lang], processLocally: true });
    return ok !== false;
  } catch {
    return false;
  }
}

let recognizer = null;

export function isListening() { return !!recognizer; }

export function stopListening() {
  if (!recognizer) return;
  const r = recognizer;
  recognizer = null;
  try { r.stop(); } catch {}
}

// Start dictating. onInterim gets the in-progress guess, onFinal the settled
// text. Refuses to start unless recognition can be pinned to this device.
export async function startListening({ lang = 'en-US', onInterim, onFinal, onEnd, onError } = {}) {
  if (!SR) { onError?.('This browser has no speech recognition.'); return false; }

  const status = await listenAvailability(lang);
  if (status !== 'ready') { onError?.(status); return false; }

  const rec = new SR();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  if ('processLocally' in rec) rec.processLocally = true;
  else { onError?.('no-local'); return false; }

  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += chunk;
      else interim += chunk;
    }
    if (interim) onInterim?.(finalText + interim);
    else onFinal?.(finalText);
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted' || e.error === 'no-speech') return;
    onError?.(e.error || 'recognition failed');
  };
  rec.onend = () => {
    recognizer = null;
    onEnd?.(finalText);
  };

  try { rec.start(); } catch (e) { onError?.(String(e.message || e)); return false; }
  recognizer = rec;
  return true;
}

// ============================================================
//  NAMES
// ============================================================
// Speech recognition has never heard of your characters. "Maren Vale in
// Sableport" comes back as "Marin Veil in Sable Port" — which would make
// dictation useless for fiction. Inkwell already knows every name in the book,
// so the transcript gets matched against the story bible and put right.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

// Mishearings are phonetic, not typographic: "Vale" and "Veil" sound identical
// but are three edits apart, so edit distance alone misses exactly the errors
// this is for. Soundex catches the sound, edit distance stops the sound-alikes
// that aren't plausible slips.
function soundex(s) {
  const a = s.toUpperCase().replace(/[^A-Z]/g, '');
  if (!a) return '';
  const code = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let out = a[0];
  let prev = code[a[0]] || 0;
  for (let i = 1; i < a.length && out.length < 4; i++) {
    const c = code[a[i]] || 0;
    if (c && c !== prev) out += c;
    if (a[i] !== 'H' && a[i] !== 'W') prev = c;
  }
  return (out + '000').slice(0, 4);
}

const letters = (s) => String(s).toLowerCase().replace(/[^\p{L}]/gu, '');
const words = (s) => String(s).split(/\s+/).map(letters).filter(Boolean);

// Compared word by word: a Soundex key only encodes the first few consonants,
// so running it over a whole phrase would call almost anything a match.
// `strict` withholds the benefit of the doubt when the transcript has no
// capitals to go on.
function soundsLike(heard, name, strict) {
  const a = words(heard), b = words(name);
  if (!a.length || a.length !== b.length) return false;
  if (a.join('') === b.join('')) return false;      // already correct
  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) continue;
    if (Math.abs(a[i].length - b[i].length) > 2) return false;
    // Same sound, different spelling — the shape of a mishearing.
    if (soundex(a[i]) !== soundex(b[i])) return false;
    if (strict && levenshtein(a[i], b[i]) > 1) return false;
  }
  return true;
}

// Collect the names Inkwell knows about, longest first so "Tam Aldous" is
// tried before "Tam".
export function bibleNames(bible = {}) {
  const names = [];
  for (const c of bible.characters || []) {
    if (!c?.name) continue;
    const full = c.name.trim();
    names.push(full);
    // Prose calls people by one name far more often than both, so "Maren" has
    // to be a candidate in its own right. Only for characters: splitting a
    // place like "The Cartographers Guild" would put ordinary words such as
    // "guild" up for correction.
    for (const part of full.split(/\s+/)) {
      if (part.length >= 4) names.push(part);
    }
  }
  for (const l of bible.locations || []) if (l?.name) names.push(l.name.trim());
  for (const l of bible.lore || []) {
    const n = typeof l === 'string' ? '' : l?.name;
    if (n) names.push(n.trim());
  }
  return [...new Set(names.filter((n) => n.length >= 4))]
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length);
}

// Rewrite a transcript so the book's proper nouns are spelled the book's way.
// Word counts are allowed to differ, so "Sable Port" becomes "Sableport".
//
// The gate that stops ordinary words being mangled is capitalisation: speech
// recognition capitalises what it takes to be a name, so "a warren of streets"
// is left alone while "Warren said" is a candidate. If a transcript arrives with
// no capitals at all, matching still runs but only accepts single-character
// slips.
//
// Returns { text, fixes: [{ from, to }] } — every change is reported so the UI
// can show them and let the author undo one that was wrong.
export function correctNames(text, names) {
  const src = String(text || '');
  if (!src || !names?.length) return { text: src, fixes: [] };

  // Any capital at all is enough to show the recogniser capitalises; the
  // per-word check below is what actually decides. Don't skip the first word —
  // in "Mirren signed it" the only capital is the name itself.
  const hasCaps = /\p{Lu}/u.test(src);
  const maxWords = Math.min(3, Math.max(...names.map((n) => n.split(/\s+/).length)));

  const tokens = src.split(/(\s+)/);            // words at even indices
  const fixes = [];

  for (let i = 0; i < tokens.length; i += 2) {
    const first = tokens[i];
    if (!first || !/\p{L}/u.test(first)) continue;
    const startsUpper = /^[^\p{L}]*\p{Lu}/u.test(first);
    if (hasCaps && !startsUpper) continue;

    // Longest span first, so "Tam Aldous" wins over "Tam".
    for (let n = maxWords; n >= 1; n--) {
      const span = n * 2 - 1;
      if (i + span > tokens.length) continue;
      const slice = tokens.slice(i, i + span);
      const phrase = slice.join('');
      const bare = phrase.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (!bare) continue;

      // A span may only stand in for a name with the same number of words —
      // otherwise a match would swallow whatever came after it. The exception
      // is pure spacing ("Sable Port" for "Sableport"), where the letters agree.
      const hit = names.find((name) => {
        const sameLetters = letters(bare) === letters(name);
        if (sameLetters) return bare !== name;
        return n === name.split(/\s+/).length && soundsLike(bare, name, !hasCaps);
      });
      if (!hit) continue;

      const at = phrase.indexOf(bare);
      tokens.splice(i, span, phrase.slice(0, at) + hit + phrase.slice(at + bare.length));
      fixes.push({ from: bare, to: hit });
      break;
    }
  }
  return { text: tokens.join(''), fixes };
}
