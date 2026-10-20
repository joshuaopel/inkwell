# Inkwell live demo checklist

## The day before

- Pull the current `main` branch and run `npm install`.
- Start Ollama and confirm `gemma4:12b` appears in `ollama list`.
- Run `npm test`. The deterministic suite must pass before using a real model.
- Start Inkwell with `npm start` and open `http://localhost:4321`.
- Create a disposable demo book and complete at least three interview answers.
- Keep the captured-prompt visual from `promo/example-output-prompt-capture.png` open as a fallback.
- Keep the case-study PDF available locally; do not depend on venue Wi-Fi.

## The four-minute demonstration

### 1. Establish the promise — 30 seconds

Show the premise and Story Compass.

Say:

> Inkwell does not begin by writing for you. It interviews you across the whole idea so the outline is built from your decisions rather than the model's defaults.

### 2. Answer one question — 45 seconds

Give a concrete answer containing a person, object, place and cost. Point out that the transcript is saved and the next question is generated from all of it.

### 3. Show breadth — 45 seconds

Point to the checked compass dimensions and the highlighted next dimension.

Say:

> A question can sound clever and still be wrong for the product. If it keeps drilling into conflict while relationships and world are empty, it is a good question in the wrong place.

### 4. Show the boundary evidence — 60 seconds

Use the captured-prompt visual. Explain that the stand-in model records the actual HTTP request. Locate the transcript, tone or running summary in the captured request.

Say:

> The settings screen proves what the user selected. This captured request proves what the model received.

### 5. Show the output chain — 45 seconds

Build or display an outline. Find one distinctive interview fact inside a chapter, then show it in the Story Bible.

Say:

> We are preserving a chain of custody from the author's answer to the planning artifacts and finally to the writing context.

### 6. Land the lesson — 20 seconds

> First test whether AI received the right assignment. Then test whether it produced a good answer. If you only inspect the final prose, a capable model can make broken plumbing look finished.

## If the model is slow

- Do not wait silently. Explain that local inference is running on the presentation machine without sending the manuscript to a cloud service.
- Move to the captured-prompt image after ten seconds and continue the testing story.
- Return to the live result when it arrives.

## If the model fails

- Show the visible error as part of the product story: failure should be observable, not disguised as success.
- Use the prepared demo book to show the completed interview and outline.
- Run `npm test` in a terminal only if the audience wants technical evidence. The commercial narrative should stay in the product.

## Final pre-stage check

- Ollama running.
- Inkwell running on port 4321.
- Correct model selected.
- Browser zoom at 100%.
- Demo book loaded.
- Captured-prompt visual open.
- Case-study PDF open locally.
- Notifications muted.
