import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Inkwell exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('Timed out waiting for Inkwell');
}

test('captured provider requests prove the interview and writing context cross the model boundary', async (t) => {
  const captured = [];
  let interviewCalls = 0;
  const stubPort = await freePort();
  const appPort = await freePort();
  const booksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkwell-boundary-'));

  const stub = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'stand-in:latest' }] }));
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      res.statusCode = 404;
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    captured.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (body.stream) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'The harbor moved overnight.' }, done: true }) + '\n');
    }
    interviewCalls += 1;
    const suggestion = interviewCalls === 1
      ? { question: 'What else does Mara want from restoring her name?', probing: 'character' }
      : { question: 'Who benefits when Mara changes the coast?', probing: 'relationships' };
    return res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(suggestion) } }));
  });
  await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(appPort),
      INKWELL_HOST: '127.0.0.1',
      OLLAMA_HOST: `http://127.0.0.1:${stubPort}`,
      INKWELL_BOOKS: booksDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill();
    stub.close();
    await fs.rm(booksDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${appPort}`;
  await waitFor(`${base}/api/models`, child);

  const next = await fetch(`${base}/api/plan/next-question`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'stand-in:latest',
      premise: 'A cartographer discovers her maps rewrite the real world.',
      genre: 'fantasy', pov: 'Third person limited', tense: 'Past', kind: 'novel',
      transcript: [
        { role: 'assistant', content: 'What does Mara want?', probing: 'character' },
        { role: 'user', content: 'To restore her family name.' },
      ],
    }),
  });
  assert.equal(next.status, 200);
  assert.deepEqual(await next.json(), {
    question: 'Who benefits when Mara changes the coast?', probing: 'relationships',
  });

  assert.equal(interviewCalls, 2);
  const interviewRequest = captured[0];
  assert.equal(interviewRequest.model, 'stand-in:latest');
  assert.equal(interviewRequest.format, 'json');
  assert.equal(interviewRequest.stream, false);
  assert.ok(interviewRequest.options.num_ctx >= 16_384);
  assert.match(interviewRequest.messages[1].content, /YOU \[character\]: What does Mara want\?/);
  assert.match(interviewRequest.messages[1].content, /AUTHOR: To restore her family name/);
  assert.match(interviewRequest.messages[1].content, /Prefer an uncovered or thin dimension/);
  const repairRequest = captured[1];
  assert.match(repairRequest.messages.at(-1).content, /violates the interview contract/);
  assert.match(repairRequest.messages.at(-1).content, /revisited "character"/);

  const write = await fetch(`${base}/api/write`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'stand-in:latest',
      meta: { title: 'The Cartographer', genre: 'fantasy', pov: 'Third person limited', tense: 'Past' },
      bible: {
        tone: 'Precise, restrained, and faintly uncanny.',
        runningSummary: 'Mara changed the harbor; only she remembers the old coast.',
        characters: [{ name: 'Mara', role: 'protagonist', description: 'A disgraced mapmaker.' }],
      },
      chapter: { title: 'The Missing Harbor', summary: 'Mara tests the map again.', beats: ['The coast moves'] },
      priorText: 'She unfolded the vellum on the wet stones.', action: 'continue',
    }),
  });
  assert.equal(write.status, 200);
  assert.match(await write.text(), /The harbor moved overnight/);

  const writeRequest = captured.at(-1);
  assert.equal(writeRequest.stream, true);
  assert.match(writeRequest.messages[0].content, /Precise, restrained, and faintly uncanny/);
  assert.match(writeRequest.messages[1].content, /# STORY SO FAR/);
  assert.match(writeRequest.messages[1].content, /only she remembers the old coast/);
  assert.match(writeRequest.messages[1].content, /# CURRENT CHAPTER: The Missing Harbor/);
  assert.match(writeRequest.messages[1].content, /# TEXT IMMEDIATELY BEFORE/);
});

test('the API rejects a plausible question that violates the interview result contract', async (t) => {
  const stubPort = await freePort();
  const appPort = await freePort();
  const booksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkwell-invalid-'));
  let calls = 0;
  const stub = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [] }));
    for await (const _ of req) {}
    calls += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ question: 'Tell me more about that.', probing: 'interesting detail' }) } }));
  });
  await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, PORT: String(appPort), INKWELL_HOST: '127.0.0.1', OLLAMA_HOST: `http://127.0.0.1:${stubPort}`, INKWELL_BOOKS: booksDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); stub.close(); await fs.rm(booksDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${appPort}`;
  await waitFor(`${base}/api/models`, child);
  const response = await fetch(`${base}/api/plan/next-question`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'stand-in:latest', premise: 'A city forgets its dead.', transcript: [] }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /invalid interview question/i);
  assert.equal(calls, 2);
});
