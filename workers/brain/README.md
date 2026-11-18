# Brain

One Cloudflare Worker at `build40for40.com/day13/api` for the voice client, and at `MCP_RESOURCE` for ChatGPT and Claude, in front of one `UserBrain` Durable Object per signed-in person. Each Durable Object holds that person's vault: markdown notes in its own SQLite, every change versioned.

It's the brain from Sous (Day 5), with the memory improvements from `templates/whatsapp-agent`, bent to a mind dump: people say whatever is on their mind, and when the conversation ends everything they said is filed for them.

```
voice client ─ WorkOS access token ─▶ Worker: auth first, routes
                                         │ USER_BRAIN.idFromName(sub)
                                         ▼
                                      UserBrain
                                         ├─ POST /sessions ─▶ context assembled once from the vault, stored with the model
                                         ├─ POST turns ─────▶ Claude streams back as SSE; note and recall run here
                                         └─ POST end ───────▶ alarm: Opus reflection ─▶ items, topics, USER.md, MEMORY.md
                                                              alarm also ends idle sessions, retries reflections, consolidates

MCP client ─ OAuth token from this Worker ─▶ OAuthProvider: token checked, props.sub
                                                │ USER_BRAIN.idFromName(sub)
                                                ▼
                                             UserBrain: getBrief, capture, recall
```

## The vault

| Path | What it holds |
| --- | --- |
| `USER.md` | The person's own text and preferences, plus `## Learned in conversation`, written by reflection |
| `MEMORY.md` | `## Lessons`: how to help this person, as opposed to facts about them |
| `sessions/<date>-<id>.md` | One note per conversation: a summary and links to what it filed |
| `ideas/`, `questions/`, `tasks/`, `thoughts/` | One note per dumped item. A question keeps the answer it got |
| `topics/<topic>.md` | `## Filed`: links to every item under that topic. Topics appear as people talk |

Every line a reflection adds carries its session's `[[wikilink]]`, so filing a session again replaces its own lines and nothing else. Reflection is structured output with narrow fields, filed by code: the model never writes notes directly.

## API

Every route needs `Authorization: Bearer <WorkOS access token>`, and answers `401 sign_in_required` without one. Errors are `{ "error": "<code>" }`.

| Route | What it does |
| --- | --- |
| `POST /sessions` | Starts a conversation, ending any still open. `201 { id, started_at, opening_line }` |
| `POST /sessions/:id/turns` | `{ "text": "what they said" }`. Streams `text` events with a `delta`, then `done` with `session_ended`, or `error`. Nothing is saved from a turn that errors, so the client can resend it |
| `POST /sessions/:id/end` | `202` with the session, filed a moment later. `204` when nothing was said, since there's nothing to keep |
| `GET /sessions/:id` | The transcript, noted facts and `reflection_status`: `not_ended`, `pending`, `done` or `failed` |
| `GET /notes?kind=` | Every note, newest first. `kind` is one of `user`, `memory`, `session`, `idea`, `question`, `task`, `thought`, `topic` |
| `GET /notes/<path>` | One note, with the notes that link to it in `linked_from` |
| `GET /versions?path=` | Every kept version of a note, newest first |
| `POST /versions/:id/restore` | Puts a note back to that version, as a new version |
| `GET /me`, `PATCH /me` | The profile. `PATCH` takes `about` and `preferences`, and keeps what was learned |
| `DELETE /me` | Wipes the Durable Object, then deletes the WorkOS user |

Conflicts are `409 session_ended` or `409 turn_in_progress`. `429 daily_cap` after 200 turns in 24 hours. `503 live_sessions_unavailable` until `ANTHROPIC_API_KEY` is set.

Sessions also end on their own: after 30 quiet minutes, after 40 turns (the last `done` says `session_ended: true`), and at London midnight.

## MCP

A stateless MCP server at `MCP_RESOURCE` (`https://dumpling.build40for40.com/mcp`), built with `createMcpHandler` from `agents`. Claude shares one MCP session across a person's chats and sends no conversation id, so every request gets a fresh server and nothing is kept between calls.

| Tool | What it does |
| --- | --- |
| `open_brain` | Read only. How to use the brain, then what a voice session would start from: USER.md, MEMORY.md, the last conversations, topics and the newest items |
| `capture` | Saves one thing the person said. Captures gather in one open session with no replies, which is filed like any conversation once it's quiet for 30 minutes, reaches 40 captures, passes London midnight or a voice session starts |
| `recall` | Read only. The same search the voice `recall` tool runs |

The wording the model sees (server instructions, tool descriptions and the guide `open_brain` starts with) lives in the `@day13/instructions` workspace package (`instructions/` at the repo root), which the evals in `evals/` test too.

### Sign-in

`@cloudflare/workers-oauth-provider` makes this Worker the authorisation server and wraps the voice API as its default handler, so `/day13/api` and its WorkOS check work as before. On the MCP host it serves:

| Route | What it does |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | Resource metadata. Also at the root `/.well-known/oauth-protected-resource`, which Claude asks for (claude-ai-mcp#1277) |
| `/.well-known/oauth-authorization-server` | Authorisation server metadata, with client metadata documents and dynamic registration both on |
| `/register` | Dynamic client registration |
| `GET /authorize` | Asks the person whether this client may use their brain, every time. Clients name themselves, so this is what stops a stranger's client riding on a WorkOS session |
| `POST /authorize` | Allow sends them to WorkOS AuthKit, deny sends the client `access_denied` |
| `/callback` | Trades the WorkOS code for the user id with `WORKOS_API_KEY` (one POST, no SDK) and gives the client a code whose token carries `{ sub }` |
| `/token` | Codes and refresh tokens for access tokens. Tokens are opaque, live in `OAUTH_KV` and only work at `MCP_RESOURCE` |

`DELETE /me` revokes every MCP grant before it wipes the brain.

## Models

Live turns run on `LIVE_MODEL` (Sonnet 5.5, low effort, thinking between tools), pinned per session so the prompt cache holds. Set it to `claude-haiku-5-5` if the first word is too slow to arrive; new sessions pick it up. Reflection and consolidation run on Opus 5.5 at high effort.

Each turn logs `brain_turn` with `first_text_ms`, `total_ms` and cache usage. Logs never hold what people said.

## Working on it

```bash
cp .dev.vars.example .dev.vars   # then fill in the keys
pnpm dev                         # the Worker on port 8787
pnpm test && pnpm typecheck
pnpm types                       # after changing wrangler.jsonc
```

To try MCP sign-in locally, add `MCP_RESOURCE=http://localhost:8787/mcp` to `.dev.vars` and `http://localhost:8787/callback` as a redirect URI on the WorkOS app.

Tests run in the Workers runtime and never call Claude or WorkOS: `src/testing.ts` fakes both. Migrations in `src/schema.ts` are append-only once this has been deployed. Deploys go through CI on every push to `main`, never by hand.
