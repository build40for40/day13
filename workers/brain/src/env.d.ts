// The secrets. wrangler.jsonc has no required list, so `wrangler types` doesn't know them and this adds them to the
// generated Env. Either can be unset when the Worker runs, which reads as undefined: every use checks for that.
interface __BaseEnv_Env {
  ANTHROPIC_API_KEY: string;
  WORKOS_API_KEY: string;
}
