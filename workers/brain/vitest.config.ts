import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // These also override a local .dev.vars, so real keys never reach a test.
        bindings: { ANTHROPIC_API_KEY: "fake-anthropic-api-key", WORKOS_API_KEY: "fake-workos-api-key" },
      },
    }),
  ],
});
