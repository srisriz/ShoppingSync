"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase, usernameToEmail } from "@/lib/supabase";
import { sha256Hex } from "@/lib/codes";

/**
 * One-time console setup for a WhatsApp group. The bot privately sends this link
 * (/setup?t=…) to whoever gave the magic word. They choose the group's username
 * and password; the link then stops working.
 */
function SetupForm() {
  const router = useRouter();
  const token = useSearchParams().get("t") ?? "";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) return setError("This page needs the link the bot sent you.");
    if (password.length < 8) return setError("Use a password of at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      const tokenHash = await sha256Hex(token);   // before creating anything, so a failure here changes nothing
      await supabase.auth.signOut();               // make sure we don't attach the group to someone else's login
      const email = usernameToEmail(username);
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        if (!error.message.toLowerCase().includes("registered")) throw new Error(error.message);
        // The username exists: most likely an earlier attempt that didn't finish. With the
        // same password, sign in and carry on; otherwise it belongs to someone else.
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw new Error("That username is taken. Choose another.");
      } else if (!data.session) {
        throw new Error("Supabase is waiting for an email confirmation. Switch off 'Confirm email' in Supabase, then try again.");
      }
      const { error: claimError } = await supabase.rpc("claim_setup_token", {
        p_token_hash: tokenHash,
        p_username: username.trim().toLowerCase(),
      });
      if (claimError) {
        await supabase.auth.signOut();
        throw new Error(claimError.message);
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Set up your group&apos;s console</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Choose a username and password for this WhatsApp group&apos;s ShoppingSync console.
        Share them only with people who should manage the list. This link works once.
      </p>
      <div>
        <label htmlFor="username">Group username</label>
        <input id="username" required autoCapitalize="none" autoComplete="username"
          value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div>
        <label htmlFor="password">Password</label>
        <input id="password" type="password" required autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div>
        <label htmlFor="confirm">Password again</label>
        <input id="confirm" type="password" required autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <button type="submit" disabled={busy}>{busy ? "Setting up…" : "Create console login"}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export default function SetupPage() {
  return (
    <main className="page">
      <div className="topbar"><h1>ShoppingSync</h1></div>
      <Suspense fallback={<p className="empty">Loading…</p>}>
        <SetupForm />
      </Suspense>
    </main>
  );
}
