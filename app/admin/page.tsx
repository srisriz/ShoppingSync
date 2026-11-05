"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { signOut } from "@/lib/useFamily";
import { generateCode, generateToken, sha256Hex } from "@/lib/codes";

type GroupRow = {
  id: string;
  name: string;
  status: "pending" | "active" | "inactive" | "left";
  owner_id: string | null;
  console_username: string | null;
  created_at: string;
  activated_at: string | null;
  prompt_sent_at: string | null;
};
type CodeRow = { family_id: string | null; used_at: string | null; expires_at: string | null };

const ACTIVATION_WINDOW_MS = 24 * 3600 * 1000;
const SETUP_LINK_TTL_MS = 48 * 3600 * 1000;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const time = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

const STATUS: Record<GroupRow["status"], { label: string; cls: string }> = {
  active: { label: "Active", cls: "pill pill-ok" },
  pending: { label: "Waiting for magic word", cls: "pill pill-warn" },
  inactive: { label: "Bot removed", cls: "pill" },
  left: { label: "Bot left", cls: "pill" },
};

/** Super user only: every WhatsApp group, magic words, logins and the super user's own credentials. */
export default function AllGroupsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [counts, setCounts] = useState<Record<string, { items: number; shops: number }>>({});
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [shown, setShown] = useState<Record<string, { kind: "code" | "link" | "password"; value: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [g, it, sh, c] = await Promise.all([
      supabase.from("families")
        .select("id, name, status, owner_id, console_username, created_at, activated_at, prompt_sent_at")
        .order("created_at"),
      supabase.from("items").select("family_id").eq("status", "needed"),
      supabase.from("shops").select("family_id"),
      supabase.from("activation_codes").select("family_id, used_at, expires_at"),
    ]);
    const firstError = [g, it, sh, c].find((x) => x.error)?.error;
    if (firstError) setError(firstError.message);
    const tally: Record<string, { items: number; shops: number }> = {};
    for (const r of (it.data ?? []) as { family_id: string }[]) (tally[r.family_id] ??= { items: 0, shops: 0 }).items++;
    for (const r of (sh.data ?? []) as { family_id: string }[]) (tally[r.family_id] ??= { items: 0, shops: 0 }).shops++;
    setGroups((g.data as GroupRow[]) ?? []);
    setCounts(tally);
    setCodes((c.data as CodeRow[]) ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getSession();
      if (!auth.session) return router.replace("/login");
      setUsername(auth.session.user.email?.split("@")[0] ?? "");
      const { data } = await supabase.rpc("is_admin");
      setAllowed(data === true);
      if (data === true) load();
    })();
  }, [router, load]);

  /** A magic word that works only in this group, once, until the group's 24-hour window ends. */
  async function createMagicWord(g: GroupRow) {
    setError(null);
    const code = generateCode();
    const { data: auth } = await supabase.auth.getSession();
    const until = g.prompt_sent_at ? Date.parse(g.prompt_sent_at) + ACTIVATION_WINDOW_MS : Date.now() + ACTIVATION_WINDOW_MS;
    // A new word replaces any earlier unused one for this group.
    await supabase.from("activation_codes").delete().eq("family_id", g.id).is("used_at", null);
    const { error } = await supabase.from("activation_codes").insert({
      family_id: g.id,
      code_hash: await sha256Hex(code),
      label: g.name,
      created_by: auth.session?.user.id ?? null,
      expires_at: new Date(until).toISOString(),
    });
    if (error) return setError(error.message);
    setShown({ ...shown, [g.id]: { kind: "code", value: code } });
    load();
  }

  async function makeSetupLink(g: GroupRow) {
    const token = generateToken();
    const { error } = await supabase.from("setup_tokens").insert({
      family_id: g.id,
      token_hash: await sha256Hex(token),
      expires_at: new Date(Date.now() + SETUP_LINK_TTL_MS).toISOString(),
    });
    if (error) return setError(error.message);
    setShown({ ...shown, [g.id]: { kind: "link", value: `${window.location.origin}/setup?t=${token}` } });
  }

  async function resetPassword(g: GroupRow) {
    if (!window.confirm(`Give ${g.name}'s login (${g.console_username ?? "group login"}) a new password? The old one stops working.`)) return;
    const { data: auth } = await supabase.auth.getSession();
    const res = await fetch("/api/admin/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth.session?.access_token ?? ""}` },
      body: JSON.stringify({ familyId: g.id }),
    });
    const body = (await res.json().catch(() => ({}))) as { password?: string; error?: string };
    if (!res.ok || !body.password) return setError(body.error ?? "Could not reset the password.");
    setShown({ ...shown, [g.id]: { kind: "password", value: body.password } });
  }

  async function changeOwnPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 12) return setError("Use at least 12 characters for the super user password.");
    if (newPassword !== confirmPassword) return setError("The two passwords don't match.");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return setError(error.message);
    setNewPassword("");
    setConfirmPassword("");
    setSaved("Super user password changed.");
  }

  function openConsole(g: GroupRow) {
    try { localStorage.setItem("shoppingsync.group", g.id); } catch { /* storage unavailable */ }
    router.push(`/?g=${g.id}`);
  }

  if (allowed === null) return <main className="page"><p className="empty">Loading…</p></main>;
  if (!allowed) {
    return (
      <main className="page">
        <p className="empty">This page is only for the super user. <Link href="/">Back to your list</Link>.</p>
      </main>
    );
  }

  const now = Date.now();
  const unusedCode = (g: GroupRow) => codes.some((c) => c.family_id === g.id && !c.used_at && (!c.expires_at || Date.parse(c.expires_at) > now));

  return (
    <div className="admin">
      <header className="admin-bar">
        <div className="admin-bar-inner">
          <div className="row-tight">
            <strong className="brand">ShoppingSync</strong>
            <span className="pill pill-dark">Super user</span>
          </div>
          <nav className="row-tight">
            <Link href="/admin">All groups</Link>
            <a href="#credentials">Super user settings</a>
            <button className="link" onClick={signOut}>Sign out</button>
          </nav>
        </div>
      </header>

      <main className="admin-main">
        <div>
          <h1 className="admin-title">All groups</h1>
          <p className="hint" style={{ margin: 0 }}>Every WhatsApp group the bot has joined. Open any group&apos;s console, or manage its login.</p>
        </div>
        {error && <p className="error">{error}</p>}

        <div className="admin-cols">
          <section className="card admin-table-card">
            <div style={{ overflowX: "auto" }}>
              <table className="admin-table">
                <thead>
                  <tr><th>Group</th><th>Status</th><th>Group login</th><th style={{ textAlign: "right" }}>Actions</th></tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const c = counts[g.id] ?? { items: 0, shops: 0 };
                    const leaveAt = g.prompt_sent_at ? Date.parse(g.prompt_sent_at) + ACTIVATION_WINDOW_MS : null;
                    const extra = shown[g.id];
                    return [
                      <tr key={g.id}>
                        <td>
                          <div className="name">{g.name}</div>
                          <div className="meta">
                            {g.status === "pending" ? `added ${day(g.created_at)}` : `${c.items} open items · ${c.shops} shops`}
                          </div>
                        </td>
                        <td><span className={STATUS[g.status].cls}>{STATUS[g.status].label}</span></td>
                        <td>
                          {g.status === "pending" ? <span className="meta">After activation</span>
                            : g.owner_id ? <><div>{g.console_username ?? "set up"}</div>{g.activated_at && <div className="meta">since {day(g.activated_at)}</div>}</>
                            : <><div style={{ color: "var(--warn)" }}>No login yet</div><div className="meta">setup link not used</div></>}
                        </td>
                        <td className="admin-actions">
                          {g.status === "pending" && (
                            <button onClick={() => createMagicWord(g)}>{unusedCode(g) ? "New magic word" : "Create magic word"}</button>
                          )}
                          {g.status !== "pending" && (
                            <button className={g.status === "active" ? "" : "secondary"} onClick={() => openConsole(g)}>
                              {g.status === "active" ? "Open console" : "View"}
                            </button>
                          )}
                          {g.status === "active" && g.owner_id && <button className="secondary" onClick={() => resetPassword(g)}>Reset password</button>}
                          {g.status === "active" && !g.owner_id && <button className="secondary" onClick={() => makeSetupLink(g)}>New setup link</button>}
                        </td>
                      </tr>,
                      (extra || (g.status === "pending" && leaveAt)) && (
                        <tr key={`${g.id}-x`} className="admin-subrow">
                          <td colSpan={4}>
                            {extra?.kind === "code" && (
                              <div className="banner banner-ok">
                                Magic word for <strong>{g.name}</strong>: <strong className="code">{extra.value}</strong>.
                                Works only in this group, once. Copy it now; it won&apos;t be shown again.
                              </div>
                            )}
                            {extra?.kind === "link" && (
                              <div className="banner banner-ok">
                                One-time setup link for <strong>{g.name}</strong> (48 hours): <code style={{ wordBreak: "break-all" }}>{extra.value}</code>
                              </div>
                            )}
                            {extra?.kind === "password" && (
                              <div className="banner banner-ok">
                                New password for <strong>{g.console_username}</strong>: <strong className="code">{extra.value}</strong>.
                                Share it with the group privately; it won&apos;t be shown again.
                              </div>
                            )}
                            {g.status === "pending" && leaveAt && (
                              <p className="meta" style={{ margin: "6px 0 0" }}>
                                {unusedCode(g) && !extra ? "A magic word was created and hasn't been used. " : ""}
                                The bot leaves {time(leaveAt)} if no correct magic word arrives.
                              </p>
                            )}
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                  {groups.length === 0 && (
                    <tr><td colSpan={4} className="empty">The bot isn&apos;t in any groups yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="admin-side">
            <section className="card stack">
              <h2>Adding a new group</h2>
              <ol className="steps">
                <li>Add the bot to the WhatsApp group. It asks for the magic word.</li>
                <li>The group appears here as <strong>Waiting for magic word</strong>.</li>
                <li>Click <strong>Create magic word</strong> on its row and share it with that group.</li>
                <li>Someone replies with it. The word only works in that group; anywhere else the bot leaves.</li>
              </ol>
            </section>

            <form id="credentials" className="card stack" onSubmit={changeOwnPassword}>
              <h2>
                Super user credentials
                <span className="pill pill-dark">Only you see this</span>
              </h2>
              <p className="hint" style={{ margin: 0 }}>
                Signed in as <strong>{username}</strong>. You automatically control every group, including new ones the
                moment they&apos;re activated. Nothing to grant per group.
              </p>
              <div>
                <label htmlFor="np">New super user password</label>
                <input id="np" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div>
                <label htmlFor="cp">Type it again</label>
                <input id="cp" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              </div>
              <button type="submit" disabled={!newPassword}>Change super user password</button>
              {saved && <p className="hint" style={{ margin: 0 }}>{saved}</p>}
            </form>
          </aside>
        </div>
      </main>
    </div>
  );
}
