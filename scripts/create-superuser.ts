/**
 * Creates (or updates) the fixed ShoppingSync super user.
 *
 *   npm run superuser:create
 *
 * Asks for a username (default "admin") and a password in this Terminal window.
 * The password is never shown, saved to a file or sent anywhere except Supabase.
 * The super user automatically controls every group. There is only ever one:
 * running this again replaces the previous super user (their login keeps working
 * only as a group login, if it is one).
 */
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const secret = process.env.SUPABASE_SECRET_KEY ?? "";
if (!url || !secret) {
  console.error("Fill in NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local first.");
  process.exit(1);
}
const db = createClient(url, secret, { auth: { persistSession: false } });

/** Same rule as the web sign-in page (lib/supabase.ts). */
const usernameToEmail = (u: string) => `${u.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "")}@family.shoppingsync.app`;

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Reads a line without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") process.exit(1);                       // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1); // backspace
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function findUserId(email: string): Promise<string | null> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  const username = (await ask("Super user username [admin]: ")) || "admin";
  const password = await askHidden("Super user password (min 12 characters, not shown): ");
  if (password.length < 12) { console.error("✗ Use at least 12 characters."); process.exit(1); }
  const again = await askHidden("Type it again: ");
  if (again !== password) { console.error("✗ The passwords don't match."); process.exit(1); }

  const email = usernameToEmail(username);
  const { data: fam } = await db.from("families").select("name").eq("console_username", username.toLowerCase()).maybeSingle();
  if (fam) { console.error(`✗ "${username}" is already the login for the group "${fam.name}". Choose another username.`); process.exit(1); }

  let userId = await findUserId(email);
  if (userId) {
    const { error } = await db.auth.admin.updateUserById(userId, { password });
    if (error) throw error;
    console.log(`✓ Updated the password for "${username}"`);
  } else {
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("could not create the user");
    userId = data.user.id;
    console.log(`✓ Created "${username}"`);
  }

  // Exactly one super user.
  await db.from("app_admins").delete().neq("user_id", userId);
  const { error } = await db.from("app_admins").upsert({ user_id: userId });
  if (error) throw error;
  console.log(`✓ "${username}" is the super user. Sign in at /login to manage every group.`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
