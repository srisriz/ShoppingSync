"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, usernameToEmail } from "@/lib/supabase";

/**
 * Sign in to a group's console. New groups don't sign up here: the bot is added
 * to a WhatsApp group, someone gives the magic word, and the bot privately sends
 * them a one-time setup link (/setup) to create the login.
 */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(username), password });
    setBusy(false);
    if (error) return setError("Username or password is wrong.");
    // The super user lands on All groups; a group login on its own list.
    const { data: admin } = await supabase.rpc("is_admin");
    router.replace(admin === true ? "/admin" : "/");
  }

  return (
    <main className="page">
      <div className="topbar">
        <h1>ShoppingSync</h1>
      </div>

      <form className="card stack" onSubmit={submit}>
        <h2>Sign in</h2>
        <div>
          <label htmlFor="username">Username</label>
          <input id="username" required autoComplete="username" autoCapitalize="none"
            value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>{busy ? "Please wait…" : "Sign in"}</button>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          Use your group&apos;s login to see your group&apos;s list, or the super user login to manage every group.
        </p>
        <p className="hint">
          New group? Add the ShoppingSync bot to your WhatsApp group and give it the magic word.
          It will send you a private link to set up your group&apos;s console.
        </p>
      </form>
    </main>
  );
}
