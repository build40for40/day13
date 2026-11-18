import { HttpError, isPlainObject } from "./http";

export const USER_MD = "USER.md";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Preferences = { [key: string]: JsonValue };

export interface Profile {
  preferences: Preferences;
  about: string;
  updated_at: string;
}

/** USER.md as the user would see it: their own text, and what the assistant learned as plain lines. */
export interface PublicProfile extends Profile {
  learned: string[];
}

/** What a person can change about themselves. `preferences` replaces the old ones whole. */
export interface ProfilePatch {
  about?: string;
  preferences?: Preferences;
}

const MAX_ABOUT_CHARS = 20_000;
const MAX_PREFERENCES_BYTES = 4_096;

export function parseProfilePatch(input: unknown): ProfilePatch {
  const invalid = (message: string) => new HttpError(400, "invalid_profile", { message });
  if (!isPlainObject(input)) throw invalid("Send {about} or {preferences}.");
  const unknown = Object.keys(input).filter((key) => key !== "about" && key !== "preferences");
  if (unknown.length || !Object.keys(input).length) throw invalid("Send {about} or {preferences}.");
  const { about, preferences } = input;
  if (about !== undefined && (typeof about !== "string" || about.length > MAX_ABOUT_CHARS)) throw invalid(`about is text up to ${MAX_ABOUT_CHARS} characters.`);
  if (preferences !== undefined && (!isPlainObject(preferences) || JSON.stringify(preferences).length > MAX_PREFERENCES_BYTES)) throw invalid("preferences is a small JSON object.");
  return { ...(about !== undefined ? { about } : {}), ...(preferences !== undefined ? { preferences: preferences as Preferences } : {}) };
}
