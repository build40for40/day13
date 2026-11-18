# Dumpling

The web client, served at `build40for40.com/dumpling/`. For now `index.html` is a static prototype with made-up example data, in plain HTML, CSS and JS with no framework. It isn't wired to the brain yet.

- `src/brain.ts`: a typed client for the brain Worker (`workers/brain/README.md` is the spec).
- `src/fake.ts`: a fake brain with fictional notes, so the UI can be built without the Worker, Claude or WorkOS.

```bash
pnpm --filter @day13/web dev    # against the real brain: pnpm --filter @day13/brain dev, proxied from /day13/api
pnpm --filter @day13/web fake   # against the fake brain
pnpm --filter @day13/web test && pnpm --filter @day13/web typecheck
```

Not wired yet: WorkOS sign-in, and the brain behind the list (`src/brain.ts` is ready for it). Deploys go through CI: `.github/workflows/web-deploy.yml` builds `dist/dumpling` and deploys it as a static-assets Worker on every push to `main` that touches `apps/web`.


## Private in-page voice demo

The mic uses the ElevenLabs browser SDK to connect to the existing private Dumpling agent. WorkOS device sign-in starts from the page and the access token stays in browser memory. The web Worker verifies the token with the brain Worker and checks the signed-in user ID before issuing a signed ElevenLabs URL. The current agent adapter is bound to a single vault.

Set these secrets on the `dumpling` Cloudflare Worker before enabling the demo:

- `ELEVENLABS_API_KEY` — server-side key allowed to request signed voice sessions for the private agent.
- `DUMPLING_VOICE_OWNER_ID` — the WorkOS user ID of the exact same vault owner as the agent adapter's WorkOS session. Check the identity against the brain's authenticated `GET /me` before configuring it.

The `BRAIN` service binding must point to the deployed `day13-brain` Worker. Keep authentication on in ElevenLabs. Without the secrets, the mic shows the existing authenticated Preview as a fallback. The sample task list is independent of the voice demo.
