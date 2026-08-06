// Prompt builders for Plan Mode (the Socratic interview → outline → bible flow)
// and for keeping the "story so far" summary fresh. These ask the model for
// strict JSON; server.js calls them with Ollama's format:'json' mode and parses
// defensively.

export function interviewMessages({ premise, genre, pov, tense }) {
  return [
    {
      role: 'system',
      content:
        'You are a developmental editor helping an author plan a book. You ask sharp, specific questions that surface the key creative decisions. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `The author's premise:\n"""${premise}"""\nGenre: ${genre || 'unspecified'}. POV: ${pov}. Tense: ${tense}.

Ask 6–8 questions that will give you what you need to build a strong chapter-by-chapter outline. Cover: the protagonist and their want vs. need, the inciting incident, the antagonistic force, the midpoint turn, the climax, the ending/transformation, tone, and setting. Make each question specific to THIS premise, not generic.

Return JSON of exactly this shape:
{"questions":[{"id":"q1","question":"...","why":"one short phrase on what this unlocks"}]}`,
    },
  ];
}

export function outlineMessages({ premise, genre, pov, tense, answers }) {
  const qa = (answers || [])
    .map((a) => `Q: ${a.question}\nA: ${a.answer || '(left blank — you decide)'}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You are a novelist and structural editor. You design tight, causally-linked chapter outlines built on a four-act spine. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `The premise sets the world. But the AUTHOR'S ANSWERS below are what this book is actually ABOUT — the specific characters, relationships, secrets, and turning points they want at the center of the story. The outline must be built around these answers, not just the premise. If the premise is high-concept but the answers are about two people, the book is about those two people.

PREMISE (the world/setting):
"""${premise}"""
Genre: ${genre || 'unspecified'}. POV: ${pov}. Tense: ${tense}.

THE AUTHOR'S ANSWERS (the actual story — weight these heavily):
${qa || '(none provided — make strong choices yourself)'}

Requirements:
- Every distinct thread, character, and turning point the author described in their answers MUST appear as chapters. Do not drop them in favor of generic plot.
- The protagonist, their key relationship(s), and the specific reveals/confrontations the author named should drive the spine.
- Produce: a one-paragraph synopsis that reflects the author's answers, four evocative act titles, and a chapter-by-chapter outline (12–20 chapters). Each chapter needs a title, a 2–3 sentence summary, 3–5 concrete beats (events, in order), and its act number (1–4).
- Act titles should be evocative names, not "Act I" — e.g. "The Cover", "The Discrepancy", "The Gauntlet".

Return JSON of exactly this shape:
{"synopsis":"...","acts":[{"n":1,"title":"..."},{"n":2,"title":"..."},{"n":3,"title":"..."},{"n":4,"title":"..."}],"chapters":[{"title":"...","summary":"...","beats":["..."],"act":1}]}`,
    },
  ];
}

// Refine an EXISTING outline against the author's structural critique. Unlike a
// full rebuild, this starts from the current chapters and changes only what the
// notes ask — reorder, split, merge, add, remove, or re-pace.
export function refineOutlineMessages({ premise, genre, pov, tense, synopsis, answers, currentOutline, notes, targetChapters }) {
  const actLines = (currentOutline.acts || [])
    .map((a, i) => `Act ${i + 1}: ${a.subtitle || a.title || ''}`).join('\n');
  const chLines = (currentOutline.chapters || [])
    .map((c, i) => `${i + 1}. ${c.title}${c.summary ? ` — ${c.summary}` : ''}`).join('\n');
  const qa = (answers || [])
    .map((a) => `Q: ${a.question}\nA: ${a.answer || ''}`).join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You are a structural editor revising a novelist\'s chapter outline. You keep everything that works and change ONLY what the author\'s notes ask for. You never lose established story threads. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `PREMISE: """${premise}"""
Genre: ${genre || 'unspecified'}. POV: ${pov}. Tense: ${tense}.
${synopsis ? `SYNOPSIS: ${synopsis}\n` : ''}
CURRENT ACTS:
${actLines || '(none)'}

CURRENT OUTLINE (${(currentOutline.chapters || []).length} chapters):
${chLines || '(none)'}
${qa ? `\nTHE STORY (from the author's planning answers — never contradict these):\n${qa}\n` : ''}
THE AUTHOR'S STRUCTURAL NOTES — apply these exactly:
"""${notes}"""
${targetChapters ? `\nTarget length: aim for about ${targetChapters} chapters.` : ''}

Rules:
- Satisfy every structural note. Reorder, split, merge, add, remove, or re-pace chapters as needed.
- PRESERVE chapters the notes don't touch: keep their exact titles and summaries so the author's work is retained. Only the chapters affected by the notes should change.
- Keep the story coherent and causally ordered. Keep four acts unless a note says otherwise.
- Every chapter needs a title, a 2–3 sentence summary, 3–5 concrete beats, and its act number (1–4).
- Chapter titles must be the title ONLY — never prefix them with a number (write "The Forged Coast", not "3. The Forged Coast").

Return JSON of exactly this shape:
{"acts":[{"n":1,"title":"..."},{"n":2,"title":"..."},{"n":3,"title":"..."},{"n":4,"title":"..."}],"chapters":[{"title":"...","summary":"...","beats":["..."],"act":1}]}`,
    },
  ];
}

// Plan mode as a conversation: given everything said so far, ask the ONE most
// useful next question. This drives the "Suggested next question" card.
export function nextQuestionMessages({ premise, genre, pov, tense, transcript, kind }) {
  const convo = (transcript || [])
    .map((m) => `${m.role === 'user' ? 'AUTHOR' : 'YOU'}: ${m.content}`)
    .join('\n');
  const picture = kind?.id === 'picture';
  const focus = (kind?.interviewFocus || [
    'the protagonist\'s want vs. need', 'the inciting incident', 'the antagonistic force',
    'the midpoint reversal', 'the climax', 'the ending\'s cost', 'tone', 'setting',
  ]).join(', ');

  return [
    {
      role: 'system',
      content: picture
        ? 'You are a picture-book editor interviewing an author. Picture books are read aloud to a small child by an adult, in one sitting, and the craft is in the page turn. You ask ONE short, warm, concrete question at a time, specific to what they have already told you. Never ask something they have effectively answered. Respond with STRICT JSON only.'
        : 'You are a developmental editor interviewing an author about the book they want to write. You ask ONE sharp question at a time, specific to what they have already told you. Never ask something they have effectively answered. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Premise:\n"""${premise || '(not given yet)'}"""\n${picture ? `Kind: picture book.` : `Genre: ${genre || 'unspecified'}. POV: ${pov}. Tense: ${tense}.`}

Conversation so far:
${convo || '(nothing yet — this is your opening question)'}

Ask the single most useful next question. Aim at whichever of these is still weakest: ${focus}. Make it specific to THIS story — reference their own details back at them.
${picture ? '\nRemember what a picture book needs: very few words, a character a child can be, something repeated they can join in with, and a last page turn worth waiting for. Ask about what the PICTURES will show as often as what the words will say.\n' : ''}
Also name what you're probing, in two or three words.

Return JSON: {"question":"...","probing":"..."}`,
    },
  ];
}

// ---------------------------------------------------------------- picture books

// The page plan: one entry per spread, each with the words that appear and a
// note on what the picture shows. The two must not say the same thing — that's
// the oldest rule in the form.
export function spreadPlanMessages({ premise, answers, spreads, wordsPerSpread, ageLabel }) {
  const qa = (answers || []).map((a) => `Q: ${a.question}\nA: ${a.answer || ''}`).join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You are a picture-book editor who plans books spread by spread. You know that the words and the pictures must carry different halves of the story, that a spread ends on a reason to turn the page, and that a repeated refrain is what makes a child ask for the book again. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Plan a picture book.

PREMISE:
"""${premise || '(none given)'}"""

WHAT THE AUTHOR TOLD ME:
${qa || '(nothing yet)'}

Format: ${ageLabel || 'picture book'}. Exactly ${spreads} spreads. About ${wordsPerSpread} words of text per spread — some spreads may be a single line, and at least one should be almost wordless and let the picture do the work.

Rules:
- The premise sets the world; the author's answers are what the book is actually about.
- Every spread ends on a reason to turn the page.
- The picture must show something the words do NOT state. Never describe the picture in the text.
- Use a repeated line if the answers suggest one, and bring it back changed at the end.
- Plain, sayable words. Read every line aloud in your head first.
- The last spread lands the feeling, not a moral.

For each spread give:
  "title"  a two or three word working label for the author, not printed
  "text"   the actual words that appear on the page
  "art"    one sentence on what the illustration shows, in plain language

Return JSON:
{"refrain":"...","synopsis":"one or two sentences","spreads":[{"n":1,"title":"...","text":"...","art":"..."}]}`,
    },
  ];
}

// A locked look for the book: one style line applied to every illustration, and
// a fixed physical description per character. This is the whole defence against
// a protagonist who changes shape between pages.
export function visualBibleMessages({ premise, answers, characters, brief }) {
  const qa = (answers || []).map((a) => `${a.question} -> ${a.answer || ''}`).join('\n');
  const names = (characters || []).map((c) => c.name).filter(Boolean).join(', ');
  return [
    {
      role: 'system',
      content:
        'You art-direct illustrated children\'s books. You write physical descriptions so specific and so repeatable that a different illustrator could draw the same character twice. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Set the look of this book.

PREMISE: ${premise || '(none)'}
${qa ? `\nFROM THE INTERVIEW:\n${qa}\n` : ''}
KNOWN CHARACTERS: ${names || '(none recorded yet)'}
${brief ? `\nTHE AUTHOR ASKS FOR: """${brief}"""\n` : ''}
Give:
- "style": ONE line naming medium, line quality and mood, to be repeated on every single illustration. Concrete and visual. Example shape: "soft watercolour with loose ink outlines, warm afternoon palette, generous white space".
- "palette": four or five colour names that recur.
- "characters": for each, a "look" of 15-25 words listing only fixed, drawable facts — species or age, body shape, hair, and above all ONE unmistakable item they always have. No emotions, no actions, no story.

Return JSON:
{"style":"...","palette":["..."],"characters":[{"name":"...","look":"..."}]}`,
    },
  ];
}

// Turn one spread into something an image model can actually render, with the
// locked style and character looks carried in verbatim.
export function illustrationMessages({ text, art, style, palette, looks, previous }) {
  return [
    {
      role: 'system',
      content:
        'You write prompts for text-to-image models. You describe what is visible and nothing else: subject, action, setting, framing, light. No narration, no feelings, no words-on-the-page, no camera brands, no artist names. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Write the illustration prompt for one spread of a picture book.

THE WORDS ON THIS SPREAD: """${text || '(wordless spread)'}"""
WHAT THE PICTURE SHOULD SHOW: ${art || '(decide from the words)'}

LOCKED STYLE, repeat it exactly: ${style || 'soft storybook illustration'}
PALETTE: ${(palette || []).join(', ') || 'warm and natural'}
CHARACTERS WHO MAY APPEAR — copy these descriptions word for word if the character is in this picture:
${(looks || []).map((c) => `- ${c.name}: ${c.look}`).join('\n') || '- (none recorded)'}
${previous ? `\nTHE PREVIOUS SPREAD'S PROMPT, for continuity of place and light:\n"""${previous}"""\n` : ''}
Build the prompt in this order: the character description verbatim, then what they are doing, then where, then framing and light, then the locked style at the end.

Keep it under 70 words. Do not mention text, letters, titles or speech bubbles.

Also give a short "negative" listing what must not appear.

Return JSON: {"prompt":"...","negative":"..."}`,
    },
  ];
}

export function bibleSeedMessages({ premise, genre, answers, synopsis }) {
  const qa = (answers || []).map((a) => `${a.question} -> ${a.answer || ''}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You extract a story bible from planning material. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Premise: ${premise}\nGenre: ${genre || ''}\nSynopsis: ${synopsis || ''}\nPlanning notes:\n${qa}

Extract the story bible. Include every named or implied character and location. Infer sensible details where needed.

Return JSON of exactly this shape:
{"characters":[{"name":"...","role":"protagonist|antagonist|supporting","description":"...","arc":"..."}],"locations":[{"name":"...","description":"..."}],"themes":["..."],"styleGuide":"one or two sentences describing the target prose style/tone"}`,
    },
  ];
}

// Ask the local model to art-direct the book: trim size, typeface, spacing,
// chapter openers, paper colour. Everything it can choose is enumerated in the
// prompt and re-validated server-side, because a 3B model will happily invent
// a font that doesn't exist. It returns ids, never CSS.
export function designMessages({ meta, bible, catalog, brief }) {
  const fonts = catalog.fonts.map((f) => `${f.id} (${f.label}, ${f.kind})`).join(', ');
  const trims = catalog.trims.map((t) => `${t.id} (${t.label})`).join(', ');
  const presets = catalog.presets.map((p) => `${p.id} — ${p.hint}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You are a book designer who sets interior pages for print. You choose type, trim and spacing that suit the book\'s genre and mood, and you justify choices in one sentence. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Design the interior pages for this book.

TITLE: ${meta.title || 'Untitled'}
AUTHOR: ${meta.author || 'unknown'}
GENRE: ${meta.genre || 'unspecified'}
PREMISE: ${meta.premise || '(none)'}
TONE: ${bible?.tone || '(none)'}
THEMES: ${(bible?.themes || []).join(', ') || '(none)'}
${brief ? `\nTHE AUTHOR ASKS FOR: """${brief}"""\n` : ''}
Pick ONLY from these values:
- trim: ${trims}
- font: ${fonts}
- align: justify | left
- firstLine: plain | smallcaps | dropcap | raised
- openerStyle: classic | modern | ornament | rule | plain
- numbering: arabic | roman | words | none
- runningHead: none | title | chapter | title-chapter | author-title
- folio: none | bottom-center | bottom-outer | top-outer
- texture: none | paper | linen | vignette
- closestPreset (the named look yours is nearest to):
${presets}

Rules:
- size is in points (9–14). leading is a line-height multiple (1.2–2.0).
- indent is the first-line indent in em (0–3). Use 0 only when you also set spacing above 0.
- margins are in inches; inner is the binding edge and should be the widest.
- tint is the paper colour and ink the text colour, both as #rrggbb. Keep contrast high and paper off-white unless the mood demands otherwise.
- Match the mood: a cosy novel is not set like a thriller, and an illustrated book needs wider outer margins.
- rationale: two short sentences, in plain language, on why this suits the book.

Return JSON of exactly this shape:
{"closestPreset":"classic","trim":"6x9","font":"garamond","size":11.5,"leading":1.5,"align":"justify","indent":1.2,"spacing":0,"firstLine":"dropcap","openerStyle":"classic","numbering":"roman","ornament":"❦","sceneBreak":"· · ·","runningHead":"title-chapter","folio":"bottom-center","margins":{"top":0.8,"bottom":0.85,"inner":0.9,"outer":0.65},"tint":"#f7f3ea","ink":"#221f1a","accent":"#8a6a3b","texture":"paper","rationale":"..."}`,
    },
  ];
}

// After a chapter is written/updated, refresh the running "story so far" summary
// so future chapters stay consistent without resending the whole manuscript.
export function summaryMessages({ previousSummary, newChapterTitle, newChapterText }) {
  return [
    {
      role: 'system',
      content:
        'You maintain a running plot summary for a novel-in-progress. Be concise and factual — track what happened, character states, and open threads. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Existing "story so far" summary:\n${previousSummary || '(none yet)'}\n\nNewly written chapter "${newChapterTitle}":\n"""${(newChapterText || '').slice(0, 6000)}"""\n\nReturn an updated running summary that folds in the new chapter. Keep it under 300 words.

Return JSON: {"summary":"..."}`,
    },
  ];
}
