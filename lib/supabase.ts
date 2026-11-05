import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Supabase is not configured. Fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local."
  );
}

/** Browser client. Row-level security limits it to the signed-in family's data. */
export const supabase = createClient(url, key);

/**
 * Supabase logins are email-based. The family signs in with a plain username,
 * which is turned into an internal address here. No email is ever sent to it
 * (email confirmation must be switched off in Supabase; see README).
 */
export function usernameToEmail(username: string): string {
  const clean = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return `${clean}@family.shoppingsync.app`;
}

/** Same normalisation as the database's generated item_key column. */
export function itemKey(name: string): string {
  return name.trim().toLowerCase();
}
