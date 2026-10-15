import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bibleSeedMessages,
  INTERVIEW_DIMENSIONS,
  nextQuestionMessages,
  normalizeInterviewDimension,
  outlineMessages,
  validateInterviewSuggestion,
} from '../lib/prompts.js';
import { buildWriteMessages, systemPrompt } from '../lib/context.js';

test('the interview prompt carries the whole conversation and asks for breadth', () => {
  const messages = nextQuestionMessages({
    premise: 'A cartographer discovers her maps rewrite the real world.',
    genre: 'fantasy',
    pov: 'Third person limited',
    tense: 'Past',
    transcript: [
      { role: 'assistant', content: 'What does Mara want?', probing: 'character' },
      { role: 'user', content: 'To restore her family name, even if places disappear.' },
    ],
    kind: { id: 'novel', interviewFocus: ['the ending\'s cost'] },
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /Explore the whole idea before drilling deeper/);
  const prompt = messages[1].content;
  assert.match(prompt, /A cartographer discovers her maps rewrite the real world/);
  assert.match(prompt, /YOU \[character\]: What does Mara want\?/);
  assert.match(prompt, /AUTHOR: To restore her family name/);
  assert.match(prompt, /Do not ask two consecutive questions in the same dimension/);
  assert.match(prompt, /Do not chase an intriguing detail/);
  for (const dimension of INTERVIEW_DIMENSIONS) assert.match(prompt, new RegExp(`- ${dimension}`));
});

test('interview dimension labels are normalized to the product contract', () => {
  assert.equal(normalizeInterviewDimension('WORLD'), 'world');
  assert.equal(normalizeInterviewDimension('Character motivation'), 'character');
  assert.equal(normalizeInterviewDimension('plot mechanics'), '');
});

test('a fluent question is still rejected when it repeats the last dimension', () => {
  const transcript = [
    { role: 'assistant', content: 'What blocks Mara?', probing: 'conflict' },
    { role: 'user', content: 'The royal surveyor.' },
  ];
  const repeated = validateInterviewSuggestion({
    question: 'How does the royal surveyor threaten Mara?', probing: 'conflict',
  }, transcript);
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /repeated "conflict"/);

  const lateral = validateInterviewSuggestion({
    question: 'Who still remembers the coast with Mara?', probing: 'relationships',
  }, transcript);
  assert.equal(lateral.ok, true);
});

test('writing context contains tone, story memory, chapter obligations, and local prose', () => {
  const meta = { title: 'The Cartographer', genre: 'fantasy', pov: 'Third person limited', tense: 'Past' };
  const bible = {
    tone: 'Precise, restrained, and faintly uncanny.',
    styleGuide: 'Concrete images; no purple prose.',
    runningSummary: 'Mara changed the harbor and is now the only person who remembers the old shoreline.',
    characters: [{ name: 'Mara', role: 'protagonist', description: 'A disgraced mapmaker.' }],
  };
  const chapter = { title: 'The Missing Harbor', summary: 'Mara tests the map again.', beats: ['The coast moves', 'Her brother forgets'] };

  const system = systemPrompt(meta, bible);
  const user = buildWriteMessages({
    meta, bible, chapter, priorText: 'She unfolded the vellum on the wet stones.',
    action: 'continue', includeBible: true, includeSummary: true,
  })[0].content;

  assert.match(system, /Precise, restrained, and faintly uncanny/);
  assert.match(system, /Concrete images; no purple prose/);
  assert.match(user, /# STORY BIBLE/);
  assert.match(user, /# STORY SO FAR/);
  assert.match(user, /only person who remembers the old shoreline/);
  assert.match(user, /# CURRENT CHAPTER: The Missing Harbor/);
  assert.match(user, /- The coast moves/);
  assert.match(user, /# TEXT IMMEDIATELY BEFORE/);
});

test('story memory can be deliberately excluded without removing tone', () => {
  const meta = { title: 'Book', genre: 'fantasy', pov: 'First person', tense: 'Present' };
  const bible = { tone: 'Dry and intimate.', runningSummary: 'A secret that must not be sent.' };
  const system = systemPrompt(meta, bible);
  const user = buildWriteMessages({ meta, bible, action: 'continue', includeBible: true, includeSummary: false })[0].content;

  assert.match(system, /Dry and intimate/);
  assert.doesNotMatch(user, /A secret that must not be sent/);
  assert.doesNotMatch(user, /# STORY SO FAR/);
});

test('interview findings cross into both the outline and Story Bible requests', () => {
  const inputs = {
    premise: 'A cartographer discovers her maps rewrite the real world.',
    genre: 'fantasy', pov: 'Third person limited', tense: 'Past',
    answers: [
      { question: 'What does Mara want?', answer: 'Restore the Vale family name.' },
      { question: 'Who notices the changes?', answer: 'Her brother Iven remembers the old coast only in dreams.' },
      { question: 'What does success cost?', answer: 'Every corrected map erases one shared memory of their mother.' },
    ],
  };
  const outline = outlineMessages(inputs)[1].content;
  const bible = bibleSeedMessages({ ...inputs, synopsis: 'Mara remakes the coast and loses her family history.' })[1].content;

  for (const finding of [
    'Restore the Vale family name',
    'Her brother Iven remembers the old coast only in dreams',
    'Every corrected map erases one shared memory of their mother',
  ]) {
    assert.match(outline, new RegExp(finding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(bible, new RegExp(finding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(outline, /Every distinct thread, character, and turning point.*MUST appear as chapters/);
  assert.match(outline, /weight these heavily/i);
});
