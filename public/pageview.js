// Pages view — see your book as printed pages.
//
// The pagination is done by the browser, not by us. The prose goes into one
// multi-column box whose column width and height are exactly the text block of
// the trim size, so every column IS a page; the paper sheets are drawn behind
// it and the flow is slid sideways one column-pitch at a time. That means line
// breaks, widows, floats and text wrapping around art are all laid out by the
// real engine — what you see is what prints.
//
// All measurements are in "paper pixels" at 96dpi (1in = 96px), and the whole
// assembly is scaled to fit the screen. So the page is 6×9 inches whether
// you're looking at it on a 27" monitor or a phone.

const PX = 96;                   // px per inch
const PT = 96 / 72;              // px per point

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let ctx = null;      // supplied by app.js — { api, toast, book, chapterId, setChapter, reload }
let cat = null;      // /api/design/catalog

const pv = {
  design: null,
  art: { placements: [] },
  assets: [],
  scope: 'chapter',        // 'chapter' | 'book'
  page: 0,
  pages: 1,
  spread: true,
  zoom: 'fit',             // 'fit' | 'width' | a number
  panel: null,             // 'design' | 'art' | null
  sel: null,               // selected placement id
  geo: null,               // computed page geometry
  marks: [],               // [{ chapterId, title, page }]
  injectedFonts: new Set(),
  built: '',               // signature of what's currently in the flow
};

const design = () => pv.design;
const book = () => ctx.book();
const chapters = () => book()?.outline?.chapters || [];
const currentChapter = () => chapters().find((c) => c.id === ctx.chapterId()) || chapters()[0] || null;
const scopeChapters = () => (pv.scope === 'book' ? chapters() : [currentChapter()].filter(Boolean));

// ============================================================
//  PROSE → PAGE MARKUP
// ============================================================
// Same minimal prose-markdown the EPUB exporter understands: blank lines split
// paragraphs, *italic* and **bold**, and a lone *** is a scene break.
function inlineMd(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\*)(.+?)\*/g, '$1<em>$2</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

function blocks(md) {
  return String(md || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

const ROMAN = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
function roman(n) {
  let out = '', v = n;
  for (const [k, s] of ROMAN) while (v >= k) { out += s; v -= k; }
  return out || '0';
}
const NUM_WORDS = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen','Twenty','Twenty-one','Twenty-two','Twenty-three','Twenty-four','Twenty-five','Twenty-six','Twenty-seven','Twenty-eight','Twenty-nine','Thirty'];

function chapterNumber(i) {
  const d = design().opener;
  const n = i + 1;
  if (d.numbering === 'none') return '';
  const body = d.numbering === 'roman' ? roman(n) : d.numbering === 'words' ? (NUM_WORDS[n] || n) : n;
  return `${d.label ? d.label + ' ' : ''}${body}`;
}

function assetUrl(assetId) {
  return `/api/books/${book().meta.id}/assets/${assetId}/raw`;
}

// A picture pinned into the prose. `side` decides whether text wraps around it,
// `shape` decides the outline the text follows.
function figureHtml(p) {
  const a = pv.assets.find((x) => x.id === p.assetId);
  if (!a) return '';
  const url = assetUrl(p.assetId);
  // circle/ellipse are declarative; the alpha outline is traced from the
  // image itself and filled in by applyAlphaShapes() once it's decoded.
  const shape =
    p.shape === 'circle' ? 'circle(50%)' :
    p.shape === 'ellipse' ? 'ellipse(50% 50%)' : '';
  const wraps = p.side === 'left' || p.side === 'right';
  const style = [
    `--art-w:${p.width}%`,
    `--art-gap:${p.gap}em`,
    `--art-radius:${p.radius}%`,
    `--art-rotate:${p.rotate}deg`,
    shape ? `shape-outside:${shape}` : '',
    wraps ? `shape-margin:${p.gap}em` : '',
  ].filter(Boolean).join(';');
  return `<figure class="pv-art side-${p.side} shape-${p.shape}${p.frame ? ' framed' : ''}${pv.sel === p.id ? ' sel' : ''}"
      style="${style}" data-art="${esc(p.id)}">
      <img src="${esc(url)}" alt="${esc(p.caption || a.name)}" draggable="false" />
      ${p.caption ? `<figcaption>${inlineMd(p.caption)}</figcaption>` : ''}
    </figure>`;
}

// ---------- wrapping text around the artwork itself ----------
// `shape-outside: url(...)` is in the spec but not reliable across engines, so
// we read the picture's alpha channel and hand the browser an explicit polygon.
// For every horizontal band of the image we find the leftmost and rightmost
// opaque pixel; the prose then follows those edges line by line.
const shapeCache = new Map();

function loadImage(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('image failed to load'));
    i.src = url;
  });
}

async function alphaOutline(assetId, bands = 48, threshold = 0.08) {
  if (shapeCache.has(assetId)) return shapeCache.get(assetId);
  let pts = null;
  try {
    const img = await loadImage(assetUrl(assetId));
    const w = 128;
    const h = Math.max(8, Math.round(w * (img.naturalHeight || 1) / (img.naturalWidth || 1)));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;

    const left = [], right = [];
    let opaqueBands = 0;
    for (let b = 0; b < bands; b++) {
      const y0 = Math.floor((b * h) / bands);
      const y1 = Math.max(y0 + 1, Math.floor(((b + 1) * h) / bands));
      let min = w, max = -1;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] / 255 > threshold) {
            if (x < min) min = x;
            if (x > max) max = x;
          }
        }
      }
      const yPct = ((b + 0.5) / bands) * 100;
      if (max < 0) { left.push([50, yPct]); right.push([50, yPct]); }
      else { opaqueBands++; left.push([(min / w) * 100, yPct]); right.push([((max + 1) / w) * 100, yPct]); }
    }
    // A photo with no transparency has nothing to trace — leave it a box.
    const solid = left.every(([x]) => x < 1) && right.every(([x]) => x > 99);
    if (opaqueBands && !solid) {
      left.unshift([left[0][0], 0]); right.unshift([right[0][0], 0]);
      left.push([left.at(-1)[0], 100]); right.push([right.at(-1)[0], 100]);
      pts = { left, right };
    }
  } catch { pts = null; }
  shapeCache.set(assetId, pts);
  return pts;
}

// Percentages resolve against the content box, which is taller than the image
// when there's a caption — so squash the traced outline and let the caption
// band sit solid beneath it.
function polygonCss(pts, ratio) {
  const fmt = ([x, y]) => `${x.toFixed(1)}% ${(y * ratio).toFixed(1)}%`;
  const list = pts.left.map(fmt);
  if (ratio < 0.995) list.push('0% 100%', '100% 100%');
  list.push(...pts.right.slice().reverse().map(fmt));
  return `polygon(${list.join(',')}) content-box`;
}

async function applyAlphaShapes() {
  const figs = [...$('pv-flow').querySelectorAll('.pv-art.shape-alpha')];
  let changed = false;
  for (const fig of figs) {
    const p = pv.art.placements.find((x) => x.id === fig.dataset.art);
    if (!p || (p.side !== 'left' && p.side !== 'right')) continue;
    const pts = await alphaOutline(p.assetId);
    if (!pts) continue;
    const img = fig.querySelector('img');
    const box = fig.clientHeight || 1;
    const ratio = Math.min(1, (img?.offsetHeight || box) / box);
    const css = polygonCss(pts, ratio);
    if (fig.style.shapeOutside !== css) { fig.style.shapeOutside = css; changed = true; }
  }
  return changed;
}

function openerHtml(ch, index) {
  // A spread's title is a working label for the author — "Two eyes", "The
  // question" — and printing it as a chapter opener puts a title page in front
  // of every picture, which is not what a picture book is. The header still
  // gets emitted, silently, because it's also the marker that tells the slider
  // and the rail which page each unit starts on.
  if (book()?.meta?.kind === 'picture') {
    return `<header class="pv-opener silent" data-ch="${esc(ch.id)}"></header>`;
  }
  const o = design().opener;
  const num = chapterNumber(index);
  return `<header class="pv-opener" data-ch="${esc(ch.id)}">
      ${num ? `<div class="pv-onum">${esc(num)}</div>` : ''}
      ${o.style === 'rule' ? '<div class="pv-orule"></div>' : ''}
      <h2 class="pv-otitle">${esc(ch.title || 'Untitled')}</h2>
      ${o.style === 'ornament' || o.style === 'classic' ? `<div class="pv-orn">${esc(o.ornament)}</div>` : ''}
    </header>`;
}

function chapterHtml(ch, index) {
  const placements = pv.art.placements
    .filter((p) => p.chapterId === ch.id)
    .sort((a, b) => a.para - b.para);
  const bs = blocks(ch.content);
  const sceneBreak = design().furniture.sceneBreak;

  let html = openerHtml(ch, index);
  if (!bs.length) {
    html += `<p class="pv-blank">This chapter hasn't been written yet.</p>`;
  }

  // Art anchored past the end of the prose still has to appear somewhere.
  const atOrBefore = (i) => placements.filter((p) => (i === 0 ? p.para <= 0 : p.para === i));
  const trailing = placements.filter((p) => p.para >= bs.length && bs.length > 0);

  bs.forEach((b, i) => {
    for (const p of atOrBefore(i)) html += figureHtml(p);
    if (/^(\*{3}|-{3}|#{1,3}|·{3})$/.test(b)) {
      html += sceneBreak === '(blank line)'
        ? '<p class="pv-sep blank">&#160;</p>'
        : `<p class="pv-sep">${esc(sceneBreak)}</p>`;
      return;
    }
    const cls = ['pv-p'];
    if (i === 0) {
      cls.push('first');
      // A drop cap and a picture both floating at the top of the same
      // paragraph fight over the same corner. The picture wins.
      if (placements.some((p) => p.para <= 0 && p.side !== 'full')) cls.push('nocap');
    }
    html += `<p class="${cls.join(' ')}" data-ch="${esc(ch.id)}" data-para="${i}">${inlineMd(b)}</p>`;
  });
  for (const p of trailing) html += figureHtml(p);

  return `<section class="pv-chapter" data-ch="${esc(ch.id)}">${html}</section>`;
}

function buildFlow() {
  const chs = scopeChapters();
  if (!chs.length) {
    $('pv-flow').innerHTML = '<p class="pv-blank">No chapters yet — build an outline first.</p><div id="pv-end"></div>';
    return;
  }
  // Numbering always reflects the chapter's place in the whole book, even when
  // you're only previewing one chapter.
  const all = chapters();
  $('pv-flow').innerHTML =
    chs.map((ch) => chapterHtml(ch, all.findIndex((c) => c.id === ch.id))).join('') +
    '<div id="pv-end"></div>';
}

// ============================================================
//  GEOMETRY + LAYOUT
// ============================================================
function geometry() {
  const d = design();
  const W = d.trim.w * PX, H = d.trim.h * PX;
  const mi = d.margins.inner * PX, mo = d.margins.outer * PX;
  const mt = d.margins.top * PX, mb = d.margins.bottom * PX;
  const contentW = Math.max(60, W - mi - mo);
  const contentH = Math.max(60, H - mt - mb);
  // The gap between columns has to leave room for both side margins. Using
  // twice the LARGER margin makes facing pages sit flush against each other
  // (see sheetLeft below) without ever overlapping.
  const gap = 2 * Math.max(mi, mo);
  return { W, H, mi, mo, mt, mb, contentW, contentH, gap, pitch: contentW + gap };
}

// Page 1 is a right-hand page, like every printed book. Right-hand pages have
// the binding on their left, so their left margin is the inner one.
const isRecto = (i) => i % 2 === 0;
const marginLeft = (g, i) => (isRecto(i) ? g.mi : g.mo);

// Which pages are on screen: a single page, or a verso/recto spread.
function visiblePages() {
  if (!pv.spread) return [pv.page];
  // Spreads pair (2,3), (4,5)… so page 1 sits alone on the right.
  const p = pv.page;
  if (p === 0) return [null, 0];
  const left = p % 2 === 1 ? p : p - 1;
  return [left, left + 1];
}

function applyCss() {
  const d = design(), g = geometry();
  pv.geo = g;
  const paper = $('pv-paper');
  const s = paper.style;
  s.setProperty('--pw', g.W + 'px');
  s.setProperty('--ph', g.H + 'px');
  s.setProperty('--cw', g.contentW + 'px');
  s.setProperty('--ch', g.contentH + 'px');
  s.setProperty('--gap', g.gap + 'px');
  s.setProperty('--mt', g.mt + 'px');
  s.setProperty('--mb', g.mb + 'px');
  s.setProperty('--mi', g.mi + 'px');
  s.setProperty('--mo', g.mo + 'px');
  s.setProperty('--fs', (d.type.size * PT).toFixed(2) + 'px');
  s.setProperty('--lh', d.type.leading);
  s.setProperty('--indent', d.type.indent + 'em');
  s.setProperty('--pspace', d.type.spacing + 'em');
  s.setProperty('--tracking', d.type.tracking + 'em');
  s.setProperty('--stack', d.type.stack);
  s.setProperty('--ink', d.paper.ink);
  s.setProperty('--tint', d.paper.tint);
  s.setProperty('--accent', d.paper.accent);
  s.setProperty('--vignette', d.paper.vignette);
  s.setProperty('--odrop', (d.opener.drop * g.contentH).toFixed(1) + 'px');
  s.setProperty('--dropcap', (d.type.dropcapLines * d.type.leading).toFixed(2) + 'em');

  paper.dataset.align = d.type.align;
  paper.dataset.hyphens = d.type.hyphens ? 'on' : 'off';
  paper.dataset.first = d.type.firstLine;
  paper.dataset.opener = d.opener.style;
  paper.dataset.oalign = d.opener.align;
  paper.dataset.texture = d.paper.texture;
  paper.dataset.edges = d.paper.edges ? 'on' : 'off';
  paper.dataset.newpage = d.opener.newPage ? 'on' : 'off';

  ensureFontFace(d.type.fontId);
}

// Uploaded fonts are served from the book folder; register them once each.
function ensureFontFace(fontId) {
  if (typeof fontId !== 'string' || !fontId.startsWith('upload:')) return;
  const id = fontId.slice(7);
  if (pv.injectedFonts.has(id)) return;
  const style = document.createElement('style');
  style.textContent = `@font-face{font-family:'up-${id}';src:url('${assetUrl(id)}');font-display:swap}`;
  document.head.appendChild(style);
  pv.injectedFonts.add(id);
}

// Ask the laid-out flow how many columns it produced, and where each chapter
// starts. Positions are read relative to the flow itself so the current
// translate/scale can't skew them.
function measure() {
  const g = pv.geo;
  const flow = $('pv-flow');
  const end = $('pv-end');
  const scale = pv.scaleNow || 1;
  const base = flow.getBoundingClientRect().left;
  const col = (el) => Math.round((el.getBoundingClientRect().left - base) / scale / g.pitch);

  pv.pages = end ? Math.max(1, col(end) + 1) : 1;
  pv.marks = [...flow.querySelectorAll('.pv-opener')].map((el) => {
    const ch = chapters().find((c) => c.id === el.dataset.ch);
    return { chapterId: el.dataset.ch, title: ch?.title || '', page: col(el) };
  });
  pv.page = clamp(pv.page, 0, pv.pages - 1);
}

// How much room the paper has. The stage is clamped to the viewport first: the
// sheet we size from this is the stage's own content, so an unclamped read
// feeds its own overflow back in and the page never shrinks to fit a phone.
function stageSpace() {
  const stage = $('pv-stage');
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  return {
    w: Math.max(120, Math.min(stage.clientWidth, vw) - 32),
    h: Math.max(120, Math.min(stage.clientHeight, vh) - 32),
  };
}

function spreadWidth(g) {
  return pv.spread ? g.pitch + g.mo - g.mi + g.W : g.W;
}

function fitScale() {
  const g = pv.geo;
  const { w: availW, h: availH } = stageSpace();
  const spreadW = spreadWidth(g);
  if (pv.zoom === 'width') return availW / spreadW;
  if (typeof pv.zoom === 'number') return pv.zoom;
  return Math.min(availW / spreadW, availH / g.H);
}

// Place the paper sheets and slide the text under them.
function paint() {
  const g = pv.geo, d = design();
  const scale = pv.scaleNow = fitScale();
  const pages = visiblePages();
  const shown = pages.filter((p) => p != null);
  const first = shown[0];

  const spreadW = spreadWidth(g);
  // Page 1 sits alone on the right of the first spread, with a blank facing it.
  const leftPad = pages[0] === null ? spreadW - g.W : 0;

  // The left edge of the sheet showing page `i`, in paper px, given that the
  // text column for the first visible page sits at its own left margin.
  const originContent = leftPad + marginLeft(g, first);
  const sheetX = (i) => originContent + (i - first) * g.pitch - marginLeft(g, i);
  // The page keeps its true size and is scaled; its wrapper takes the scaled
  // dimensions so the stage centres what you can actually see.
  const clip = $('pv-clip');
  clip.style.width = spreadW + 'px';
  clip.style.height = g.H + 'px';
  clip.style.transform = `scale(${scale})`;
  const paperEl = $('pv-paper');
  paperEl.style.width = Math.ceil(spreadW * scale) + 'px';
  paperEl.style.height = Math.ceil(g.H * scale) + 'px';

  // sheets + their furniture
  clip.querySelectorAll('.pv-sheet').forEach((el) => el.remove());
  for (const i of pages) {
    const sheet = document.createElement('div');
    sheet.className = 'pv-sheet' + (i == null ? ' ghost' : '') + (i != null && isRecto(i) ? ' recto' : ' verso');
    const x = i == null ? 0 : sheetX(i);
    sheet.style.left = x + 'px';
    if (i != null) sheet.append(...furniture(i));
    clip.prepend(sheet);
  }

  // slide the flow so the first visible page's column lands on its sheet
  $('pv-flow').style.transform = `translateX(${originContent - first * g.pitch}px)`;

  // pager chrome
  $('pv-pageno').textContent = pv.pages
    ? `${shown.map((p) => p + 1).join('–')} / ${pv.pages}`
    : '';
  const slider = $('pv-slider');
  slider.max = String(Math.max(0, pv.pages - 1));
  slider.value = String(pv.page);
  $('pv-prev').disabled = pv.page <= 0;
  $('pv-next').disabled = pv.page >= pv.pages - 1;
  $('pv-stage').classList.toggle('zoomed', scale > fitAll());
  renderMiniMarks();
}

function fitAll() {
  const g = pv.geo;
  const { w, h } = stageSpace();
  return Math.min(w / spreadWidth(g), h / g.H);
}

// Running heads and page numbers are page furniture, not text — they're drawn
// on the sheet, so they never affect where the prose breaks.
function furniture(i) {
  const d = design(), out = [];
  const m = book().meta;
  const openerHere = pv.marks.some((x) => x.page === i);
  const chapterTitle = [...pv.marks].reverse().find((x) => x.page <= i)?.title || '';

  if (d.furniture.runningHead !== 'none' && !openerHere) {
    const left = document.createElement('div');
    left.className = 'pv-rh';
    const verso = !isRecto(i);
    const map = {
      title: [m.title, m.title],
      chapter: [chapterTitle, chapterTitle],
      'title-chapter': [m.title, chapterTitle],
      'author-title': [m.author || m.title, m.title],
    }[d.furniture.runningHead] || ['', ''];
    left.textContent = verso ? map[0] : map[1];
    out.push(left);
  }

  if (d.furniture.folio !== 'none' && !(openerHere && d.furniture.folio === 'top-outer')) {
    const f = document.createElement('div');
    f.className = 'pv-folio ' + d.furniture.folio;
    f.textContent = String(i + 1);
    out.push(f);
  }
  return out;
}

function renderMiniMarks() {
  const wrap = $('pv-marks');
  if (pv.scope !== 'book' || pv.pages < 2) { wrap.innerHTML = ''; wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = pv.marks.map((m) =>
    `<button class="pv-mark" data-goto="${m.page}" style="left:${(m.page / (pv.pages - 1)) * 100}%"
       title="${esc(m.title)} — page ${m.page + 1}"></button>`).join('');
}

// ============================================================
//  RENDER ENTRY POINTS
// ============================================================
// The handful of design fields that change the markup rather than just the CSS.
// Everything else can be re-styled in place, which keeps sliders smooth.
const MARKUP_PATHS = new Set([
  'opener.style', 'opener.numbering', 'opener.label', 'opener.ornament', 'furniture.sceneBreak',
]);

// Rebuild the markup only when the content changed; otherwise just re-measure.
function signature() {
  const d = design();
  return JSON.stringify([
    pv.scope, ctx.chapterId(), pv.sel,
    scopeChapters().map((c) => [c.id, c.title, (c.content || '').length]),
    pv.art.placements, pv.assets.length,
    [...MARKUP_PATHS].map((p) => getPath(d, p)),
    d.type.firstLine,
  ]);
}

export function renderPages({ rebuild = false } = {}) {
  if (!ctx || !pv.design) return;
  const sig = signature();
  if (rebuild || sig !== pv.built) { buildFlow(); pv.built = sig; }
  applyCss();
  // Two passes: the first sets the geometry, the second measures the result.
  // Traced art outlines land a beat later still, once the images decode, and
  // change where the text sits — so measure again when they do.
  requestAnimationFrame(async () => {
    measure();
    paint();
    renderPanel();
    if (await applyAlphaShapes()) { measure(); paint(); }
  });
}

const relayout = () => { applyCss(); measure(); paint(); };

// ============================================================
//  DESIGN PANEL
// ============================================================
function getPath(o, p) { return p.split('.').reduce((x, k) => (x == null ? x : x[k]), o); }
function setPath(o, p, v) {
  const keys = p.split('.'), last = keys.pop();
  keys.reduce((x, k) => (x[k] = x[k] || {}), o)[last] = v;
}

const fontOptions = () => [
  ...cat.fonts.map((f) => [f.id, `${f.label}${f.kind === 'serif' ? '' : ` · ${f.kind}`}`]),
  ...pv.assets.filter((a) => a.kind === 'font').map((a) => ['upload:' + a.id, `${a.name} · yours`]),
];

const CONTROLS = () => [
  {
    group: 'Page size', items: [
      { t: 'select', path: 'trim.id', label: 'Trim', opts: cat.trims.map((t) => [t.id, t.label]) },
      { t: 'range', path: 'margins.top', label: 'Top margin', min: 0.2, max: 2, step: 0.05, unit: '″' },
      { t: 'range', path: 'margins.bottom', label: 'Bottom margin', min: 0.2, max: 2, step: 0.05, unit: '″' },
      { t: 'range', path: 'margins.inner', label: 'Inner (binding)', min: 0.2, max: 2, step: 0.05, unit: '″' },
      { t: 'range', path: 'margins.outer', label: 'Outer', min: 0.2, max: 2, step: 0.05, unit: '″' },
    ],
  },
  {
    group: 'Typeface', items: [
      { t: 'select', path: 'type.fontId', label: 'Font', opts: fontOptions() },
      { t: 'upload-font' },
      { t: 'range', path: 'type.size', label: 'Size', min: 8, max: 18, step: 0.25, unit: 'pt' },
      { t: 'range', path: 'type.leading', label: 'Line height', min: 1.1, max: 2.2, step: 0.02 },
      { t: 'range', path: 'type.tracking', label: 'Letter spacing', min: -0.03, max: 0.12, step: 0.005, unit: 'em' },
      { t: 'seg', path: 'type.align', label: 'Alignment', opts: [['justify', 'Justified'], ['left', 'Ragged']] },
      { t: 'check', path: 'type.hyphens', label: 'Hyphenate' },
      { t: 'range', path: 'type.indent', label: 'First-line indent', min: 0, max: 3, step: 0.1, unit: 'em' },
      { t: 'range', path: 'type.spacing', label: 'Space between ¶', min: 0, max: 1.5, step: 0.05, unit: 'em' },
    ],
  },
  {
    group: 'Chapter openings', items: [
      { t: 'seg', path: 'type.firstLine', label: 'First words', opts: [['plain', 'Plain'], ['smallcaps', 'Small caps'], ['dropcap', 'Drop cap'], ['raised', 'Raised']] },
      { t: 'range', path: 'type.dropcapLines', label: 'Cap depth', min: 2, max: 5, step: 1, unit: ' lines', when: (d) => d.type.firstLine === 'dropcap' },
      { t: 'seg', path: 'opener.style', label: 'Heading', opts: [['classic', 'Classic'], ['modern', 'Modern'], ['ornament', 'Ornament'], ['rule', 'Rule'], ['plain', 'Plain']] },
      { t: 'seg', path: 'opener.align', label: 'Aligned', opts: [['center', 'Centre'], ['left', 'Left']] },
      { t: 'select', path: 'opener.numbering', label: 'Numbering', opts: [['roman', 'Chapter I'], ['arabic', 'Chapter 1'], ['words', 'Chapter One'], ['none', 'Title only']] },
      { t: 'text', path: 'opener.label', label: 'Word before the number', placeholder: 'Chapter' },
      { t: 'pickone', path: 'opener.ornament', label: 'Ornament', opts: () => cat.ornaments, when: (d) => d.opener.style === 'classic' || d.opener.style === 'ornament' },
      { t: 'range', path: 'opener.drop', label: 'Space above title', min: 0, max: 0.45, step: 0.01, fmt: (v) => Math.round(v * 100) + '%' },
      { t: 'check', path: 'opener.newPage', label: 'Start each chapter on a new page' },
    ],
  },
  {
    group: 'Running heads & folios', items: [
      { t: 'select', path: 'furniture.runningHead', label: 'Running head', opts: [['none', 'None'], ['title', 'Book title'], ['chapter', 'Chapter title'], ['title-chapter', 'Title / chapter'], ['author-title', 'Author / title']] },
      { t: 'select', path: 'furniture.folio', label: 'Page numbers', opts: [['none', 'None'], ['bottom-center', 'Bottom, centred'], ['bottom-outer', 'Bottom, outer'], ['top-outer', 'Top, outer']] },
      { t: 'pickone', path: 'furniture.sceneBreak', label: 'Scene break', opts: () => cat.sceneBreaks },
    ],
  },
  {
    group: 'Paper & ink', items: [
      { t: 'color', path: 'paper.tint', label: 'Paper' },
      { t: 'color', path: 'paper.ink', label: 'Ink' },
      { t: 'color', path: 'paper.accent', label: 'Accent' },
      { t: 'seg', path: 'paper.texture', label: 'Texture', opts: [['none', 'None'], ['paper', 'Paper'], ['linen', 'Linen'], ['vignette', 'Aged']] },
      { t: 'range', path: 'paper.vignette', label: 'Edge shadow', min: 0, max: 0.5, step: 0.02, fmt: (v) => Math.round(v * 200) + '%' },
      { t: 'check', path: 'paper.edges', label: 'Show the page edge' },
    ],
  },
];

function controlHtml(c, d) {
  if (c.t === 'upload-font') {
    return `<div class="pv-row"><button class="btn ghost sm block" id="pv-fontUpload">⤒ Upload a font file…</button></div>`;
  }
  const v = getPath(d, c.path);
  const id = 'pvc-' + c.path.replace(/\./g, '-');
  if (c.t === 'range') {
    const shown = c.fmt ? c.fmt(v) : (Math.round(v * 100) / 100) + (c.unit || '');
    return `<div class="pv-row slider"><label for="${id}">${c.label}</label>
      <input type="range" id="${id}" data-path="${c.path}" data-kind="num" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" />
      <output data-out="${c.path}">${shown}</output></div>`;
  }
  if (c.t === 'select') {
    const opts = (typeof c.opts === 'function' ? c.opts() : c.opts)
      .map(([val, lab]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(lab)}</option>`).join('');
    return `<div class="pv-row"><label for="${id}">${c.label}</label>
      <select id="${id}" data-path="${c.path}" data-kind="str">${opts}</select></div>`;
  }
  if (c.t === 'seg') {
    const opts = (typeof c.opts === 'function' ? c.opts() : c.opts)
      .map(([val, lab]) => `<button class="${val === v ? 'on' : ''}" data-path="${c.path}" data-kind="str" data-val="${esc(val)}">${esc(lab)}</button>`).join('');
    return `<div class="pv-row"><label>${c.label}</label><div class="pv-seg">${opts}</div></div>`;
  }
  if (c.t === 'pickone') {
    const opts = (typeof c.opts === 'function' ? c.opts() : c.opts)
      .map((val) => `<button class="pv-glyph ${val === v ? 'on' : ''}" data-path="${c.path}" data-kind="str" data-val="${esc(val)}">${esc(val)}</button>`).join('');
    return `<div class="pv-row"><label>${c.label}</label><div class="pv-glyphs">${opts}</div></div>`;
  }
  if (c.t === 'check') {
    return `<label class="pv-check"><input type="checkbox" data-path="${c.path}" data-kind="bool" ${v ? 'checked' : ''}/> ${c.label}</label>`;
  }
  if (c.t === 'color') {
    return `<div class="pv-row"><label for="${id}">${c.label}</label>
      <input type="color" id="${id}" data-path="${c.path}" data-kind="str" value="${esc(v)}" />
      <output>${esc(v)}</output></div>`;
  }
  if (c.t === 'text') {
    return `<div class="pv-row"><label for="${id}">${c.label}</label>
      <input type="text" id="${id}" data-path="${c.path}" data-kind="str" value="${esc(v || '')}" placeholder="${esc(c.placeholder || '')}" /></div>`;
  }
  return '';
}

function renderDesignPanel() {
  const d = design();
  const presets = cat.presets.map((p) =>
    `<button class="pv-preset ${d.preset === p.id ? 'on' : ''}" data-preset="${p.id}">
       <b>${esc(p.label)}</b><span>${esc(p.hint)}</span></button>`).join('');

  const groups = CONTROLS().map((g) => `<section class="pv-group">
      <h4>${g.group}</h4>
      ${g.items.filter((c) => !c.when || c.when(d)).map((c) => controlHtml(c, d)).join('')}
    </section>`).join('');

  $('pv-panel-body').innerHTML = `
    <section class="pv-group">
      <h4>Looks</h4>
      <div class="pv-presets">${presets}</div>
      <div class="pv-ai">
        <div class="pv-ai-head">✦ Let the model design it</div>
        <p>Uses your local model, the same one that writes. It reads the genre, tone and themes and sets the page to match.</p>
        <input id="pv-brief" placeholder="Optional steer — e.g. 'cosy, hand-made, lots of white space'" />
        <button class="btn gold-ghost sm block" id="pv-suggest">Design this book →</button>
        <div class="pv-rationale" id="pv-rationale" hidden></div>
      </div>
    </section>
    ${groups}
    <section class="pv-group">
      <button class="linkbtn" id="pv-reset">Reset design to the classic look</button>
    </section>`;
}

// ============================================================
//  ART PANEL
// ============================================================
function renderArtPanel() {
  const ch = currentChapter();
  const images = pv.assets.filter((a) => a.kind === 'image');
  const mine = pv.art.placements.filter((p) => !ch || p.chapterId === ch.id).sort((a, b) => a.para - b.para);
  const sel = mine.find((p) => p.id === pv.sel);

  const lib = images.length
    ? images.map((a) => `<button class="pv-asset" data-asset="${a.id}" title="${esc(a.name)}">
         <img src="${assetUrl(a.id)}" alt="" /><span>${esc(a.name)}</span>
         <i class="pv-asset-del" data-del-asset="${a.id}" title="Delete">✕</i></button>`).join('')
    : '<div class="pv-hint">No art yet. Drop an image here, or use the button above.</div>';

  const list = mine.length
    ? mine.map((p) => {
      const a = pv.assets.find((x) => x.id === p.assetId);
      return `<button class="pv-place ${p.id === pv.sel ? 'on' : ''}" data-place="${p.id}">
          ${a ? `<img src="${assetUrl(a.id)}" alt="" />` : '<span class="pv-miss">?</span>'}
          <span class="pv-place-m">¶ ${p.para + 1} · ${p.side}${p.shape !== 'rect' ? ' · ' + p.shape : ''}</span>
        </button>`;
    }).join('')
    : '<div class="pv-hint">Nothing placed in this chapter yet. Pick an image above, then press “Place in chapter”.</div>';

  $('pv-panel-body').innerHTML = `
    <section class="pv-group">
      <h4>Your art</h4>
      <button class="btn ghost sm block" id="pv-upload">⤒ Add an image…</button>
      <div class="pv-assets" id="pv-assets">${lib}</div>
      <button class="btn primary block sm" id="pv-place-btn"${images.length ? '' : ' disabled'}>Place in chapter →</button>
    </section>
    <section class="pv-group">
      <h4>In this chapter</h4>
      <div class="pv-places">${list}</div>
    </section>
    ${sel ? placementControls(sel) : '<section class="pv-group"><div class="pv-hint">Select a placement to change how the text flows around it.</div></section>'}`;
}

function placementControls(p) {
  const seg = (path, opts) => opts.map(([v, l]) =>
    `<button class="${p[path] === v ? 'on' : ''}" data-place-set="${path}" data-kind="str" data-val="${v}">${l}</button>`).join('');
  const range = (path, label, min, max, step, unit = '') =>
    `<div class="pv-row slider"><label>${label}</label>
      <input type="range" data-place-set="${path}" data-kind="num" min="${min}" max="${max}" step="${step}" value="${p[path]}" />
      <output>${Math.round(p[path] * 100) / 100}${unit}</output></div>`;

  return `<section class="pv-group">
      <h4>This picture</h4>
      <div class="pv-row"><label>Position</label><div class="pv-seg">${seg('side', [['left', 'Left'], ['right', 'Right'], ['center', 'Centre'], ['full', 'Full width'], ['bleed', 'Bleed']])}</div></div>
      <div class="pv-row"><label>Text wraps as</label><div class="pv-seg">${seg('shape', [['rect', 'Box'], ['circle', 'Circle'], ['ellipse', 'Oval'], ['alpha', 'Outline']])}</div></div>
      <div class="pv-hint tight">“Outline” follows the transparent edges of a PNG — the prose hugs the artwork itself.</div>
      ${range('width', 'Width', 12, 100, 1, '%')}
      ${range('gap', 'Space around', 0, 3, 0.1, 'em')}
      ${range('radius', 'Rounded corners', 0, 50, 1, '%')}
      ${range('rotate', 'Tilt', -20, 20, 1, '°')}
      <label class="pv-check"><input type="checkbox" data-place-set="frame" data-kind="bool" ${p.frame ? 'checked' : ''}/> Draw a frame</label>
      <div class="pv-row"><label>Caption</label><input type="text" data-place-set="caption" data-kind="str" value="${esc(p.caption)}" placeholder="Optional" /></div>
      <div class="pv-row"><label>Anchored to</label><span class="pv-anchor">paragraph ${p.para + 1}</span></div>
      <div class="pv-hint tight">Click any paragraph on the page to move it there.</div>
      <button class="btn ghost sm block" data-place-del="${p.id}">Remove this picture</button>
    </section>`;
}

function renderPanel() {
  const open = !!pv.panel;
  $('pv-panel').hidden = !open;
  $('pv-view').classList.toggle('paneled', open);
  if (!open) return;
  $('pv-panel-title').textContent = pv.panel === 'art' ? 'Art' : 'Design';
  document.querySelectorAll('#pv-panel-tabs button').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === pv.panel));
  pv.panel === 'art' ? renderArtPanel() : renderDesignPanel();
}

// ============================================================
//  SAVING
// ============================================================
const saveDesign = debounce(async () => {
  try {
    pv.design = await ctx.api(`/books/${book().meta.id}/design`, { method: 'PUT', body: pv.design });
    if (book()) book().design = pv.design;
  } catch (e) { ctx.toast('Could not save the design: ' + e.message, 'err'); }
}, 500);

const saveArt = debounce(async () => {
  try {
    pv.art = await ctx.api(`/books/${book().meta.id}/art`, { method: 'PUT', body: pv.art });
    if (book()) book().art = pv.art;
  } catch (e) { ctx.toast('Could not save the art layout: ' + e.message, 'err'); }
}, 500);

function changeDesign(path, value, { rebuild = false } = {}) {
  setPath(pv.design, path, value);
  if (path === 'type.fontId') {
    const f = cat.fonts.find((x) => x.id === value);
    pv.design.type.stack = f ? f.stack : `'up-${String(value).slice(7)}',Georgia,serif`;
    ensureFontFace(value);
  }
  if (path === 'trim.id') {
    const t = cat.trims.find((x) => x.id === value);
    if (t) { pv.design.trim = { id: t.id, w: t.w, h: t.h }; }
  }
  pv.design.preset = 'custom';
  saveDesign();
  if (rebuild) { pv.built = ''; renderPages(); } else relayout();
}

// ============================================================
//  ART ACTIONS
// ============================================================
async function uploadAsset(file, kind) {
  const max = 30 * 1024 * 1024;
  if (file.size > max) return ctx.toast('That file is larger than 30 MB.', 'err');
  let w = 0, h = 0;
  if (kind === 'image' && file.type !== 'image/svg+xml') {
    try {
      const bmp = await createImageBitmap(file);
      w = bmp.width; h = bmp.height; bmp.close?.();
    } catch {}
  }
  const q = new URLSearchParams({ name: file.name, kind, w: String(w), h: String(h) });
  const r = await fetch(`/api/books/${book().meta.id}/assets?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  const item = await r.json();
  pv.assets.push(item);
  if (book()) book().assets = pv.assets;
  return item;
}

function placeArt(assetId) {
  const ch = currentChapter();
  if (!ch) return ctx.toast('Open a chapter first.', 'err');
  // Drop it on the paragraph you're looking at, not always at the top — and
  // clear of the chapter's opening paragraph, which usually carries the cap.
  const capped = design().type.firstLine === 'dropcap' || design().type.firstLine === 'raised';
  const para = Math.max(paragraphOnPage(pv.page) ?? 0, capped ? 1 : 0);
  const p = {
    id: 'art-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    assetId, chapterId: ch.id, para,
    side: 'right', width: 42, shape: 'rect', gap: 0.8, radius: 0, rotate: 0, caption: '', frame: false,
  };
  pv.art.placements.push(p);
  pv.sel = p.id;
  saveArt();
  pv.built = '';
  renderPages();
  ctx.toast('Placed. Drag the sliders, or click a paragraph to move it.', 'ok');
}

// The first paragraph whose column is the page currently on screen.
function paragraphOnPage(page) {
  const g = pv.geo, flow = $('pv-flow');
  const base = flow.getBoundingClientRect().left, scale = pv.scaleNow || 1;
  const ch = currentChapter();
  for (const el of flow.querySelectorAll('.pv-p')) {
    if (ch && el.dataset.ch !== ch.id) continue;
    const col = Math.round((el.getBoundingClientRect().left - base) / scale / g.pitch);
    if (col >= page) return +el.dataset.para;
  }
  return null;
}

function updatePlacement(id, patch) {
  const p = pv.art.placements.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  saveArt();
  pv.built = '';
  renderPages();
}

// ============================================================
//  AI DESIGN
// ============================================================
async function suggestDesign() {
  const btn = $('pv-suggest');
  const b = book();
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Designing…';
  try {
    const { design: d, rationale } = await ctx.api('/design/suggest', {
      method: 'POST',
      body: { model: ctx.model(), meta: b.meta, bible: b.bible, brief: $('pv-brief').value.trim(), base: pv.design },
    });
    pv.design = d;
    b.design = d;
    saveDesign();
    pv.built = '';
    renderPages();
    requestAnimationFrame(() => {
      const box = $('pv-rationale');
      if (box && rationale) { box.textContent = '“' + rationale + '”'; box.hidden = false; }
    });
    ctx.toast('Designed. Everything is still yours to change.', 'ok');
  } catch (e) {
    ctx.toast('Design failed: ' + (e.message || e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Design this book →';
  }
}

// ============================================================
//  PRINT / PDF
// ============================================================
// The screen preview paginates with columns, which a printer can't use. For
// print we hand the same markup to the browser as ordinary blocks and let it
// paginate onto real sheets via @page.
function printBook() {
  const d = design();
  const style = $('pv-print-style') || Object.assign(document.createElement('style'), { id: 'pv-print-style' });
  style.textContent = `@media print{
    @page { size: ${d.trim.w}in ${d.trim.h}in; margin: ${d.margins.top}in ${d.margins.outer}in ${d.margins.bottom}in ${d.margins.inner}in; }
    @page :left { margin-left: ${d.margins.outer}in; margin-right: ${d.margins.inner}in; }
    @page :right { margin-left: ${d.margins.inner}in; margin-right: ${d.margins.outer}in; }
  }`;
  document.head.appendChild(style);

  // The print container needs the same type settings and switches as the
  // on-screen paper — but none of its screen sizing.
  const paper = $('pv-paper'), out = $('pv-print');
  out.removeAttribute('style');
  for (const name of paper.style) {
    if (name.startsWith('--')) out.style.setProperty(name, paper.style.getPropertyValue(name));
  }
  for (const [k, v] of Object.entries(paper.dataset)) out.dataset[k] = v;
  out.innerHTML = $('pv-flow').innerHTML;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 60);
}

// ============================================================
//  NAVIGATION
// ============================================================
function goPage(n) {
  pv.page = clamp(n, 0, pv.pages - 1);
  paint();
}
const stepPage = (dir) => goPage(pv.page + (pv.spread && pv.page > 0 ? 2 : 1) * dir);

function setZoom(z) {
  pv.zoom = z;
  document.querySelectorAll('#pv-zoom button').forEach((b) => b.classList.toggle('on', b.dataset.zoom === String(z)));
  paint();
}

// ============================================================
//  WIRING
// ============================================================
export async function initPageView(context) {
  ctx = context;
  try { cat = await ctx.api('/design/catalog'); }
  catch { cat = { trims: [], fonts: [], presets: [], ornaments: [], sceneBreaks: [] }; }

  // Phones get a single page and the panel closed; desktops get the spread.
  pv.spread = window.matchMedia('(min-width: 900px)').matches;
  $('pv-spread').classList.toggle('on', pv.spread);

  $('pv-scope').onclick = (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    pv.scope = b.dataset.scope;
    document.querySelectorAll('#pv-scope button').forEach((x) => x.classList.toggle('on', x === b));
    pv.page = 0;
    pv.built = '';
    renderPages();
  };

  $('pv-zoom').onclick = (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    setZoom(b.dataset.zoom === 'fit' || b.dataset.zoom === 'width' ? b.dataset.zoom : +b.dataset.zoom);
  };

  $('pv-spread').onclick = () => {
    pv.spread = !pv.spread;
    $('pv-spread').classList.toggle('on', pv.spread);
    paint();
  };

  $('pv-prev').onclick = () => stepPage(-1);
  $('pv-next').onclick = () => stepPage(1);
  $('pv-slider').oninput = (e) => goPage(+e.target.value);
  $('pv-marks').onclick = (e) => {
    const m = e.target.closest('[data-goto]');
    if (m) goPage(+m.dataset.goto);
  };
  $('pv-print-btn').onclick = printBook;

  document.querySelectorAll('#pv-panel-tabs button').forEach((b) => (b.onclick = () => {
    pv.panel = pv.panel === b.dataset.tab ? null : b.dataset.tab;
    renderPanel();
    requestAnimationFrame(paint);
  }));
  $('pv-panel-close').onclick = () => { pv.panel = null; renderPanel(); requestAnimationFrame(paint); };
  $('pv-design-btn').onclick = () => { pv.panel = pv.panel === 'design' ? null : 'design'; renderPanel(); requestAnimationFrame(paint); };
  $('pv-art-btn').onclick = () => { pv.panel = pv.panel === 'art' ? null : 'art'; renderPanel(); requestAnimationFrame(paint); };

  // ---- design panel input ----
  const readValue = (el) => (el.dataset.kind === 'num' ? +el.value : el.dataset.kind === 'bool' ? el.checked : el.value);
  $('pv-panel-body').addEventListener('input', (e) => {
    const el = e.target.closest('[data-path]');
    if (el) {
      const out = $('pv-panel-body').querySelector(`[data-out="${el.dataset.path}"]`);
      const v = readValue(el);
      if (out) out.textContent = typeof v === 'number' ? Math.round(v * 100) / 100 + (el.type === 'range' ? '' : '') : v;
      // Ornaments and scene breaks change the markup, not just the CSS.
      changeDesign(el.dataset.path, v, { rebuild: MARKUP_PATHS.has(el.dataset.path) });
      if (el.type === 'range' || el.type === 'color') return;      // don't re-render under the cursor
      renderPanel();
      return;
    }
    const pl = e.target.closest('[data-place-set]');
    if (pl && pv.sel) updatePlacement(pv.sel, { [pl.dataset.placeSet]: readValue(pl) });
  });

  $('pv-panel-body').addEventListener('click', async (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      pv.design = await ctx.api('/design/preset/' + preset.dataset.preset);
      book().design = pv.design;
      saveDesign();
      pv.built = '';
      renderPages();
      return;
    }
    const seg = e.target.closest('[data-path][data-val]');
    if (seg) {
      changeDesign(seg.dataset.path, seg.dataset.val, { rebuild: MARKUP_PATHS.has(seg.dataset.path) });
      renderPanel();
      return;
    }
    const placeSeg = e.target.closest('[data-place-set][data-val]');
    if (placeSeg && pv.sel) { updatePlacement(pv.sel, { [placeSeg.dataset.placeSet]: placeSeg.dataset.val }); return; }

    if (e.target.closest('#pv-reset')) {
      pv.design = await ctx.api('/design/preset/classic');
      book().design = pv.design;
      saveDesign(); pv.built = ''; renderPages();
      return;
    }
    if (e.target.closest('#pv-suggest')) return suggestDesign();
    if (e.target.closest('#pv-upload')) return pickFile('image');
    if (e.target.closest('#pv-fontUpload')) return pickFile('font');

    const delAsset = e.target.closest('[data-del-asset]');
    if (delAsset) {
      e.stopPropagation();
      if (!confirm('Delete this image? Any pages using it lose it too.')) return;
      await ctx.api(`/books/${book().meta.id}/assets/${delAsset.dataset.delAsset}`, { method: 'DELETE' });
      pv.assets = pv.assets.filter((a) => a.id !== delAsset.dataset.delAsset);
      pv.art.placements = pv.art.placements.filter((p) => p.assetId !== delAsset.dataset.delAsset);
      book().assets = pv.assets;
      pv.built = ''; renderPages();
      return;
    }
    const asset = e.target.closest('[data-asset]');
    if (asset) {
      pv.pickedAsset = asset.dataset.asset;
      document.querySelectorAll('.pv-asset').forEach((x) => x.classList.toggle('on', x === asset));
      return;
    }
    if (e.target.closest('#pv-place-btn')) {
      const picked = pv.assets.some((a) => a.id === pv.pickedAsset && a.kind === 'image') ? pv.pickedAsset : null;
      const id = picked || pv.assets.find((a) => a.kind === 'image')?.id;
      if (id) placeArt(id);
      return;
    }
    const place = e.target.closest('[data-place]');
    if (place) {
      pv.sel = place.dataset.place;
      pv.built = ''; renderPages();
      const target = pv.art.placements.find((p) => p.id === pv.sel);
      if (target) requestAnimationFrame(() => scrollToParagraph(target.chapterId, target.para));
      return;
    }
    const del = e.target.closest('[data-place-del]');
    if (del) {
      pv.art.placements = pv.art.placements.filter((p) => p.id !== del.dataset.placeDel);
      pv.sel = null;
      saveArt(); pv.built = ''; renderPages();
    }
  });

  // ---- clicking the page itself ----
  $('pv-clip').addEventListener('click', (e) => {
    const fig = e.target.closest('[data-art]');
    if (fig) {
      pv.sel = fig.dataset.art;
      pv.panel = 'art';
      pv.built = ''; renderPages();
      return;
    }
    const p = e.target.closest('.pv-p');
    if (p && pv.sel) {
      updatePlacement(pv.sel, { chapterId: p.dataset.ch, para: +p.dataset.para });
      ctx.toast(`Moved to paragraph ${+p.dataset.para + 1}.`);
    }
  });

  // ---- drag & drop art straight onto the page ----
  const stage = $('pv-stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dropping'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dropping'));
  stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    stage.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    try {
      for (const f of files) {
        const item = await uploadAsset(f, 'image');
        if (item) placeArt(item.id);
      }
    } catch (err) { ctx.toast('Upload failed: ' + err.message, 'err'); }
  });

  // ---- keyboard + swipe ----
  document.addEventListener('keydown', (e) => {
    if (ctx.view() !== 'pages') return;
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); stepPage(1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stepPage(-1); }
    if (e.key === 'Home') goPage(0);
    if (e.key === 'End') goPage(pv.pages - 1);
  });

  let touch = null;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - touch.t < 700) stepPage(dx < 0 ? 1 : -1);
    touch = null;
  }, { passive: true });

  window.addEventListener('resize', debounce(() => { if (ctx.view() === 'pages') paint(); }, 120));

  $('pv-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    try {
      for (const f of files) {
        const item = await uploadAsset(f, pv.fileKind);
        if (pv.fileKind === 'font' && item) changeDesign('type.fontId', 'upload:' + item.id, { rebuild: true });
      }
      renderPanel();
      ctx.toast(pv.fileKind === 'font' ? 'Font added and applied.' : 'Added to your art.', 'ok');
    } catch (err) { ctx.toast('Upload failed: ' + err.message, 'err'); }
  });
}

function pickFile(kind) {
  pv.fileKind = kind;
  const input = $('pv-file');
  input.accept = kind === 'font' ? '.woff2,.woff,.ttf,.otf,font/*' : 'image/*';
  input.click();
}

function scrollToParagraph(chapterId, para) {
  const el = $('pv-flow').querySelector(`.pv-p[data-ch="${CSS.escape(chapterId)}"][data-para="${para}"]`);
  if (!el) return;
  const base = $('pv-flow').getBoundingClientRect().left;
  goPage(Math.round((el.getBoundingClientRect().left - base) / (pv.scaleNow || 1) / pv.geo.pitch));
}

// Called by app.js when a book is opened or the chapter changes.
export function syncPageView() {
  const b = book();
  if (!b) return;
  pv.design = b.design || pv.design;
  pv.art = b.art || { placements: [] };
  pv.assets = b.assets || [];
  pv.built = '';
}

export function pageViewSummary() {
  return { pages: pv.pages, scope: pv.scope };
}
