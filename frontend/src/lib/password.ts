/** Password rules — must match the Supabase Auth project config
 * (password_min_length = 12, required characters = letters + digits). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_RULE_TEXT = "Passwords must be 12+ characters with letters and digits.";

/** Returns null when the password satisfies the rules, else a short user-facing reason. */
export function passwordError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!/[A-Za-z]/.test(password)) return "Include at least one letter.";
  if (!/[0-9]/.test(password)) return "Include at least one digit.";
  return null;
}

/** Validates the new-password + confirmation pair used by both password forms. */
export function passwordPairError(password: string, confirm: string): string | null {
  const err = passwordError(password);
  if (err) return err;
  if (password !== confirm) return "Passwords do not match.";
  return null;
}
