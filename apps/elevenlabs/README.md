# ElevenLabs voice adapter

The adapter connects a private ElevenLabs agent to the deployed [Day 13 brain](../../workers/brain/README.md). It is a single-user demo. The WorkOS access token determines the vault for every turn.

## Run locally

Use Node.js 22 or newer. Inject these values through your shell or secret manager.

| Environment variable | Purpose |
| --- | --- |
| `DAY13_WORKOS_ACCESS_TOKEN` | Authorized access token from the Day 13 WorkOS app |
| `DAY13_WORKOS_REFRESH_TOKEN` | Optional refresh token for a public WorkOS device session. Rotation stays in process memory |
| `DAY13_WEBHOOK_SECRET` | Random adapter key of at least 32 characters |
| `DAY13_ADAPTER_PORT` | Loopback port. Defaults to 18744 |

Run `node adapter.mjs`. For a live demo, give the loopback server a controlled HTTPS endpoint. Keep authentication enabled on the ElevenLabs agent because the adapter is bound to a single signed-in vault.

Set the agent's Custom LLM to Chat Completions with model ID `day13-brain`, the adapter HTTPS base URL ending in `/v1`, and the adapter key as a private ElevenLabs API-key secret. Set the agent's system prompt to include `DAY13_CALL_ID={{system__conversation_id}}` and disable fallback models for the demo. ElevenLabs supplies the completed user turn and conversation ID. The adapter forwards the turn to the Worker and streams the brain’s text to ElevenLabs as it arrives in Chat Completions format.

The Worker writes completed turns during the conversation. On a new ElevenLabs conversation, the adapter ends the previous brain session and waits briefly for filing before opening a fresh session. The Worker also ends idle sessions. A fresh call may need a retry if filing exceeds Preview's response timeout. Restarting the adapter loses its in-memory session mapping and rotated refresh token.

The original `POST /ask` route is available for the earlier tool-based prototype. The separate `test_brain.py` fixture serves fictional responses on localhost and is useful for webhook smoke tests.

## Verify

Run `node verify-adapter.mjs` and `node verify-continuous.mjs`. These tests use a mocked Worker. The manual voice acceptance test is to speak a new fictional detail in one call, see it transcribed, then hear it recalled in a fresh call through the deployed Worker.
