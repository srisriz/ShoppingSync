/**
 * Super user only: gives a group's console login a new password.
 * Changing someone else's password needs the secret key, so this runs on the
 * server (your Mac now, Vercel later), never in the browser.
 */
import { createClient } from "@supabase/supabase-js";
import { generateCode } from "@/lib/codes";

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return Response.json({ error: "The server is missing its Supabase settings." }, { status: 500 });
  const db = createClient(url, secret, { auth: { persistSession: false } });

  // Who is asking? Only the super user may do this.
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: who } = await db.auth.getUser(token);
  if (!who.user) return Response.json({ error: "Please sign in again." }, { status: 401 });
  const { data: admin } = await db.from("app_admins").select("user_id").eq("user_id", who.user.id).maybeSingle();
  if (!admin) return Response.json({ error: "Only the super user can reset passwords." }, { status: 403 });

  const { familyId } = (await req.json().catch(() => ({}))) as { familyId?: string };
  if (!familyId) return Response.json({ error: "Which group?" }, { status: 400 });
  const { data: fam } = await db.from("families").select("owner_id, name").eq("id", familyId).maybeSingle();
  if (!fam?.owner_id) return Response.json({ error: "This group has no console login yet." }, { status: 400 });
  if (fam.owner_id === who.user.id) return Response.json({ error: "Use 'Change super user password' for your own login." }, { status: 400 });

  // e.g. "mango-4821-river-0377": easy to read out, hard to guess.
  const password = `${generateCode()}-${generateCode()}`.toLowerCase();
  const { error } = await db.auth.admin.updateUserById(fam.owner_id, { password });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ password });
}
