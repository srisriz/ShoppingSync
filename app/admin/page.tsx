"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { signOut } from "@/lib/useFamily";
import { generateCode, generateToken, sha256Hex } from "@/lib/codes";
import { normalisePhone, prettyPhone, waLink } from "@/lib/phone";

type GroupRow = {
  id: string;
  name: string;
  status: "pending" | "active" | "inactive" | "left";
  owner_id: string | null;
  console_username: string | null;
  created_at: string;
  activated_at: string | null;
  prompt_sent_at: string | null;
  added_by_number: string | null;
  added_by_name: string | null;
  created_by_number: string | null;
  created_by_name: string | null;
  activated_by_name: string | null;
};
type InviteRow = {
  id: string; name: string; number: string; created_at: string; expires_at: string;
  opened_at: string | null; cancelled_at: string | null; used_at: string | null; family_id: string | null;
};
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

type CodeRow = { family_id: string | null; used_at: string | null; expires_at: string | null };

const ACTIVATION_WINDOW_MS = 24 * 3600 * 1000;
const SETUP_LINK_TTL_MS = 48 * 3600 * 1000;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const time = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

const phone = prettyPhone;
const person = (name: string | null, n: string | null) => [name, n && phone(n)].filter(Boolean).join(" · ");

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
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [inviteName, setInviteName] = useState("");
  const [inviteNumber, setInviteNumber] = useState("");
  const [newInvite, setNewInvite] = useState<{ id: string; name: string; number: string; link: string } | null>(null);
  const [shown, setShown] = useState<Record<string, { kind: "code" | "link" | "password"; value: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [g, it, sh, c, inv] = await Promise.all([
      supabase.from("families")
        .select("id, name, status, owner_id, console_username, created_at, activated_at, prompt_sent_at, added_by_number, added_by_name, created_by_number, created_by_name, activated_by_name")
        .order("created_at"),
      supabase.from("items").select("family_id").eq("status", "needed"),
      supabase.from("shops").select("family_id"),
      supabase.from("activation_codes").select("family_id, used_at, expires_at"),
      supabase.from("invites")
        .select("id, name, number, created_at, expires_at, opened_at, cancelled_at, used_at, family_id")
        .order("created_at", { ascending: false }).limit(50),
    ]);
    const firstError = [g, it, sh, c, inv].find((x) => x.error)?.error;
    if (firstError) setError(firstError.message);
    const tally: Record<string, { items: number; shops: number }> = {};
    for (const r of (it.data ?? []) as { family_id: string }[]) (tally[r.family_id] ??= { items: 0, shops: 0 }).items++;
    for (const r of (sh.data ?? []) as { family_id: string }[]) (tally[r.family_id] ??= { items: 0, shops: 0 }).shops++;
    setGroups((g.data as GroupRow[]) ?? []);
    setCounts(tally);
    setCodes((c.data as CodeRow[]) ?? []);
    setInvites((inv.data as InviteRow[]) ?? []);
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

  /** A personal invite: their link shows the bot's number, and their number skips the magic word. */
  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const name = inviteName.trim();
    const number = normalisePhone(inviteNumber);
    if (!name) return setError("Who is the invite for?");
    if (!number) return setError("Enter their WhatsApp number, e.g. 07700 900123 or +91 98400 12345.");
    const token = generateToken();
    const { data: auth } = await supabase.auth.getSession();
    // A new invite for the same number replaces any earlier one that hasn't been used.
    await supabase.from("invites").update({ cancelled_at: new Date().toISOString() })
      .eq("number", number).is("used_at", null).is("cancelled_at", null);
    const { data, error } = await supabase.from("invites").insert({
      name, number, token_hash: await sha256Hex(token),
      created_by: auth.session?.user.id ?? null,
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    }).select("id").single();
    if (error || !data) return setError(error?.message ?? "Couldn't create the invite.");
    setNewInvite({ id: data.id, name, number, link: `${window.location.origin}/use-me?invite=${token}` });
    setInviteName("");
    setInviteNumber("");
    load();
  }

  async function cancelInvite(i: InviteRow) {
    if (!window.confirm(`Cancel ${i.name}'s invite? Their link stops working.`)) return;
    const { error } = await supabase.from("invites").update({ cancelled_at: new Date().toISOString() }).eq("id", i.id);
    if (error) return setError(error.message);
    if (newInvite?.id === i.id) setNewInvite(null);
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
          <div className="admin-left">
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
                          {g.added_by_number ? (
                            <div className="meta who">Added by <strong>{person(g.added_by_name, g.added_by_number)}</strong></div>
                          ) : g.status === "pending" ? (
                            <div className="meta who">Added by: not known (the bot was offline when it was added)</div>
                          ) : null}
                          {g.created_by_number && g.created_by_number !== g.added_by_number && (
                            <div className="meta who">Group created by {person(g.created_by_name, g.created_by_number)}</div>
                          )}
                          {g.status !== "pending" && g.activated_by_name && (
                            <div className="meta who">Magic word given by {g.activated_by_name}</div>
                          )}
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
                                {(g.added_by_number ?? g.created_by_number) && (
                                  <div style={{ marginTop: 8 }}>
                                    <a className="button-link" target="_blank" rel="noreferrer"
                                      href={waLink(g.added_by_number ?? g.created_by_number!,
                                        `Your ShoppingSync magic word for "${g.name}" is ${extra.value}\n\nReply to the bot's message in the group with it. It works once, only in that group.`)}>
                                      Send privately to {g.added_by_name ?? phone(g.added_by_number ?? g.created_by_number!)} on WhatsApp
                                    </a>
                                  </div>
                                )}
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

          <section className="card stack" id="invites">
            <h2>Invites <span className="count">{invites.filter((i) => !i.cancelled_at).length}</span></h2>
            <p className="hint" style={{ margin: 0 }}>
              Invite someone by their WhatsApp number. Their link opens the Use me page with the bot&apos;s number, and
              when that number adds the bot to a group, it switches on without a magic word. Links last 7 days and work once.
            </p>
            <form className="invite-form" onSubmit={createInvite}>
              <div>
                <label htmlFor="inv-name">Their name</label>
                <input id="inv-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Ramesh" />
              </div>
              <div>
                <label htmlFor="inv-num">WhatsApp number</label>
                <input id="inv-num" inputMode="tel" value={inviteNumber} onChange={(e) => setInviteNumber(e.target.value)} placeholder="07700 900123" />
              </div>
              <button type="submit">Create invite</button>
            </form>

            {newInvite && (
              <div className="banner banner-ok">
                Invite for <strong>{newInvite.name}</strong>: <code style={{ wordBreak: "break-all" }}>{newInvite.link}</code>
                <div className="meta" style={{ margin: "6px 0 8px" }}>Shown once. Send it only to {newInvite.name}.</div>
                <a className="button-link" target="_blank" rel="noreferrer"
                  href={waLink(newInvite.number, `Hi ${newInvite.name}, here's your personal invite to ShoppingSync, our family shopping list bot for WhatsApp:\n${newInvite.link}\n\nIt shows you how to set it up in about 10 minutes. The link is just for you and works for 7 days.`)}>
                  Send to {newInvite.name} on WhatsApp
                </a>
              </div>
            )}

            {invites.length > 0 && (
              <ul className="items">
                {invites.map((i) => {
                  const fam = groups.find((x) => x.id === i.family_id);
                  const expired = !i.used_at && Date.parse(i.expires_at) <= now;
                  const ended = i.cancelled_at ? "Cancelled" : expired ? "Expired" : null;
                  const stages: [string, boolean][] = [
                    ["Sent", true],
                    ["Opened", !!i.opened_at || !!i.used_at],
                    ["Group on", !!i.used_at],
                    ["Login set up", !!fam?.owner_id],
                  ];
                  return (
                    <li key={i.id} className="item" style={{ gridTemplateColumns: "1fr auto" }}>
                      <div>
                        <div className="name">{i.name} <span className="meta" style={{ fontWeight: 400 }}>{phone(i.number)}</span></div>
                        <div className="meta">
                          {ended ? `${ended} · ` : ""}invited {day(i.created_at)}
                          {fam ? ` · ${fam.name}` : !ended && !i.used_at ? ` · link works until ${day(i.expires_at)}` : ""}
                        </div>
                        {!ended && <div className="funnel" style={{ marginTop: 6 }}>
                          {stages.map(([label, done]) => <span key={label} className={done ? "done" : ""}>{done ? "✓ " : ""}{label}</span>)}
                        </div>}
                      </div>
                      {!ended && !i.used_at && <button className="danger" onClick={() => cancelInvite(i)}>Cancel</button>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          </div>

          <aside className="admin-side">
            <section className="card stack">
              <h2>Adding a new group</h2>
              <p className="hint" style={{ margin: 0 }}>
                Easiest: <a href="#invites">invite them</a>. Their group switches on by itself. Otherwise:
              </p>
              <ol className="steps">
                <li>Add the bot to the WhatsApp group. It asks for the magic word.</li>
                <li>The group appears here as <strong>Waiting for magic word</strong>.</li>
                <li>Check <strong>Added by</strong> is someone you expect. If not, do nothing: the bot leaves after 24 hours.</li>
                <li>Click <strong>Create magic word</strong>, then <strong>Send privately</strong> to that person on WhatsApp.</li>
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
