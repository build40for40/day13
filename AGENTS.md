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

## The problem

Mind dump

I have a lot of random questions I ask AI throughout the day and accumulate lots of side chats, which then feels like another thing to organise. Help create a system I can just dump my thoughts and ideas and questions without needing to think if its properly filed
