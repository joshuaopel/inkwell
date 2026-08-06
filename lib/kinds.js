// What kind of book is this?
//
// A picture book is not a short novel. The unit is the spread — two facing
// pages carrying one picture and a line or two of text — the whole thing runs
// 500 to 1000 words, and the craft is in the page turn: you end each spread on
// something that makes a child want to see what's next. None of that is true of
// a novel, so the interview, the structure, the writing prompts and the page
// design all differ.
//
// Structurally a spread IS a chapter: same id, same title, same prose file,
// same place in outline.json. That's deliberate — the editor, the Pages view,
// the EPUB exporter and the chapter rail all keep working untouched, and a book
// can be read either way.

export const KINDS = {
  novel: {
    id: 'novel',
    label: 'Novel or short story',
    hint: 'Chapters, acts, tens of thousands of words.',
    unit: 'chapter',
    units: 'chapters',
    // What "build the outline" aims for.
    targetUnits: 16,
    unitWords: 2500,
    illustrated: false,
    designPreset: 'classic',
    // Steers the interview toward structure at novel scale.
    interviewFocus: [
      'the protagonist\'s want versus their need',
      'the inciting incident',
      'the antagonistic force',
      'the midpoint reversal',
      'the climax and what it costs',
      'tone and setting',
    ],
  },

  picture: {
    id: 'picture',
    label: 'Picture book',
    hint: 'Spreads, pictures, a few hundred words, read aloud.',
    unit: 'spread',
    units: 'spreads',
    // Picture books print in signatures: 32 pages is the standard, of which
    // about 28 carry story once front matter is taken out — call it 14 spreads.
    targetUnits: 14,
    unitWords: 45,
    illustrated: true,
    designPreset: 'artbook',
    pageCounts: [24, 32, 40],
    // Age bands change vocabulary and length more than anything else does.
    ages: [
      { id: 'board', label: 'Board book · 0–3', spreads: 8, words: 12 },
      { id: 'picture', label: 'Picture book · 3–6', spreads: 14, words: 45 },
      { id: 'early', label: 'Early reader · 5–8', spreads: 16, words: 90 },
    ],
    interviewFocus: [
      'who the child becomes while reading',
      'what that character wants, in words a five-year-old would use',
      'the repeated line or refrain',
      'the funniest and the scariest moment',
      'what the final page turn reveals',
      'what the pictures show that the words do not say',
    ],
  },
};

export const kindOf = (meta) => KINDS[meta?.kind] || KINDS.novel;
export const isPicture = (meta) => kindOf(meta).id === 'picture';

export function kindList() {
  return Object.values(KINDS).map(({ id, label, hint, illustrated }) => ({ id, label, hint, illustrated }));
}

// Age band drives spread count and word budget for picture books.
export function ageBand(meta) {
  const k = kindOf(meta);
  if (!k.ages) return null;
  return k.ages.find((a) => a.id === meta?.ageBand) || k.ages[1];
}

// How many units to aim for, and how many words in each.
export function targets(meta) {
  const k = kindOf(meta);
  const band = ageBand(meta);
  return {
    units: band ? band.spreads : k.targetUnits,
    unitWords: band ? band.words : k.unitWords,
    unit: k.unit,
    units_: k.units,
  };
}
