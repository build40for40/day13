# Brain

One Cloudflare Worker at `build40for40.com/day13/api` for the voice client, and at `MCP_RESOURCE` for ChatGPT and Claude, in front of one `UserBrain` Durable Object per signed-in person. Each Durable Object holds that person's vault: markdown notes in its own SQLite, every change versioned.

It's the brain from Sous (Day 5), with the memory improvements from `templates/whatsapp-agent`, bent to a mind dump: people say whatever is on their mind, in a voice call or in another AI app, and it's filed for them about a minute later.

```
voice client ─ WorkOS access token ─▶ Worker: auth first, routes
                                         │ USER_BRAIN.idFromName(sub)
                                         ▼
                                      UserBrain
                                         ├─ POST /sessions ─▶ context assembled once from the vault, stored with the model
                                         ├─ POST turns ─────▶ Claude streams back as SSE; memory and task/event tools run here ─┐
                                         └─ POST end ───────▶ has the log filed now                                 │
                                                                                                                    ▼
MCP client ─ OAuth token from this Worker ─▶ OAuthProvider: token checked, props.sub                             the log
                                                │ USER_BRAIN.idFromName(sub)                                        ▲
                                                ▼                                                                   │
                                             UserBrain: getBrief, recall, getNote, listItems, updateNote, addItem, capture ─┘

the log ─▶ alarm, a minute after the last thing said: Sonnet files the open batch ─▶ items, topics
           alarm, once the batch closes: Opus settles it ─▶ items, topics, USER.md, MEMORY.md
           alarm also ends idle sessions, retries failed passes, consolidates
```

## The log and filing

Everything said lands in one append-only log per person, whichever way it came in. Each entry keeps its time and its source: the voice session it was said in, or the name the connected app signed in with. A session is only the live state of one voice call, and starting or ending one doesn't split the log.

The log is filed in batches, and at most one batch is open:

| When | What runs |
| --- | --- |
| A minute after the last thing said, or as soon as a voice session ends | A quick pass on Sonnet files the open batch's items under topics |
| More is said | The quick pass runs again over the whole open batch and replaces what the last one wrote, so a change of mind ends up as one note, not two |
| The batch closes: 30 quiet minutes, 40 things said, about 24,000 tokens of text, or London midnight | A settle pass on Opus files it one last time and adds what was learned to `USER.md` and `MEMORY.md` |

Every line a pass writes carries its batch's note as a `[[wikilink]]`, which is how the next pass finds and replaces them. A pass also deletes the notes an earlier pass of the same batch wrote and no longer wants, keeping the deleted note as a version. A note the person has changed since, like a ticked-off task, is left exactly as it is, and the model is told to leave it out.

A failed pass is retried after 1, 5, 30 and 120 minutes. A quick pass that can never succeed is dropped until more is said or the batch closes, and a settle pass that can never succeed marks the batch failed.

Until a pass has read them, entries show up as "not filed yet" in `recall` and in what `open_brain` returns, so another app can pick up what was said seconds ago.

## The vault

| Path | What it holds |
| --- | --- |
| `USER.md` | The person's own text and preferences, plus `## Learned in conversation`, written by reflection |
| `MEMORY.md` | `## Lessons`: how to help this person, as opposed to facts about them |
| `sessions/<date>-<id>.md` | One note per batch of the log: a summary and links to what it filed |
| `ideas/`, `questions/`, `tasks/`, `events/`, `notes/`, `thoughts/` | One note per dumped item. A question keeps the answer it got. A note is a fact or finding worth looking up again, and a thought is anything else. Tasks and events carry the fields below |
| `topics/<topic>.md` | `## Summary`: where the topic stands now, rewritten each time something is filed there. `## Filed`: links to every item under it. Topics appear as people talk. Frontmatter has `type` (`topic` or `project`) and `area` |
| `people/<name>.md` | The same two sections for each person an item names, by first name or plain role. Items link to them from their `Who:` line |

### Task and event fields

Each item's note keeps these in its frontmatter, named after iCalendar and JSCalendar where they overlap so a later export is easy. Only the ones that are set are written.

| Field | Meaning |
| --- | --- |
| `area` | `work` or `personal` |
| `people` | Who it's for or with, as first names or plain roles like `the kids`. Never a surname, and only when they said |
| `due` | The day it's due, `YYYY-MM-DD`. Only a date they gave or clearly meant, worked out from the day the conversation started |
| `start`, `location` | For an event: when (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, London time) and a place name, never an address |
| `importance` | `low`, `normal` or `high`, when they said so or it clearly is |
| `inferred` | Which of `area`, `due` and `importance` were worked out rather than stated. The assistant never invents a deadline: when unsure the field stays empty |
| `status` | `open`, `done` or `dropped`. `completed_at` is added when a task is done |

Ranking (what to show today, the work and personal balance) is not stored. It's worked out when the list is read, so the rules can change without refiling anything.

A page's `area` is worked out from what's filed on it: `work`, `personal`, or `mixed` once it holds both. Summaries come from the settle pass that closes a batch: it's shown each page's summary so far and returns the new one for every topic and person it touched. The quick pass leaves summaries as they are.

Filing is structured output with narrow fields, filed by code: the model never writes notes directly.

## API

Every route needs `Authorization: Bearer <WorkOS access token>`, and answers `401 sign_in_required` without one. Errors are `{ "error": "<code>" }`.

| Route | What it does |
| --- | --- |
| `POST /sessions` | Starts a voice session, ending any still open. `201 { id, started_at, opening_line }` |
| `POST /sessions/:id/turns` | `{ "text": "what they said" }`. Streams `text` events with a `delta`, then `done` with `session_ended`, or `error`. If the reply fails after a task or event write, that completed change is kept. Check the current list before retrying |
| `POST /sessions/:id/end` | `202` with the session, and what was said in it is filed a moment later. `204` when nothing was said, since there's nothing to keep |
| `GET /sessions/:id` | The transcript, noted facts and `reflection_status`: `not_ended`, `pending`, `done` once a pass has filed everything said in it, or `failed` |
| `GET /notes?kind=` | Every note, newest first, each with its filing `fields`. `kind` is one of `user`, `memory`, `session`, `idea`, `question`, `task`, `event`, `note`, `thought`, `topic`, `person` |
| `GET /notes/<path>` | One note, with the notes that link to it in `linked_from` |
| `PATCH /notes/<path>` | Changes a task or event: `status` (`open`, `done`, `dropped`), `due` (`YYYY-MM-DD` or `null`), `importance` (`low`, `normal`, `high` or `null`) or `area`. `400 invalid_patch` for anything else, `409 not_a_task` for other notes. Every change is a new version |
| `GET /versions?path=` | Every kept version of a note, newest first |
| `POST /versions/:id/restore` | Puts a note back to that version, as a new version |
| `GET /me`, `PATCH /me` | The profile. `PATCH` takes `about` and `preferences`, and keeps what was learned |
| `DELETE /me` | Wipes the Durable Object, then deletes the WorkOS user |

Conflicts are `409 session_ended` or `409 turn_in_progress`. `429 daily_cap` after 200 voice turns in 24 hours. `503 live_sessions_unavailable` until `ANTHROPIC_API_KEY` is set.

Sessions also end on their own: after 30 quiet minutes, after 40 turns (the last `done` says `session_ended: true`), and at London midnight.

## MCP

A stateless MCP server at `MCP_RESOURCE` (`https://dumpling.build40for40.com/mcp`), built with `createMcpHandler` from `agents`. Claude shares one MCP session across a person's chats and sends no conversation id, so every request gets a fresh server and nothing is kept between calls.

| Tool | What it does |
| --- | --- |
| `open_brain` | Read only. How to use the brain, then what a voice session would start from: USER.md, MEMORY.md, the last conversations, topics with their area and summary, and the newest items |
| `capture` | Saves one thing the person said by adding it to the log, with the app's name as its source. It's filed with everything else, about a minute later |
| `recall` | Read only. The same search the voice `recall` tool runs |
| `read_note` | Read only. One note in full by its path, with its fields and the notes that link to it |
| `add_task`, `add_event` | Files one to-do or event straight away, already sorted by the AI that added it. An event needs a start. An area nobody gave is filed as `personal` and listed in `inferred` |
| `list_tasks` | Read only. To-dos by `status` (open unless asked), `area` and `due_by`, dated ones first. Open lists end with what's captured but not filed yet |
| `list_events` | Read only. Events still on from today, or between `from` and `to`, soonest first |
| `update_task`, `update_event` | Changes status, due date, importance or area on a to-do, and start, location, status or area on an event. Each refuses a note of the other kind |

`capture` and the two add tools overlap on purpose: a clear to-do or a dated event is added directly so it's on the list at once, and everything else is captured and filed later. Each reflection is shown the open to-dos and events and told not to file one again, which covers an AI that sends the same thing both ways.

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

Live turns run on `LIVE_MODEL` (Sonnet 5.5, low effort, thinking between tools), pinned per session so the prompt cache holds. Set it to `claude-haiku-5-5` if the first word is too slow to arrive; new sessions pick it up. The quick filing pass runs on Sonnet 5.5 at medium effort. The settle pass and consolidation run on Opus 5.5 at high effort.

Each turn logs `brain_turn` with `first_text_ms`, `total_ms` and cache usage, and each filing pass logs `brain_filing`. Logs never hold what people said.

## Working on it

```bash
cp .dev.vars.example .dev.vars   # then fill in the keys
pnpm dev                         # the Worker on port 8787
pnpm test && pnpm typecheck
pnpm types                       # after changing wrangler.jsonc
```

To try MCP sign-in locally, add `MCP_RESOURCE=http://localhost:8787/mcp` to `.dev.vars` and `http://localhost:8787/callback` as a redirect URI on the WorkOS app.

Tests run in the Workers runtime and never call Claude or WorkOS: `src/testing.ts` fakes both. Migrations in `src/schema.ts` are append-only once this has been deployed. Deploys go through CI on every push to `main`, never by hand.
