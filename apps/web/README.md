# Dumpling

The web client, served at `build40for40.com/dumpling/`. For now `index.html` is a static prototype with made-up example data, in plain HTML, CSS and JS with no framework. It isn't wired to the brain yet.

- `src/brain.ts`: a typed client for the brain Worker (`workers/brain/README.md` is the spec).
- `src/fake.ts`: a fake brain with fictional notes, so the UI can be built without the Worker, Claude or WorkOS.

```bash
pnpm --filter @day13/web dev    # against the real brain: pnpm --filter @day13/brain dev, proxied from /day13/api
pnpm --filter @day13/web fake   # against the fake brain
pnpm --filter @day13/web test && pnpm --filter @day13/web typecheck
```

## Connecting to the brain

Open the page with `#connect` and paste a WorkOS access token (demo only: it's kept in this tab's session storage and expires). The page then:

- loads the brain's tasks and events (`GET /notes?kind=task` and `event`) and lays them out in `src/plan.ts`: Today is everything due today or overdue, filled up to ten with undated or soon-due tasks aiming for mostly work on weekdays and mostly personal at weekends. Importance and due dates come first. Tomorrow is what's dated tomorrow, and Future is the rest;
- saves a tick with `PATCH /notes/<path>` (`status: done`), and Put back with `status: open`;
- sends typed text as a short conversation (`POST /sessions`, a turn, then end), which the brain files into tasks once it ends. The new tasks show up after it's filed.

Without `#connect` it's the example data. `src/plan.ts` is pure and tested, so the rules can change in one place. This needs the brain to file due dates, importance and area, and to allow `PATCH /notes`. Until then every task is undated.

Not wired yet: a proper WorkOS sign-in (a pasted token is the only way in). Deploys go through CI: `.github/workflows/web-deploy.yml` builds `dist/dumpling` and deploys it as a static-assets Worker on every push to `main` that touches `apps/web`.

## In-page voice

The mic uses the ElevenLabs browser SDK to talk to the Dumpling agent, and every signed-in person talks to their own brain.

Sign in with WorkOS sends the page to AuthKit and back to `/dumpling/` with a code, which the web Worker trades for an access token using PKCE, so there's no client secret. That needs `https://build40for40.com/dumpling/` as a redirect URI on the WorkOS app. The access token stays in this tab's session storage.

Tapping the mic posts that token to the web Worker's `/dumpling/api/voice/session`. The Worker has the brain start a call for the person (`POST /voice/calls`, see `workers/brain/README.md`), asks ElevenLabs for a signed URL, and returns both. The page starts the conversation with the call token as the `dumpling_call` dynamic variable, and ends the brain session when the call drops so it's filed straight away.

The `dumpling` Cloudflare Worker needs one secret, `ELEVENLABS_API_KEY`: a server-side key allowed to request signed voice sessions for the agent. Without it the mic shows the ElevenLabs Preview as a fallback. The `BRAIN` service binding must point to the deployed `day13-brain` Worker.

The ElevenLabs agent needs:

- **Custom LLM:** Chat Completions, server URL `https://build40for40.com/day13/api/voice/v1`, any model ID, fallback models off.
- **System prompt:** a line reading `DUMPLING_CALL={{dumpling_call}}`. The brain reads the call token from it and ignores the rest, since its own prompt decides what Dumpling says.
- **Authentication:** on, so a conversation can only start from a signed URL.
