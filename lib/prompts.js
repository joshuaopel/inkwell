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
export function nextQuestionMessages({ premise, genre, pov, tense, transcript }) {
  const convo = (transcript || [])
    .map((m) => `${m.role === 'user' ? 'AUTHOR' : 'YOU'}: ${m.content}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You are a developmental editor interviewing an author about the book they want to write. You ask ONE sharp question at a time, specific to what they have already told you. Never ask something they have effectively answered. Respond with STRICT JSON only.',
    },
    {
      role: 'user',
      content: `Premise:\n"""${premise || '(not given yet)'}"""\nGenre: ${genre || 'unspecified'}. POV: ${pov}. Tense: ${tense}.

Conversation so far:
${convo || '(nothing yet — this is your opening question)'}

Ask the single most useful next question. Aim at whichever of these is still weakest: the protagonist's want vs. need, the inciting incident, the antagonistic force, the midpoint reversal, the climax, the ending's cost, tone, or setting. Make it specific to THIS story — reference their own details back at them.

Also name which structural element you're probing, in two or three words.

Return JSON: {"question":"...","probing":"..."}`,
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
