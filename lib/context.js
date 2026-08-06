// The anti-amnesia engine. Every generation request is assembled from THREE
// layers of context so the model always knows where it is in the book:
//   1. Whole-book   — title, genre, synopsis, style, and a running summary
//                     of everything that has happened so far.
//   2. Chapter      — the current chapter's outline summary + beats.
//   3. Local        — the immediate window of prose around the cursor.
// Plus the relevant Story Bible entries (characters/locations) so nothing
// contradicts what has already been established.

import { targets } from './kinds.js';

function bibleBlock(bible) {
  const lines = [];
  if (bible.characters?.length) {
    lines.push('CHARACTERS:');
    for (const c of bible.characters) {
      // `look` is the locked physical description illustrated books carry, so
      // the words and the pictures agree about who this is.
      const look = c.look ? ` Looks like: ${c.look}` : '';
      lines.push(`- ${c.name}${c.role ? ` (${c.role})` : ''}: ${c.description || ''}${c.arc ? ` Arc: ${c.arc}` : ''}${look}`);
    }
  }
  if (bible.locations?.length) {
    lines.push('LOCATIONS:');
    for (const l of bible.locations) lines.push(`- ${l.name}: ${l.description || ''}`);
  }
  if (bible.lore?.length) {
    lines.push('LORE / RULES:');
    for (const l of bible.lore) lines.push(`- ${typeof l === 'string' ? l : `${l.name}: ${l.description || ''}`}`);
  }
  if (bible.themes?.length) lines.push(`THEMES: ${bible.themes.join(', ')}`);
  return lines.join('\n');
}

export function systemPrompt(meta, bible) {
  // A picture book is a different job entirely: a few dozen words meant to be
  // said out loud, sitting next to a picture that carries the other half. Told
  // to "write publishable literary prose" a model produces a page of novel, so
  // it gets its own rules rather than a softened version of these.
  if (meta.kind === 'picture') {
    return [
      'You are Inkwell, an experienced picture-book author working with an author on a book for young children.',
      'The words are read ALOUD by an adult to a child, and they share the page with a picture.',
      'Hard rules:',
      '- Very few words. A spread is a line or two, not a paragraph. Every word earns its place.',
      '- Plain, sayable, rhythmic language. Say each line in your head before you write it.',
      '- Never describe what the picture already shows. The words and the picture carry different halves.',
      '- End on a reason to turn the page.',
      '- No moral, no lesson, no talking down.',
      '- Write ONLY the words that appear on the page. No preamble, no notes, no headings, no markdown fences, no stage directions.',
      bible.tone ? `- The book's tone, which every line must sit inside: ${bible.tone}` : '',
      bible.styleGuide ? `- Style guide from the author: ${bible.styleGuide}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    'You are Inkwell, an elite novelist collaborating with an author.',
    'You write publishable literary prose in the author\'s established voice.',
    'Hard rules:',
    `- Point of view: ${meta.pov}. Tense: ${meta.tense}. Never break them.`,
    '- Never contradict the Story Bible, the synopsis, or prose already written.',
    '- Show, don\'t tell. Concrete sensory detail over summary. Vary sentence rhythm.',
    '- Write ONLY the prose requested. No preamble, no notes, no "Here is", no headings, no markdown fences.',
    bible.tone ? `- The book's tone, which every sentence must sit inside: ${bible.tone}` : '',
    bible.styleGuide ? `- Style guide from the author: ${bible.styleGuide}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Take the last ~N words of prose so the model has the immediate runway
// without blowing the context window.
function tailWords(text, n) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return '…' + words.slice(-n).join(' ');
}

function headWords(text, n) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return words.slice(0, n).join(' ') + '…';
}

// Passage-replacing actions splice their output back between the surrounding
// text, so the model must be told not to restate it or close a sentence early.
const SPLICE_RULE =
  'SPLICING RULE: Your output replaces ONLY the marked passage and is inserted verbatim between the text before and the text after. Do NOT repeat any words from the surrounding text. Match the surrounding grammar, capitalization and punctuation so the whole reads as one continuous passage: if the passage begins mid-sentence, do not start a new sentence or repeat the subject; if it ends mid-sentence, do not add a closing period.';

// Build the big user message that carries all three context layers.
// action: 'continue' | 'rewrite' | 'expand' | 'describe'
export function buildWriteMessages({
  meta, bible, chapter, priorText, followingText, selection, instruction, action,
  notes, previousAttempt, localWords = 350, includeBible = true, includeSummary = true,
}) {
  const isSplice = action === 'rewrite' || action === 'expand' || action === 'revise';
  const picture = meta.kind === 'picture';
  const { unitWords } = targets(meta);
  const parts = [];

  parts.push(picture
    ? `# BOOK\nTitle: ${meta.title}\nA picture book. Each unit is one spread — two facing pages, one picture, a line or two of text.`
    : `# BOOK\nTitle: ${meta.title}\nGenre: ${meta.genre || 'unspecified'}`);
  if (meta.synopsis) parts.push(`Synopsis: ${meta.synopsis}`);

  const bb = includeBible ? bibleBlock(bible) : '';
  if (bb) parts.push(`# STORY BIBLE\n${bb}`);

  if (includeSummary && bible.runningSummary) parts.push(`# STORY SO FAR\n${bible.runningSummary}`);

  if (picture && bible.refrain) parts.push(`# THE REFRAIN\nThis line repeats through the book: "${bible.refrain}"`);

  if (chapter) {
    const beats = chapter.beats?.length ? `\nBeats to hit:\n${chapter.beats.map((b) => `- ${b}`).join('\n')}` : '';
    // On a spread, what the picture shows is context the words must NOT repeat.
    const art = picture && chapter.art ? `\nThe picture on this spread shows: ${chapter.art}\nDo not put any of that into the words.` : '';
    parts.push(`# CURRENT ${picture ? 'SPREAD' : 'CHAPTER'}: ${chapter.title}\n${chapter.summary || ''}${beats}${art}`);
  }

  if (priorText) parts.push(`# TEXT IMMEDIATELY BEFORE (do not repeat it)\n${tailWords(priorText, localWords)}`);
  if (isSplice && followingText) parts.push(`# TEXT IMMEDIATELY AFTER (do not repeat it)\n${headWords(followingText, 120)}`);

  let task;
  if (action === 'continue' && picture) {
    // Word budgets on a spread are tiny, and a model asked for "200-400 words"
    // will happily bury a picture book under a page of novel.
    task = priorText
      ? `# TASK\nFinish this spread. There are about ${unitWords} words on a whole spread, so add only what is still missing — often a single line. Do not start the next spread. ${instruction ? `Author's direction: ${instruction}` : ''}`
      : `# TASK\nWrite the words for this spread: about ${unitWords} words, and fewer is better. End on a reason to turn the page. Output only the words that are printed. ${instruction ? `Author's direction: ${instruction}` : ''}`;
  } else if (action === 'continue') {
    task = `# TASK\nContinue the chapter seamlessly from where the text above ends. Write the next 200–400 words of prose, advancing toward the chapter's beats. ${instruction ? `Author's direction: ${instruction}` : ''}`;
  } else if (action === 'rewrite') {
    task = `# SELECTED PASSAGE TO REWRITE\n${selection}\n\n# TASK\nRewrite the selected passage. ${instruction || 'Improve the prose while preserving meaning and continuity.'} Output only the rewritten passage.`;
  } else if (action === 'expand') {
    task = `# SELECTED PASSAGE TO EXPAND\n${selection}\n\n# TASK\nExpand the selected passage with more sensory detail and depth, keeping the same events. ${instruction || ''} Output only the expanded passage.`;
  } else if (action === 'revise') {
    // The author's editorial notes are directives, not suggestions.
    const noteBlock = `# THE AUTHOR'S NOTES\n${notes || instruction || 'Improve this passage.'}`;
    if (previousAttempt) {
      task = `# ORIGINAL PASSAGE\n${selection}\n\n# YOUR PREVIOUS REVISION\n${previousAttempt}\n\n${noteBlock}\n\n# TASK\nProduce a NEW revision that addresses the author's latest notes. Keep what was working in your previous attempt; fix only what the notes flag. Stay continuous with the surrounding text. Output only the revised passage — no commentary, no explanation of changes.`;
    } else {
      task = `# PASSAGE TO REVISE\n${selection}\n\n${noteBlock}\n\n# TASK\nRewrite the passage so it satisfies every note. Treat the notes as instructions from your editor — follow them exactly, even if you would have chosen differently. Preserve established plot facts and continuity with the surrounding text unless a note explicitly says to change them. Match the author's voice. Output only the revised passage — no commentary.`;
    }
  } else if (action === 'describe') {
    task = `# TASK\nWrite a vivid descriptive passage to insert at the cursor. ${instruction || 'Describe the current setting or a character in rich detail.'} Output only the prose.`;
  } else {
    task = `# TASK\n${instruction || 'Continue.'}`;
  }
  parts.push(task);
  if (isSplice) parts.push(SPLICE_RULE);

  return [{ role: 'user', content: parts.join('\n\n') }];
}
