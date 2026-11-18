import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SKILL_BODY, SKILL_DESCRIPTION, SKILL_NAME } from "./index.ts";

export const SKILL_PATH = fileURLToPath(new URL(`../../plugin/skills/${SKILL_NAME}/SKILL.md`, import.meta.url));

export function renderSkill(): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${SKILL_BODY}\n`;
}

if (import.meta.main) {
  writeFileSync(SKILL_PATH, renderSkill());
  console.log(`Wrote ${SKILL_NAME}/SKILL.md`);
}
