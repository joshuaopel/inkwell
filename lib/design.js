// Book design: how a page actually LOOKS. Trim size, margins, typography,
// chapter openers, running heads, paper colour. Stored per book in design.json
// and used by three consumers that must agree with each other:
//
//   1. the Pages view in the browser (screen pagination)
//   2. Print → PDF (the same CSS, driven by @page)
//   3. the EPUB exporter
//
// Everything is validated through normalizeDesign() because designs arrive from
// three untrusted-ish places: old files on disk, the settings panel, and the
// local model when you ask it to design the book for you.

// Physical page sizes, in inches. These are the sizes KDP actually prints.
export const TRIMS = [
  { id: '5x8',      label: '5 × 8 in — pocket',        w: 5,    h: 8 },
  { id: '5.25x8',   label: '5.25 × 8 in — novel',      w: 5.25, h: 8 },
  { id: '5.5x8.5',  label: '5.5 × 8.5 in — digest',    w: 5.5,  h: 8.5 },
  { id: '6x9',      label: '6 × 9 in — US trade',      w: 6,    h: 9 },
  { id: '6.14x9.21',label: '6.14 × 9.21 in — royal',   w: 6.14, h: 9.21 },
  { id: 'a5',       label: 'A5 — 148 × 210 mm',        w: 5.83, h: 8.27 },
  { id: 'b5',       label: 'B5 — 176 × 250 mm',        w: 6.93, h: 9.84 },
  { id: '8x8',      label: '8 × 8 in — art book',      w: 8,    h: 8 },
  { id: 'letter',   label: '8.5 × 11 in — manuscript', w: 8.5,  h: 11 },
];

// Font stacks only — no webfont downloads, so Inkwell keeps working offline and
// on a LAN with no internet. Anything not installed falls through the stack.
// Readers can also upload a font file (see design.type.fontId = 'upload:<id>').
export const FONTS = [
  { id: 'iowan',      kind: 'serif', label: 'Iowan Old Style', stack: `'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif` },
  { id: 'georgia',    kind: 'serif', label: 'Georgia',         stack: `Georgia,'Times New Roman',serif` },
  { id: 'garamond',   kind: 'serif', label: 'Garamond',        stack: `Garamond,'EB Garamond','Apple Garamond','Adobe Garamond Pro','Times New Roman',serif` },
  { id: 'baskerville',kind: 'serif', label: 'Baskerville',     stack: `Baskerville,'Libre Baskerville','Baskerville Old Face',Georgia,serif` },
  { id: 'caslon',     kind: 'serif', label: 'Caslon',          stack: `'Adobe Caslon Pro','Libre Caslon Text','Big Caslon',Georgia,serif` },
  { id: 'palatino',   kind: 'serif', label: 'Palatino',        stack: `Palatino,'Palatino Linotype','Book Antiqua',Georgia,serif` },
  { id: 'charter',    kind: 'serif', label: 'Charter',         stack: `Charter,'Bitstream Charter','Charis SIL',Georgia,serif` },
  { id: 'hoefler',    kind: 'serif', label: 'Hoefler Text',    stack: `'Hoefler Text','Playfair Display',Georgia,serif` },
  { id: 'bookman',    kind: 'serif', label: 'Bookman',         stack: `'Bookman Old Style','URW Bookman L',Georgia,serif` },
  { id: 'times',      kind: 'serif', label: 'Times',           stack: `'Times New Roman',Times,serif` },
  { id: 'optima',     kind: 'sans',  label: 'Optima',          stack: `Optima,Candara,'Gill Sans','Segoe UI',sans-serif` },
  { id: 'avenir',     kind: 'sans',  label: 'Avenir',          stack: `Avenir,'Avenir Next',Nunito,'Segoe UI',sans-serif` },
  { id: 'helvetica',  kind: 'sans',  label: 'Helvetica',       stack: `Helvetica,'Helvetica Neue',Arial,sans-serif` },
  { id: 'system',     kind: 'sans',  label: 'System sans',     stack: `system-ui,-apple-system,'Segoe UI',Roboto,sans-serif` },
  { id: 'courier',    kind: 'mono',  label: 'Courier — manuscript', stack: `'Courier New',Courier,monospace` },
];

// Exported so callers that merge untrusted input (the AI designer) can check a
// value against the same lists normalizeDesign uses.
export const ENUMS = {
  align: ['justify', 'left'],
  firstLine: ['plain', 'smallcaps', 'dropcap', 'raised'],
  openerStyle: ['classic', 'modern', 'ornament', 'rule', 'plain'],
  numbering: ['arabic', 'roman', 'words', 'none'],
  runningHead: ['none', 'title', 'chapter', 'title-chapter', 'author-title'],
  folio: ['none', 'bottom-center', 'bottom-outer', 'top-outer'],
  texture: ['none', 'paper', 'linen', 'vignette'],
};

export const ORNAMENTS = ['❦', '✦', '❧', '⁂', '✤', '❖', '◆', '＊', '§', '—'];
export const SCENE_BREAKS = ['· · ·', '* * *', '❦', '⁂', '— ◆ —', '·', '(blank line)'];

const { align: ALIGN, firstLine: FIRST_LINE, openerStyle: OPENER_STYLE,
        numbering: NUMBERING, runningHead: RUNNING_HEAD, folio: FOLIO, texture: TEXTURE } = ENUMS;
const OPENER_ALIGN = ['center', 'left'];

export const DEFAULT_DESIGN = {
  preset: 'classic',
  trim: { id: '6x9', w: 6, h: 9 },
  // Inches. `inner` is the binding edge — wider, because the spine eats it.
  margins: { top: 0.8, bottom: 0.85, inner: 0.88, outer: 0.65 },
  type: {
    fontId: 'iowan',
    stack: FONTS[0].stack,
    size: 11.5,          // pt
    leading: 1.52,       // multiple of font size
    align: 'justify',
    hyphens: true,
    indent: 1.2,         // em, first-line indent
    spacing: 0,          // em, extra space between paragraphs
    tracking: 0,         // em, letter-spacing
    firstLine: 'dropcap',
    dropcapLines: 3,
  },
  opener: {
    style: 'classic',
    align: 'center',
    numbering: 'roman',
    label: 'Chapter',
    ornament: '❦',
    drop: 0.2,           // fraction of the page height left blank above the title
    newPage: true,
  },
  furniture: {
    runningHead: 'title-chapter',
    folio: 'bottom-center',
    sceneBreak: '· · ·',
  },
  paper: {
    tint: '#f7f3ea',
    ink: '#221f1a',
    accent: '#8a6a3b',
    texture: 'paper',
    vignette: 0.1,
    edges: true,
  },
  view: { spread: true },
};

// Named looks. Each is a partial design merged over the defaults, so adding a
// field to DEFAULT_DESIGN never breaks a preset.
export const PRESETS = [
  {
    id: 'classic', label: 'Classic literary',
    hint: 'Warm cream paper, old-style serif, roman numerals, drop cap.',
    design: {
      trim: { id: '6x9' },
      type: { fontId: 'iowan', size: 11.5, leading: 1.52, firstLine: 'dropcap', align: 'justify' },
      opener: { style: 'classic', numbering: 'roman', ornament: '❦' },
      paper: { tint: '#f7f3ea', ink: '#221f1a', accent: '#8a6a3b', texture: 'paper' },
    },
  },
  {
    id: 'modern', label: 'Modern minimal',
    hint: 'Bright paper, generous leading, left-aligned openers, no ornament.',
    design: {
      trim: { id: '5.5x8.5' },
      margins: { top: 0.75, bottom: 0.8, inner: 0.8, outer: 0.7 },
      type: { fontId: 'charter', size: 11, leading: 1.62, firstLine: 'plain', indent: 1, align: 'left', hyphens: false },
      opener: { style: 'modern', align: 'left', numbering: 'arabic', drop: 0.12 },
      furniture: { runningHead: 'chapter', folio: 'bottom-outer', sceneBreak: '·' },
      paper: { tint: '#fbfaf7', ink: '#1c1c1e', accent: '#3f6f8f', texture: 'none', vignette: 0.05 },
    },
  },
  {
    id: 'academia', label: 'Dark academia',
    hint: 'Aged paper, Baskerville, small caps openings, heavy ornament.',
    design: {
      trim: { id: '5.25x8' },
      margins: { top: 0.85, bottom: 0.9, inner: 0.9, outer: 0.7 },
      type: { fontId: 'baskerville', size: 11, leading: 1.5, firstLine: 'smallcaps', align: 'justify' },
      opener: { style: 'ornament', numbering: 'roman', ornament: '⁂', drop: 0.26 },
      furniture: { runningHead: 'author-title', folio: 'bottom-center', sceneBreak: '⁂' },
      paper: { tint: '#f2ead7', ink: '#2a2318', accent: '#7a5c2e', texture: 'linen', vignette: 0.2 },
    },
  },
  {
    id: 'pulp', label: 'Pulp paperback',
    hint: 'Tight pocket trim, dense type, rules under the chapter number.',
    design: {
      trim: { id: '5x8' },
      margins: { top: 0.6, bottom: 0.65, inner: 0.7, outer: 0.5 },
      type: { fontId: 'times', size: 10.5, leading: 1.36, indent: 1.4, firstLine: 'raised', align: 'justify' },
      opener: { style: 'rule', numbering: 'arabic', drop: 0.14 },
      furniture: { runningHead: 'title-chapter', folio: 'top-outer', sceneBreak: '* * *' },
      paper: { tint: '#f6efe0', ink: '#26221c', accent: '#9a3b2c', texture: 'paper', vignette: 0.22 },
    },
  },
  {
    id: 'artbook', label: 'Illustrated',
    hint: 'Square trim and wide outer margins — room for art to breathe.',
    design: {
      trim: { id: '8x8' },
      margins: { top: 0.9, bottom: 0.9, inner: 0.9, outer: 1.1 },
      type: { fontId: 'optima', size: 12, leading: 1.6, indent: 0, spacing: 0.7, firstLine: 'plain', align: 'left', hyphens: false },
      opener: { style: 'modern', align: 'left', numbering: 'none', drop: 0.1 },
      furniture: { runningHead: 'none', folio: 'bottom-outer', sceneBreak: '❖' },
      paper: { tint: '#fdfcf8', ink: '#232323', accent: '#4c6b57', texture: 'none', vignette: 0 },
    },
  },
  {
    id: 'manuscript', label: 'Submission manuscript',
    hint: 'Courier, double spaced, letter paper — what an agent expects.',
    design: {
      trim: { id: 'letter' },
      margins: { top: 1, bottom: 1, inner: 1, outer: 1 },
      type: { fontId: 'courier', size: 12, leading: 2, indent: 2, firstLine: 'plain', align: 'left', hyphens: false },
      opener: { style: 'plain', align: 'center', numbering: 'arabic', drop: 0.3 },
      furniture: { runningHead: 'author-title', folio: 'top-outer', sceneBreak: '#' },
      paper: { tint: '#ffffff', ink: '#000000', accent: '#000000', texture: 'none', vignette: 0, edges: false },
    },
  },
];

// ---------- validation ----------
const num = (v, min, max, dflt) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : dflt);
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
const hex = (v, dflt) => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(v)) ? String(v) : dflt);
const text = (v, max, dflt) => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max).trim();
  return s || dflt;
};

export function findTrim(id) { return TRIMS.find((t) => t.id === id); }
export function findFont(id) { return FONTS.find((f) => f.id === id); }

// Resolve a font id to a CSS stack. Uploaded fonts are `upload:<assetId>` and
// are served with an @font-face family of `up-<assetId>`.
export function fontStack(fontId, fallback) {
  if (typeof fontId === 'string' && fontId.startsWith('upload:')) {
    const id = fontId.slice(7).replace(/[^a-z0-9_-]/gi, '');
    return `'up-${id}',${fallback || `Georgia,'Times New Roman',serif`}`;
  }
  return (findFont(fontId) || FONTS[0]).stack;
}

// Deep-merge a partial design over a base. Only known groups are merged, so a
// malformed object can never introduce surprise keys.
function mergeDesign(base, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = { ...base };
  for (const k of ['trim', 'margins', 'type', 'opener', 'furniture', 'paper', 'view']) {
    out[k] = { ...base[k], ...(p[k] && typeof p[k] === 'object' ? p[k] : {}) };
  }
  if (typeof p.preset === 'string') out.preset = p.preset;
  return out;
}

export function presetDesign(presetId) {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) return normalizeDesign(DEFAULT_DESIGN);
  return normalizeDesign({ ...mergeDesign(DEFAULT_DESIGN, p.design), preset: p.id });
}

export function normalizeDesign(input) {
  const d = mergeDesign(DEFAULT_DESIGN, input);

  // Trim: a catalogue id wins; otherwise accept a custom w×h.
  const known = findTrim(d.trim.id);
  const trim = known
    ? { id: known.id, w: known.w, h: known.h }
    : { id: 'custom', w: num(d.trim.w, 3, 20, 6), h: num(d.trim.h, 3, 20, 9) };

  // Margins can't eat the page: cap each pair at 40% of the dimension.
  const maxSide = trim.w * 0.4, maxEnd = trim.h * 0.4;
  const margins = {
    top: num(d.margins.top, 0.15, maxEnd, DEFAULT_DESIGN.margins.top),
    bottom: num(d.margins.bottom, 0.15, maxEnd, DEFAULT_DESIGN.margins.bottom),
    inner: num(d.margins.inner, 0.15, maxSide, DEFAULT_DESIGN.margins.inner),
    outer: num(d.margins.outer, 0.15, maxSide, DEFAULT_DESIGN.margins.outer),
  };

  const fontId = typeof d.type.fontId === 'string' && d.type.fontId.startsWith('upload:')
    ? 'upload:' + d.type.fontId.slice(7).replace(/[^a-z0-9_-]/gi, '')
    : (findFont(d.type.fontId) || FONTS[0]).id;

  const type = {
    fontId,
    stack: fontStack(fontId),
    size: num(d.type.size, 7, 24, DEFAULT_DESIGN.type.size),
    leading: num(d.type.leading, 1.05, 2.6, DEFAULT_DESIGN.type.leading),
    align: pick(d.type.align, ALIGN, 'justify'),
    hyphens: bool(d.type.hyphens, true),
    indent: num(d.type.indent, 0, 4, DEFAULT_DESIGN.type.indent),
    spacing: num(d.type.spacing, 0, 2, 0),
    tracking: num(d.type.tracking, -0.05, 0.2, 0),
    firstLine: pick(d.type.firstLine, FIRST_LINE, 'plain'),
    dropcapLines: Math.round(num(d.type.dropcapLines, 2, 5, 3)),
  };

  const opener = {
    style: pick(d.opener.style, OPENER_STYLE, 'classic'),
    align: pick(d.opener.align, OPENER_ALIGN, 'center'),
    numbering: pick(d.opener.numbering, NUMBERING, 'roman'),
    label: text(d.opener.label, 24, ''),
    ornament: text(d.opener.ornament, 8, '❦'),
    drop: num(d.opener.drop, 0, 0.45, 0.2),
    newPage: bool(d.opener.newPage, true),
  };

  const furniture = {
    runningHead: pick(d.furniture.runningHead, RUNNING_HEAD, 'title-chapter'),
    folio: pick(d.furniture.folio, FOLIO, 'bottom-center'),
    sceneBreak: text(d.furniture.sceneBreak, 12, '· · ·'),
  };

  const paper = {
    tint: hex(d.paper.tint, DEFAULT_DESIGN.paper.tint),
    ink: hex(d.paper.ink, DEFAULT_DESIGN.paper.ink),
    accent: hex(d.paper.accent, DEFAULT_DESIGN.paper.accent),
    texture: pick(d.paper.texture, TEXTURE, 'paper'),
    vignette: num(d.paper.vignette, 0, 0.5, 0.1),
    edges: bool(d.paper.edges, true),
  };

  return {
    preset: PRESETS.some((p) => p.id === d.preset) ? d.preset : 'custom',
    trim, margins, type, opener, furniture, paper,
    view: { spread: bool(d.view.spread, true) },
  };
}

// ---------- art placement ----------
const SIDES = ['left', 'right', 'full', 'center', 'bleed'];
const SHAPES = ['rect', 'circle', 'ellipse', 'alpha'];

// One picture, pinned to a paragraph of a chapter. `side` decides whether the
// prose wraps around it; `shape` decides the wrap outline.
export function normalizePlacement(p, i = 0) {
  return {
    id: String(p?.id || `art-${Date.now().toString(36)}-${i}`).replace(/[^a-z0-9_-]/gi, '').slice(0, 48),
    assetId: String(p?.assetId || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 64),
    chapterId: String(p?.chapterId || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64),
    para: Math.round(num(p?.para, 0, 5000, 0)),
    side: pick(p?.side, SIDES, 'right'),
    width: num(p?.width, 12, 100, 42),        // % of the text column
    shape: pick(p?.shape, SHAPES, 'rect'),
    gap: num(p?.gap, 0, 4, 0.8),              // em of clearance between art and prose
    radius: num(p?.radius, 0, 50, 0),         // % corner rounding
    rotate: num(p?.rotate, -20, 20, 0),
    caption: text(p?.caption, 200, ''),
    frame: bool(p?.frame, false),
  };
}

export function normalizeArt(art) {
  const list = Array.isArray(art?.placements) ? art.placements : [];
  return { placements: list.slice(0, 500).map(normalizePlacement) };
}

export function catalog() {
  return {
    trims: TRIMS,
    fonts: FONTS,
    ornaments: ORNAMENTS,
    sceneBreaks: SCENE_BREAKS,
    presets: PRESETS.map(({ id, label, hint }) => ({ id, label, hint })),
    defaults: DEFAULT_DESIGN,
  };
}
