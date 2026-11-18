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
