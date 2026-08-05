# 🖋️ Inkwell

Your own local, private AI writing studio for novels & short stories. Runs entirely
on your machine against your own [Ollama](https://ollama.com) models — no API keys,
no per-word cost, nothing leaves your computer. Exports **KDP-ready EPUB** for Kindle.

Built as a smarter, personal alternative to Sudowrite. The difference is the
**scaffolding around the model**:

- **Plan mode** — a real conversation. Inkwell asks **one question at a time**, each
  written from everything you've already told it, and suggests the next one so you can
  **Ask this** or **Skip**. The transcript is saved, so you can leave and resume.
  When you're ready it builds a four-act outline **and** a story bible from the transcript.
- **Outline map** — your book as a node graph. Chapters are cards coloured by act,
  wired in reading order, and **draggable** (positions persist to disk). Toggle to
  **List view** for summaries and beats, or **Auto-arrange** to reset the layout.
  A live stats bar tracks total words, acts, average chapter length and pacing.
- **Workspace shell** — icon rail for Home / Outline / Notes / Bible / Cards / Export,
  a book-and-chapter sidebar, and a context panel showing the interview, a **memory
  snapshot** (characters, locations, themes, timeline) and a story-bible peek.
- **Anti-amnesia context engine** — every generation is assembled from three layers:
  the whole-book synopsis + running summary, the current chapter's beats, and the
  immediate paragraphs. It never loses the thread.
- **Story Bible** — characters, locations, themes, style. The single source of truth
  the AI is checked against so the story stays consistent.
- **Notes → revise → iterate** — select any passage, write real editorial notes on it
  ("cut the exposition, make her anger cold not loud, end on the door closing"), and get
  it rewritten. Not happy? Hit **More notes ↻** and give feedback on the revision itself —
  it keeps the original, its last attempt, and your new notes in view. Ten one-click
  preset notes (Tighten, Raise the tension, Deepen the POV…) for speed. Ctrl+Enter sends.
- **Edit-alongside, diff-first** — every rewrite shows as an inline word-level diff you
  accept/reject, like a code review for prose. You stay in control of your voice.
  Passages are replaced by exact offsets, and seams are cleaned automatically so a
  mid-sentence revision never leaves duplicated words or stray punctuation.
- **Refine the structure with notes** — critique the whole outline ("the middle act is
  rushed, split it"; "move the reveal earlier"; "aim for 18 chapters") and get a revised
  outline with a **before/after preview** (new / moved / kept chapters colour-coded).
  Or **Rebuild from interview** to fold newer answers into the whole plan. Both preserve
  any chapters you've already written.
- **Everything is a file** — each book is a folder of Markdown + JSON on disk.
  Portable, backup-able, git-able.

## Screenshots

The outline as a draggable, act-coloured node map, with a live interview panel and memory snapshot:

![Outline map](promo/01-outline-map.png)

Give a passage editorial notes and get a diff you accept or reject — a code review for prose:

![Notes → revise](promo/05-write-notes.png)

Critique the whole structure and preview the revision before applying it:

![Refine structure](promo/refine-structure.png)

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) running locally, with at least one model pulled.

Small models (like `qwen2.5:3b`) work for testing the flow, but for real prose pull
something bigger:

```bash
ollama pull llama3.1:8b
ollama pull qwen2.5:14b
ollama pull mistral-nemo
```

## Run

```bash
npm install
npm start
```

Then open **http://localhost:4321**. Pick your model in the top-right, create a book,
and start in Plan mode.

## Where your work lives

```
Inkwell/books/<book-id>/
  book.json      title, author, premise, POV, tense
  bible.json     characters, locations, themes, tone, style, running summary
  outline.json   acts + chapter structure + map positions
  plan.json      the interview transcript (so Plan mode can resume)
  notes.md       freeform project notes
  chapters/*.md  your actual prose
```

Books created before the outline-map rewrite still open fine — they inherit the
default four acts and auto-arrange on first view.

Back this folder up and you've backed up everything.

## Adding cloud models later (optional)

The provider layer in `lib/ollama.js` is pluggable. To add OpenAI / Anthropic /
OpenRouter, add an entry with the same `{ listModels, chatOnce, chatStream, health }`
shape and set `INKWELL_PROVIDER`. The rest of the app doesn't change.

## Settings

The gear icon opens a settings panel, saved to `settings.json` beside the `books/`
folder (not in browser storage, so it survives cache clears):

- **Model & generation** — default model, temperature, top-p, repeat penalty,
  context window, response length. These are passed straight to Ollama.
- **What the model is told** — how many words of surrounding prose to send, and
  whether to include the story bible and the running summary. Trim these if
  generations feel slow; everything here goes on *every* request.
- **Editor** — font size, line height, line width (in characters), spellcheck.
  Sliders preview live as you drag them.
- **Connection** — Ollama host, status, and a model refresh.

## Config

Environment variables (all optional):

- `PORT` — web server port (default `4321`)
- `OLLAMA_HOST` — Ollama URL (default `http://localhost:11434`)
- `INKWELL_BOOKS` — where books are stored (default `./books`)
