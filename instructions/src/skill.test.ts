import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKILL_DESCRIPTION } from "./index.ts";
import { SKILL_PATH, renderSkill } from "./skill.ts";

describe("the Claude skill", () => {
  it("starts with frontmatter naming the skill and quoting its description", () => {
    const [, frontmatter] = renderSkill().split("---\n");
    expect(frontmatter).toBe(`name: dumpling\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n`);
  });

  it("matches the committed SKILL.md, so run `pnpm --filter @day13/instructions skill` after changing the wording", () => {
    expect(readFileSync(SKILL_PATH, "utf8")).toBe(renderSkill());
  });
});
