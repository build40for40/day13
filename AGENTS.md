# Day 13

Day 13 of 40 for 40, built live on Twitch on Wednesday 18 November 2026. The problem is "Scattered AI chats everywhere", from Ritika. Work is tracked on the Superthread `day13` board and the "Day 13" page.

- **Form factor:** Voice.
- **Name:** the app doesn't have one yet, so the repo is `day13` until it does. Once it's named, anything web-facing is served at `build40for40.com/<app>/`.

Shared 40 for 40 context lives in `../AGENTS.md`.

## Layout

A pnpm workspace. Install with `pnpm install` from the root, and add dependencies with `pnpm --filter <package> add <dep>`.

- **`workers/brain`:** the assistant's memory. A Worker at `build40for40.com/day13/api` in front of one `UserBrain` Durable Object per signed-in person, which streams replies and files everything they dump into notes under topics. `workers/brain/README.md` is the spec. It's the Sous brain with the template's memory improvements; the `agent-memory` skill in `../.claude/skills/` explains where each piece came from.
- **`apps/`:** empty until the voice client is picked. Whatever it is signs in with the shared WorkOS app and talks to the brain.

## Conventions

- **The prompts are the product.** `LIVE_PROMPT` in `workers/brain/src/prompt.ts` and `REFLECTION_PROMPT` in `reflection.ts` decide what it says and how things get filed.
- **Fake before live.** Tests never call Claude or WorkOS. Anything new that calls out gets a fake in `src/testing.ts` in the same change.
- **Never log what people say.** Log lines carry ids, timings and token counts only.
- **Fixtures are fictional,** and no real transcript or vault goes in a test, issue or commit.
- **Deploys go through CI** on every push to `main`, never by hand.

## Architecture decisions

These are settled. Everything still open, and the research behind each point, is on the "Architecture review" card on the Superthread `day13` board.

- **A remote MCP server connects ChatGPT and Claude to the brain.** The apps call it from their own servers, so it works on web, desktop and phone with nothing installed on the device.
- **It runs on Cloudflare,** using Cloudflare's MCP SDK (`createMcpHandler` from the `agents` package) and its OAuth provider (`@cloudflare/workers-oauth-provider`). It starts from Cloudflare's `remote-mcp-authkit` template.
- **It uses the existing brain.** Every tool call reaches the signed-in person's `UserBrain` Durable Object, the same one the voice API uses, so there's one memory per person.
- **Sign-in is WorkOS,** the same shared app the brain already verifies tokens from.
- **On Claude it ships as a plugin:** the MCP connector bundled with a skill that tells Claude when to use the brain. People add it from this repo as a plugin marketplace, or by uploading a zip, so it needs no directory review.

## The problem

Mind dump

I have a lot of random questions I ask AI throughout the day and accumulate lots of side chats, which then feels like another thing to organise. Help create a system I can just dump my thoughts and ideas and questions without needing to think if its properly filed

## From the brief and plan

A summary of the interview and the team's planning call, from the Superthread "Day 13 - plan brief" page. That page is the source. Nothing here is decided unless it says so, and the MVP is still open.

### What the interview found

- She uses two AIs: one for work and one for everything else.
- Chats get disorganised and hard to find. One piece of research ended up split across several chats, mixed in with unrelated ones. When she can't find something, she starts a new chat and leans on the AI's memory.
- She doesn't want to think about categorising. Work and personal can be mixed as long as items are tagged.
- Through the day she drops small to-dos into chat, and she also keeps a to-do list in her phone's notes. Meal planning came up three times.
- She doesn't use AI to carry out tasks today, but said she would use "execute in a box".
- She prefers her phone, and mentioned WhatsApp and voice. She's often around people without headphones, so she likes text she can read at her own pace, and uses voice when she wants an immediate answer. Sometimes she wants to refer back to a voice conversation in text.
- Privacy: someone else using her chat could see a conversation she'd rather they hadn't. She called this an exception.
- One assistant app she signed up for didn't work on her phone.

### What the team discussed

- **Who it's for:** research that morning suggested about 85% of people use one AI and about 15% use several. The team found multi-AI users more interesting: single-AI users already get some memory, and for multi-AI users it risks being shallow unless an MCP feeds everything. The target user was described as a semi-organised, scatterbrained professional who "can't be bothered".
- **Security and compliance:** set aside for now. An indicator of access permissions is a stretch goal.
- **Core concept:** a unified memory "brain" behind the scenes, like an Obsidian-style wiki, that organises everything from all AI chats. Ways in that came up: an MCP server or plugin with a skill, check-ins, or an end-of-day sweep. It should learn what not to store, such as card details. The right amount of friction differs per person.
- **Two candidate ideas:** one stream of consciousness that organises itself into folders, or a "my first Obsidian experience" onboarding. Both point to a unified memory layer.
- **Voice:** the brain could speak up at set moments, like morning, lunch and end of day, and on the move. Points raised: it may be a distraction, it's good for accessibility and older people and could come later, and it's hard to use around others. One view was that people won't leave their existing AIs, so the brain is a memory layer that can also be talked to directly.
- **Onboarding:** other AIs' export prompts (a quick summary) or full exports (which can take a long time) to pre-populate the brain's ontology. Google Drive and calendar scans were floated. Calendar was left outside the MVP, to be debated.
- **Channels:** WhatsApp (approval is hard, and unofficial libraries risk bans), Twilio (used in a previous build), iMessage or RCS, and an ElevenLabs voice agent on a web page as the fallback, checking whether it can take phone calls.
- **Differentiation:** a worry that it duplicates existing assistant apps, which are closed and single-platform. The counter-view: it's Obsidian for people who don't use Obsidian, across platforms. The opinionated harness (prompts, evals, point of view) was called the real product. "Brain as a service" and an open-source memory layer were floated, and Supermemory came up as one that exists.
- **Reuse:** a browser extension was noted as best for real-time capture. Poppy, a previous build, could be reused, and the Inkling repo (a free WhatsApp-based project) was to be shared.

### MVP candidates

Three were put forward, with about four hours left. The notes don't pick one.

- Onboard from AI exports to pre-populate the brain, then talk to it through an ElevenLabs agent on the web.
- The "dumbest MVP": an MCP plugin on ChatGPT that organises things into a brain usable from any chat, without voice.
- A skill that records a session and distils it into the brain.

### Work split from the call

- Architecture, MCP and plugin access, including the plugin's skill, evals and prompts, and whether an existing memory service can be used.
- The ElevenLabs agent: check whether it takes phone calls, otherwise a simple landing page.
- The opinionated harness and prompts.
- Skills and prompts for what to push to the brain from a session, and possibly onboarding. Still to be defined.
- Research iMessage, and WhatsApp or Twilio.
- Bring the interviewee back later for a show and tell.
