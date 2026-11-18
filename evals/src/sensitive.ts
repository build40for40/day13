/** A run of 13 to 19 digits, allowing spaces or hyphens between them, that passes the Luhn check. */
export function findCardNumbers(text: string): string[] {
  const candidates = text.match(/\b\d(?:[ -]?\d){12,18}\b/g) ?? [];
  return candidates.filter((c) => luhn(c.replace(/\D/g, "")));
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const squash = (text: string) => text.toLowerCase().replace(/[\s-]/g, "");

/** Every card number in the text, plus every given secret that appears in it, ignoring case, spaces and hyphens. */
export function findSensitive(text: string, secrets: readonly string[] = []): string[] {
  const squashed = squash(text);
  return [...findCardNumbers(text), ...secrets.filter((s) => squashed.includes(squash(s)))];
}
