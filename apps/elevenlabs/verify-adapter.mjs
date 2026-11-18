import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAdapter } from './adapter.mjs';

const secret = 'synthetic-local-test-secret-0123456789';
const calls = [];
const server = createAdapter({ token: 'mock-token', secret, request: async (url, options) => {
  assert.equal(options.headers.Authorization, 'Bearer mock-token');
  calls.push(new URL(url).pathname);
  if (url.endsWith('/sessions')) return Response.json({ id: 'mock-id' }, { status: 201 });
  const { text } = JSON.parse(options.body);
  if (text === 'fail') return new Response('event: error\ndata: {"type":"error"}\n\n');
  if (text === 'expired') return new Response(null, { status: 401 });
  return new Response(new ReadableStream({ start(controller) {
    for (const part of ['event: text\ndata: {"type":"te', 'xt","delta":"Two words"}\n\n',
      'event: done\ndata: {"type":"done","session_ended":' + (text === 'end') + '}\n\n']) {
      controller.enqueue(new TextEncoder().encode(part));
    }
    controller.close();
  }}));
}});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = 'http://127.0.0.1:' + server.address().port + '/ask';
const ask = (question, id = 'conv_1', key = secret) =>
  fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key },
    body: JSON.stringify({ question, conversation_id: id }) });
try {
  assert.equal((await ask('hello', 'conv_1', 'wrong')).status, 401);
  assert.equal((await ask('')).status, 400);
  assert.deepEqual(await (await ask('hello')).json(), { answer: 'Two words' });
  assert.equal((await ask('fail')).status, 502);
  assert.equal((await ask('follow up')).status, 200);
  assert.equal((await ask('end')).status, 200);
  assert.equal(calls.filter(path => path.endsWith('/sessions')).length, 1);
  assert.equal((await ask('hello')).status, 200);
  assert.equal((await ask('hello', 'conv_2')).status, 200);
  assert.equal(calls.filter(path => path.endsWith('/sessions')).length, 3);
  assert.equal((await ask('expired', 'conv_2')).status, 503);
  console.log('Passed: authorization, input validation, split SSE frames, follow-ups, stream errors, session rollover, expired WorkOS token.');
} finally {
  server.close();
}
