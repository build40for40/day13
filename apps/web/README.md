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
