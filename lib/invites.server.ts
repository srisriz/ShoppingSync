/**
 * Server only (uses the secret key): looks up a personal invite from its link.
 * The bot's number is read here and only handed to pages for a valid invite, so it
 * never appears in the website's public code.
 */
import { createClient } from "@supabase/supabase-js";
import { sha256Hex } from "@/lib/codes";

export type InviteView =
  | { state: "none" }
  | { state: "invalid" }                                            // unknown, cancelled or expired
  | { state: "used"; name: string; groupName: string | null }
  | { state: "ok"; name: string; number: string; botNumber: string | null; expiresAt: string };

export async function lookupInvite(token: string | undefined, opts: { markOpened?: boolean } = {}): Promise<InviteView> {
  if (!token) return { state: "none" };
  if (!/^[a-f0-9]{48}$/.test(token)) return { state: "invalid" };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return { state: "invalid" };
  const db = createClient(url, secret, { auth: { persistSession: false } });

  const { data: inv } = await db.from("invites")
    .select("id, name, number, expires_at, opened_at, cancelled_at, used_at, family_id")
    .eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!inv || inv.cancelled_at) return { state: "invalid" };
  if (inv.used_at) {
    const { data: fam } = inv.family_id
      ? await db.from("families").select("name").eq("id", inv.family_id).maybeSingle()
      : { data: null };
    return { state: "used", name: inv.name, groupName: fam?.name ?? null };
  }
  if (Date.parse(inv.expires_at) <= Date.now()) return { state: "invalid" };

  if (opts.markOpened && !inv.opened_at) {
    await db.from("invites").update({ opened_at: new Date().toISOString() }).eq("id", inv.id);
  }
  const { data: setting } = await db.from("app_settings").select("value").eq("key", "bot_number").maybeSingle();
  return { state: "ok", name: inv.name, number: inv.number, botNumber: setting?.value ?? null, expiresAt: inv.expires_at };
}
