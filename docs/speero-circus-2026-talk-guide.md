# Inkwell at Speero Circus Austin 2026

## The talk in one sentence

Inkwell taught me that an AI product can produce a convincing answer while still failing its actual job, so I stopped judging only the output and started testing the entire chain from author intent to the exact prompt received by the model.

## The opening

Lead with the failure, not the feature list:

> I shipped two features that looked finished: book tone and a running story summary. The controls worked. The data saved. The prose even looked plausible. But when I replaced the model with a stand-in that recorded the exact request, I discovered that the tone was not reaching writing prompts and the summary workflow was not supplying useful memory. The UI worked. The model never got the message.

Then state why this matters to everyone building with AI:

> Generative systems are unusually good at hiding broken plumbing. A model can improvise a respectable answer even when the information your product promised to use is missing.

## The product context

Keep this section short. Inkwell is the example, not the headline.

- Cloud writing tools created token anxiety: experimentation felt metered, and monthly cost did not feel proportional to the output.
- Authors wanted help discovering details, not a machine impersonating their voice.
- Three author interviews pointed to the same gap: the initial idea often arrives before motives, relationships, rules, consequences, and connective tissue.
- Inkwell therefore interviews the author one question at a time, stores the answers, builds an outline and Story Bible from them, and sends bounded context to a local model.
- The product owns memory and structure. The model performs one job at a time.

Useful line:

> Have AI build you the calculator instead of asking it to be the calculator every time.

## What changed after Game Foundry and Hatbox

Game Foundry and Hatbox reinforced four practices that now shape Inkwell's validation:

1. **Define an outcome contract before asking the model.** A fluent answer is not the contract. For the interview, the next response must be one usable question assigned to one of seven story dimensions: character, relationships, conflict, world, structure, meaning, or voice.
2. **Keep model jobs bounded.** The interview model chooses the next useful question. The outline model structures the recorded findings. The writing model produces prose from the assembled context. One request should not be expected to remember and perform the entire product.
3. **Capture evidence at system boundaries.** Inspect the actual provider request, not the settings screen or the code that was supposed to assemble it.
4. **Verify observable outcomes.** Hatbox does not call a game feature complete because code was generated; it compiles it and tests behavior. Inkwell should not call an interview successful because the questions sound thoughtful; it must prove that the findings reach the outline, Story Bible, and writing context.

## The key distinction: good results versus right results

### A good result

A good result sounds polished, creative, or emotionally convincing. This is a subjective quality judgment.

Example: the model writes an atmospheric paragraph about a harbor.

### The right result

The right result satisfies the product's explicit obligations.

For Inkwell, that means:

- it preserves the author's named characters, relationships, constraints, and turning points;
- it asks across the whole story rather than repeatedly drilling into one attractive detail;
- it carries those findings into the outline and Story Bible;
- it sends the chosen tone and current story memory to the writing model;
- it respects point of view, tense, chapter beats, local prose, and any deliberate context settings;
- it returns the expected structure so the product can safely use it.

A result can be good but wrong: beautiful prose in the wrong voice, a clever question in a dimension already exhausted, or a clean outline that silently drops the author's most important relationship.

A result can also be right but not yet good: it may contain every required fact and follow the correct structure, while still needing stronger language or pacing. That is a model-quality or editorial problem, not broken product wiring.

Useful line:

> First prove that the model received the right assignment. Then judge how well it performed it.

## How the current validation works

### 1. Prompt-contract tests

These inspect the prompt builders directly. They verify that:

- every interview dimension is present;
- the previous question carries its dimension label;
- the author's answer is preserved;
- the prompt prevents consecutive rabbit-hole questions while major dimensions remain open;
- interview findings appear in both the outline request and Story Bible request;
- book tone, Story Bible facts, running summary, chapter beats, and nearby prose are placed in their intended context layers.

### 2. A stand-in Ollama server

The test starts a tiny local server that speaks Ollama's protocol. Inkwell believes it is talking to a model. The stand-in records the request body and returns a fixed response.

This lets the test assert facts such as:

- the correct model was selected;
- JSON mode was requested for the interview;
- the large planning context window was sent;
- the complete transcript and breadth rules crossed the provider boundary;
- tone and running memory crossed the provider boundary during writing;
- streaming output still traveled back through Inkwell correctly.

No real model is required, so the result is deterministic and inexpensive.

### 3. Result-contract validation and repair

Inkwell normalizes the interview dimension to the seven supported labels. It also checks whether the model revisited any covered dimension while other dimensions remain open. If the answer violates either rule, Inkwell sends one focused repair request explaining the exact contract failure. If the second response still fails, the API rejects it instead of quietly presenting unverifiable output as success.

This safeguard came from a real release check with `gemma4:12b`: the model asked a specific, intelligent question about the royal surveyor, but it pursued conflict immediately after a conflict question. The result sounded good and was wrong for the breadth-first interview. That failure became a test and a bounded repair path.

After the safeguard was added, the same live scenario repaired itself: the model moved to `world` and asked what physical traits and cultural customs define the geography Mara is changing. Treat this as a useful spot check, not a benchmark; the deterministic test is what guarantees the repair path itself.

### 4. Human and scenario evaluation

Automated contracts prove wiring and required facts. They do not prove that a question is insightful or prose is beautiful. For that, use a small fixed set of story scenarios and score the results against a rubric:

- coverage: did the interview cross the major dimensions?
- novelty: did it avoid asking what was already answered?
- specificity: did each question reflect this story's details?
- usefulness: did the answer unlock a planning decision?
- fidelity: did the outline preserve the author's facts and priorities?
- prose quality: after the above pass, is the writing effective?

Run the same scenarios when prompts or models change. Compare scores and inspect failures rather than selecting a few impressive outputs.

## A simple live demo

1. Show an Inkwell interview with two or three answers.
2. Point to the Story Compass moving across dimensions.
3. Show the captured provider request and locate the exact author answer inside it.
4. Show the same findings inside the outline or Story Bible request.
5. Show tone and “story so far” inside a captured writing request.
6. Change the stand-in response to use an invalid dimension such as `interesting detail`; run the test and show that Inkwell rejects it.

Narration:

> The stand-in is intentionally boring. It is valuable because it makes the invisible handoff observable. I am not testing whether this fake model writes a good novel. I am testing whether Inkwell keeps its promise about what the real model will receive and what shape it must return.

## What the tests establish—and what they do not

### Verified

- The interview prompt receives the premise, transcript, existing dimension labels, and breadth-first rules.
- Interview findings are included in the prompts that create the outline and Story Bible.
- Writing requests include tone and current story memory when those settings are enabled.
- The local Ollama protocol path carries those values end to end.
- Invalid interview result labels are rejected.

### Not established by these tests alone

- That every supported local model asks equally insightful questions.
- That generated prose is publishable without author judgment.
- That a seven-dimension label guarantees a useful question.
- That a fact appearing in a prompt guarantees the model will use it correctly.

Those are evaluation questions. They require repeated scenarios, rubrics, model comparisons, and human editorial review.

## Closing

> The lesson was not “write a better prompt.” The lesson was to make the AI system observable. Test the request, validate the contract, preserve the evidence, and only then evaluate the creativity. If we judge only the final answer, a capable model can make a broken product look finished.

## Short Q&A answer for developers

> We run ordinary unit tests on prompt construction, then replace Ollama with a protocol-compatible local stub. The application sends its real HTTP request to that stub, which captures the exact model, options, messages, and streaming mode. We assert that interview findings, tone, summary, chapter plan, and local prose are present at the model boundary. The stub returns deterministic JSON or NDJSON so we can test the return path and reject responses that violate the product contract. Real-model scenario evaluations come after those deterministic checks, because they measure quality rather than wiring.
