import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAdapter } from './adapter.mjs';

const secret = 'local-synthetic-test-secret-0123456789';
const calls = [];
let turn;
let session = 0;
let memory;
const server = createAdapter({
  token: 'fake-token', secret,
  request: async (url, options) => {
    const path = new URL(url).pathname.replace('/day13/api', '');
    calls.push([options.method, path]);
    if (path === '/sessions') return Response.json({ id: 'test-' + ++session }, { status: 201 });
    if (path.endsWith('/end')) {
      memory = turn;
      return Response.json({}, { status: 202 });
    }
    if (options.method === 'GET') return Response.json({ reflection_status: 'done' });
    turn = JSON.parse(options.body).text;
    const delta = turn.endsWith('?') ? memory : 'Understood.';
    return new Response('data: ' + JSON.stringify({ type: 'text', delta }) +
      '\n\ndata: {"type":"done","session_ended":false}\n\n');
  },
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
const ask = (id, content, stream) => fetch(url, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
  body: JSON.stringify({ stream, messages: [
    { role: 'system', content: 'DAY13_CALL_ID=' + id },
    { role: 'user', content },
  ] }),
});
try {
  const first = await ask('conv_first', 'Meal prep is on Sunday.', true);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Understood\.[\s\S]*\[DONE\]/);
  assert.equal(turn, 'Meal prep is on Sunday.');
  const second = await ask('conv_second', 'What day is meal prep?', false);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, 'Meal prep is on Sunday.');
  assert.deepEqual(calls, [
    ['POST', '/sessions'], ['POST', '/sessions/test-1/turns'],
    ['POST', '/sessions/test-1/end'], ['GET', '/sessions/test-1'],
    ['POST', '/sessions'], ['POST', '/sessions/test-2/turns'],
  ]);
  console.log('Passed: automatic turn write, prior-call filing, and recall in a fresh call against a mocked brain.');
} finally {
  server.close();
}
