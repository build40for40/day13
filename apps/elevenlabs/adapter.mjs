import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const brainUrl = 'https://build40for40.com/day13/api';
const workosClientId = 'client_01M6E5ZDQ9XBYYE28XYN7H3XTJ';

function accessTokenProvider(accessToken, initialRefreshToken) {
  let refreshToken = initialRefreshToken;
  return async function getToken(signal) {
    if (!refreshToken) return accessToken;
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    if (claims.exp * 1000 > Date.now() + 30_000) return accessToken;

    const response = await fetch('https://api.workos.com/user_management/authenticate', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: workosClientId,
      }),
      signal,
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || !result.access_token) {
      throw new AdapterError(503, 'The brain needs a fresh WorkOS session.');
    }
    accessToken = result.access_token;
    refreshToken = result.refresh_token ?? refreshToken;
    return accessToken;
  };
}

class AdapterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readAnswer(response) {
  let pending = '';
  let answer = '';
  const stream = response.body.pipeThrough(new TextDecoderStream());
  for await (const chunk of stream) {
    pending += chunk;
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      if (event.type === 'text') answer += event.delta;
      if (event.type === 'error') throw new AdapterError(502, 'The brain could not answer.');
      if (event.type === 'done') {
        if (!answer.trim()) throw new AdapterError(502, 'The brain returned an empty answer.');
        return { answer: answer.trim(), ended: event.session_ended };
      }
    }
  }
  throw new AdapterError(502, 'The brain reply ended early.');
}

export function createAdapter({ token, refreshToken, secret, upstream = brainUrl, request = fetch }) {
  if (!token || !secret || secret.length < 32) {
    throw new Error('Set DAY13_WORKOS_ACCESS_TOKEN and DAY13_WEBHOOK_SECRET (at least 32 characters).');
  }
  const getToken = accessTokenProvider(token, refreshToken);
  let active;
  let busy = false;

  async function call(path, signal, body, method = 'POST') {
    const response = await request(upstream + path, {
      method,
      headers: { Authorization: 'Bearer ' + await getToken(signal), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 401) throw new AdapterError(503, 'The brain needs a fresh WorkOS session.');
    if (response.status === 409) throw new AdapterError(409, 'The brain session is closed or busy.');
    if (response.status === 429) throw new AdapterError(429, 'The brain has reached its daily limit.');
    throw new AdapterError(502, 'The brain is unavailable.');
  }

  async function filePreviousCall(session, signal) {
    const path = '/sessions/' + session.id;
    try {
      const ended = await call(path + '/end', signal);
      if (ended.status === 204) return;
      await ended.body?.cancel();
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = await call(path, signal, undefined, 'GET');
      const { reflection_status } = await response.json();
      if (reflection_status === 'done') return;
      if (reflection_status === 'failed') break;
      await delay(500, undefined, { signal });
    }
    throw new AdapterError(503, 'The previous call has not finished filing. Please try again shortly.');
  }

  async function ask({ conversation_id, question, continuous = false }) {
    if (busy) throw new AdapterError(409, 'Another question is in progress.');
    busy = true;
    const signal = AbortSignal.timeout(45_000);
    try {
      if (active?.conversation !== conversation_id || Date.now() - active.lastTurn > 25 * 60_000) {
        if (continuous && active?.continuous) await filePreviousCall(active, signal);
        const response = await call('/sessions', signal);
        const { id } = await response.json();
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) {
          throw new AdapterError(502, 'The brain returned an invalid session.');
        }
        active = { conversation: conversation_id, id, lastTurn: Date.now(), continuous };
      }
      const response = await call('/sessions/' + active.id + '/turns', signal, { text: question });
      const { answer, ended } = await readAnswer(response);
      if (ended) active = undefined;
      else active.lastTurn = Date.now();
      return { answer };
    } catch (error) {
      if (error.status === 409) active = undefined;
      throw error;
    } finally {
      busy = false;
    }
  }

  function completion(res, answer, model, stream) {
    const fields = { id: 'chatcmpl-' + randomUUID(), created: Math.floor(Date.now() / 1000), model };
    if (!stream) {
      return { ...fields, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const chunk = (delta, finish_reason) => res.write('data: ' + JSON.stringify({
      ...fields, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    chunk({ role: 'assistant', content: answer }, null);
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
  }

  const expected = Buffer.from('Bearer ' + secret);
  return createServer(async (req, res) => {
    function reply(status, body) {
      if (chatCompletion && status >= 400) console.info('Custom LLM request status:', status, body.error);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    }
    const chatCompletion = ['/v1/chat/completions', '/v1', '/v1/'].includes(req.url);
    if (req.method === 'POST' && !chatCompletion && req.url !== '/ask') console.info('Unrecognized adapter route');
    if (req.method !== 'POST' || (!chatCompletion && req.url !== '/ask')) {
      return reply(404, { error: 'Not found.' });
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply(401, { error: 'Invalid webhook credentials.' });
    }
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          res.setHeader('Connection', 'close');
          return reply(413, { error: 'Request too large.' });
        }
        chunks.push(chunk);
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'Expected JSON.' });
      }
      if (chatCompletion) {
        const messages = payload?.messages;
        if (!Array.isArray(messages)) return reply(400, { error: 'Expected conversation messages.' });
        const latest = messages.findLast(message => message?.role === 'user');
        const question = typeof latest?.content === 'string' ? latest.content.trim() : '';
        const metadata = messages.find(message => message?.role === 'system' &&
          typeof message.content === 'string' && /(?:^|\s)DAY13_CALL_ID=conv_[A-Za-z0-9_-]+(?=\s|$)/.test(message.content));
        const conversation_id = metadata?.content.match(/(?:^|\s)DAY13_CALL_ID=(conv_[A-Za-z0-9_-]{1,120})(?=\s|$)/)?.[1];
        if (!question || question.length > 8000 || !conversation_id) {
          return reply(400, { error: 'Expected a completed user turn and ElevenLabs conversation ID.' });
        }
        const { answer } = await ask({ question, conversation_id, continuous: true });
        const response = completion(res, answer, 'day13-brain', payload.stream === true);
        if (response) reply(200, response);
        return;
      }
      const question = typeof payload?.question === 'string' ? payload.question.trim() : '';
      const conversation_id = payload?.conversation_id ?? randomUUID();
      if (!question || question.length > 8000 ||
          typeof conversation_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(conversation_id)) {
        return reply(400, { error: 'Provide a valid question and conversation_id.' });
      }
      reply(200, await ask({ question, conversation_id }));
    } catch (error) {
      if (error instanceof AdapterError) return reply(error.status, { error: error.message });
      if (error.name === 'TimeoutError') return reply(504, { error: 'The brain took too long to answer.' });
      reply(502, { error: 'Unable to complete the brain request.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAdapter({
    token: process.env.DAY13_WORKOS_ACCESS_TOKEN,
    refreshToken: process.env.DAY13_WORKOS_REFRESH_TOKEN,
    secret: process.env.DAY13_WEBHOOK_SECRET,
  });
  const port = Number(process.env.DAY13_ADAPTER_PORT ?? 18744);
  server.listen(port, '127.0.0.1', () => console.log('Day 13 adapter listening on port ' + port));
}
