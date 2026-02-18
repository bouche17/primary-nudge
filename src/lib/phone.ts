// Validates international phone format: + followed by 7-15 digits (spaces/dashes allowed)
const PHONE_REGEX = /^\+[1-9]\d{6,14}$/;

export function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, "");
}

export function isValidPhone(raw: string): boolean {
  if (!raw.trim()) return true; // optional field
  return PHONE_REGEX.test(normalizePhone(raw));
}
