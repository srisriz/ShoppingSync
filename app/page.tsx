"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, itemKey } from "@/lib/supabase";
import { buildSynonymGroups, sameItem, suggestShop as matchShop, type SynonymGroups } from "@/lib/matching";
import { useFamily, signOut } from "@/lib/useFamily";
import type { Item, Member, Rule, Shop, SyncState } from "@/lib/types";

const WHO_KEY = "shoppingsync.who";
const UNASSIGNED = "unassigned";

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default function ListPage() {
  const { family, loading, isSuper, groups: allGroups, selectGroup } = useFamily();
  const [shops, setShops] = useState<Shop[]>([]);
  const [items, setItems] = useState<Item[]>([]);        // open: still to buy
  const [previous, setPrevious] = useState<Item[]>([]);  // closed: bought or removed
  const [rules, setRules] = useState<Rule[]>([]);
  const [synonyms, setSynonyms] = useState<SynonymGroups>(new Map());
  const [members, setMembers] = useState<Member[]>([]);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add form
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [shopChoice, setShopChoice] = useState("auto");
  const [who, setWho] = useState("");

  useEffect(() => {
    try { setWho(localStorage.getItem(WHO_KEY) ?? ""); } catch { /* storage unavailable */ }
  }, []);

  const load = useCallback(async () => {
    if (!family) return;
    const fid = family.id; // every query is limited to this group (the super user can read all groups)
    const [s, i, r, m, st, prev, syn] = await Promise.all([
      supabase.from("shops").select("*").eq("family_id", fid).order("priority").order("name"),
      supabase.from("items").select("*").eq("family_id", fid).eq("status", "needed").order("created_at"),
      supabase.from("rules").select("id, item_key, shop_id").eq("family_id", fid),
      supabase.from("members").select("*").eq("family_id", fid).order("display_name"),
      supabase.from("sync_state").select("last_synced_at").eq("family_id", fid).maybeSingle(),
      supabase.from("items").select("*").eq("family_id", fid).in("status", ["bought", "removed"])
        .order("bought_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("synonyms").select("word_a, word_b").eq("family_id", fid),
    ]);
    const firstError = [s, i, r, m, st, prev, syn].find((x) => x.error)?.error;
    if (firstError) setError(firstError.message);
    setShops((s.data as Shop[]) ?? []);
    setItems((i.data as Item[]) ?? []);
    setRules((r.data as Rule[]) ?? []);
    setSynonyms(buildSynonymGroups((syn.data as { word_a: string; word_b: string }[]) ?? []));
    setMembers((m.data as Member[]) ?? []);
    setSync((st.data as SyncState) ?? null);
    setPrevious((prev.data as Item[]) ?? []);
  }, [family]);

  useEffect(() => {
    if (!family) return;
    load();
    // Live updates: anything that changes an item (web, WhatsApp sync) refreshes the list.
    const channel = supabase
      .channel(`items-live-${family.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: `family_id=eq.${family.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [family, load]);

  const shopIds = useMemo(() => new Set(shops.map((s) => s.id)), [shops]);
  const groups = useMemo(() => {
    const byShop = new Map<string, Item[]>();
    for (const item of items) {
      const key = item.shop_id && shopIds.has(item.shop_id) ? item.shop_id : UNASSIGNED;
      byShop.set(key, [...(byShop.get(key) ?? []), item]);
    }
    return byShop;
  }, [items, shopIds]);

  /** Shared with the WhatsApp listener: rules, then example items, then categories. */
  function suggestShop(key: string): string | null {
    return matchShop(key, rules, shops, synonyms);
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!family || !name.trim()) return;
    setError(null);
    const key = itemKey(name);
    const requester = who || "Web";

    // Same item already on the list: add this person as a requester instead of a duplicate.
    const existing = items.find((it) => it.status === "needed" && sameItem(it.item_key, key, synonyms));
    if (existing) {
      const requested_by = existing.requested_by.includes(requester)
        ? existing.requested_by
        : [...existing.requested_by, requester];
      const { error } = await supabase.from("items")
        .update({ requested_by, quantity: quantity.trim() || existing.quantity })
        .eq("id", existing.id);
      if (error) setError(error.message);
    } else {
      const shop_id = shopChoice === "auto"
        ? suggestShop(key)
        : shopChoice === UNASSIGNED ? null : shopChoice;
      const { error } = await supabase.from("items").insert({
        family_id: family.id,
        name: name.trim(),
        quantity: quantity.trim() || null,
        shop_id,
        requested_by: [requester],
        source: "web",
      });
      if (error) setError(error.message);
    }
    setName("");
    setQuantity("");
    setShopChoice("auto");
    load();
  }

  /** Re-run rule matching on everything in Unassigned (e.g. after adding shops). */
  async function sortUnassigned() {
    const unassigned = groups.get(UNASSIGNED) ?? [];
    let moved = 0;
    for (const item of unassigned) {
      const shop_id = suggestShop(item.item_key);
      if (!shop_id) continue;
      const { error } = await supabase.from("items").update({ shop_id }).eq("id", item.id);
      if (error) { setError(error.message); break; }
      moved++;
    }
    if (moved === 0) setError("No rule matches yet. Confirm a suggestion, pick a shop, or add example items on the family profile.");
    load();
  }

  async function toggleBought(item: Item) {
    const bought = item.status !== "bought";
    const { error } = await supabase.from("items").update({
      status: bought ? "bought" : "needed",
      bought_at: bought ? new Date().toISOString() : null,
    }).eq("id", item.id);
    if (error) setError(error.message);
    load();
  }

  async function moveItem(item: Item, shopId: string) {
    if (!family) return;
    const shop_id = shopId === UNASSIGNED ? null : shopId;
    const { error } = await supabase.from("items").update({ shop_id }).eq("id", item.id);
    if (error) { setError(error.message); return; }
    // A move is a decision: remember it so this item goes to the same shop next time.
    if (shop_id) {
      const origin = shop_id === item.proposed_shop_id ? "answer" : "correction";
      const { error: ruleError } = await supabase.from("rules").upsert(
        { family_id: family.id, item_name: item.name, shop_id, origin },
        { onConflict: "family_id,item_key" }
      );
      if (ruleError) setError(ruleError.message);
    }
    load();
  }

  /** Accept the AI's suggestion: same as moving the item there, saved as a confirmed rule. */
  async function confirmProposal(item: Item) {
    if (item.proposed_shop_id) await moveItem(item, item.proposed_shop_id);
  }

  /** Puts a closed item back on the current list. */
  async function reopen(item: Item) {
    const { error } = await supabase.from("items").update({ status: "needed", bought_at: null }).eq("id", item.id);
    if (error) setError(error.message);
    load();
  }

  /** Clear the current list: every open item moves to Previous (as removed). */
  async function clearCurrent() {
    if (items.length === 0) return;
    if (!window.confirm(`Clear all ${items.length} open item(s)? They move to Previous, where you can put any back.`)) return;
    if (!family) return;
    const { error } = await supabase.from("items").update({ status: "removed" }).eq("family_id", family.id).eq("status", "needed");
    if (error) setError(error.message);
    load();
  }

  /** Clear Previous: deletes closed items for good. Saved shop rules are kept. */
  async function clearPrevious() {
    if (previous.length === 0) return;
    if (!window.confirm(`Delete all previous items for good? This can't be undone. Shop rules the list has learned are kept.`)) return;
    if (!family) return;
    const { error } = await supabase.from("items").delete().eq("family_id", family.id).in("status", ["bought", "removed"]);
    if (error) setError(error.message);
    load();
  }

  async function removeItem(item: Item) {
    const { error } = await supabase.from("items").update({ status: "removed" }).eq("id", item.id);
    if (error) setError(error.message);
    load();
  }

  function chooseWho(value: string) {
    setWho(value);
    try { localStorage.setItem(WHO_KEY, value); } catch { /* storage unavailable */ }
  }

  if (loading) return <main className="page"><p className="empty">Loading…</p></main>;
  if (!family) {
    return (
      <main className="page">
        <p className="empty">This login isn&apos;t linked to a WhatsApp group. Use the one-time setup link the bot sent you, or ask the owner for a new one.</p>
      </main>
    );
  }

  const shopNames = new Map(shops.map((s) => [s.id, s.name]));
  const sections = [
    { id: UNASSIGNED, title: "Needs review" },
    ...shops.map((s) => ({ id: s.id, title: s.name })),
  ].filter((sec) => (groups.get(sec.id)?.length ?? 0) > 0);

  return (
    <>
    {isSuper && (
      <div className="super-banner">
        <div className="super-banner-inner">
          <span>You&apos;re viewing <strong>{family.name}</strong> as the super user.</span>
          <Link href="/admin">← All groups</Link>
        </div>
      </div>
    )}
    <main className="page">
      <div className="topbar">
        {isSuper ? (
          <>
            <label htmlFor="grp" className="visually-hidden">Group</label>
            <select id="grp" className="group-switcher" value={family.id} onChange={(e) => selectGroup(e.target.value)}>
              {allGroups.filter((g) => g.status !== "pending").map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </>
        ) : (
          <h1>{family.name}</h1>
        )}
        <nav>
          <Link href={isSuper ? `/profile?g=${family.id}` : "/profile"}>Group settings</Link>
          <button className="link" onClick={signOut}>Sign out</button>
        </nav>
      </div>
      {family.status && family.status !== "active" && (
        <div className="banner">The bot is no longer in this WhatsApp group, so changes here won&apos;t reach the chat.</div>
      )}

      <div className="banner">
        {sync?.last_synced_at
          ? `Last updated from WhatsApp ${timeAgo(sync.last_synced_at)}`
          : "WhatsApp is not connected yet. Items added here appear straight away."}
      </div>

      <form className="card stack" onSubmit={addItem}>
        <h2>Add an item</h2>
        <div className="row">
          <div style={{ flexBasis: "200px" }}>
            <label htmlFor="name">Item</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. paneer" required />
          </div>
          <div>
            <label htmlFor="qty">Quantity</label>
            <input id="qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <div className="row">
          <div>
            <label htmlFor="shop">Shop</label>
            <select id="shop" value={shopChoice} onChange={(e) => setShopChoice(e.target.value)}>
              <option value="auto">Choose for me</option>
              {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value={UNASSIGNED}>Needs review</option>
            </select>
          </div>
          <div>
            <label htmlFor="who">Who&apos;s asking</label>
            <select id="who" value={who} onChange={(e) => chooseWho(e.target.value)}>
              <option value="">Not saying</option>
              {members.map((m) => <option key={m.id} value={m.display_name}>{m.display_name}</option>)}
            </select>
          </div>
        </div>
        <button type="submit">Add to list</button>
        {error && <p className="error">{error}</p>}
      </form>

      <div className="section-head">
        <h2>Current <span className="count">{items.length} open</span></h2>
        <button className="secondary" onClick={clearCurrent} disabled={items.length === 0}>Clear</button>
      </div>

      {sections.length === 0 && (
        <p className="empty">
          Nothing to buy.{shops.length === 0 && <> Add your shops in <Link href="/profile">group settings</Link> first.</>}
        </p>
      )}

      {sections.map((sec) => {
        const list = groups.get(sec.id) ?? [];
        const needed = list.filter((i) => i.status === "needed").length;
        return (
          <section key={sec.id} className={`card${sec.id === UNASSIGNED ? " unassigned" : ""}`}>
            <h2>
              {sec.title}
              <span className="count">
                {sec.id === UNASSIGNED && (
                  <><button className="link" onClick={sortUnassigned}>Re-check rules</button> · </>
                )}
                {needed} to buy
              </span>
            </h2>
            <ul className="items">
              {list.map((item) => (
                <li key={item.id} className="item">
                  <input type="checkbox" aria-label={`Bought ${item.name}`}
                    checked={false} onChange={() => toggleBought(item)} />
                  <div>
                    <div className="name">
                      {item.name}{item.quantity ? ` · ${item.quantity}` : ""}
                    </div>
                    <div className="meta">
                      {item.requested_by.join(", ") || "Someone"} · {timeAgo(item.created_at)}
                      {item.source === "whatsapp" ? " · WhatsApp" : ""}
                    </div>
                    {sec.id === UNASSIGNED && (
                      <div className="suggestion">
                        {!item.proposed_at && <span className="meta">Waiting for a suggestion…</span>}
                        {item.proposed_at && item.proposed_shop_id && shopNames.has(item.proposed_shop_id) && (
                          <>
                            <span>
                              Suggested: <strong>{shopNames.get(item.proposed_shop_id)}</strong>
                              {item.proposal_confidence != null && ` (${Math.round(item.proposal_confidence * 100)}%)`}
                              {item.proposal_reason && <span className="meta"> · {item.proposal_reason}</span>}
                            </span>
                            <button className="confirm" onClick={() => confirmProposal(item)}>Confirm</button>
                          </>
                        )}
                        {item.proposed_at && !(item.proposed_shop_id && shopNames.has(item.proposed_shop_id)) && (
                          <span className="meta">{item.proposal_reason || "No suggestion"} · choose a shop</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <select aria-label={`Move ${item.name}`} value={item.shop_id && shopIds.has(item.shop_id) ? item.shop_id : UNASSIGNED}
                      onChange={(e) => moveItem(item, e.target.value)}>
                      {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      <option value={UNASSIGNED}>Needs review</option>
                    </select>
                    <button className="danger" aria-label={`Remove ${item.name}`} onClick={() => removeItem(item)}>✕</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <div className="section-head previous-head">
        <h2>Previous <span className="count">{previous.length} closed</span></h2>
        <button className="secondary" onClick={clearPrevious} disabled={previous.length === 0}>Clear</button>
      </div>
      {previous.length === 0 ? (
        <p className="empty">Bought and removed items appear here.</p>
      ) : (
        <section className="card">
          <ul className="items">
            {previous.map((item) => (
              <li key={item.id} className="item bought">
                <input type="checkbox" aria-label={`Put ${item.name} back on the list`}
                  checked onChange={() => reopen(item)} />
                <div>
                  <div className="name">{item.name}{item.quantity ? ` · ${item.quantity}` : ""}</div>
                  <div className="meta">
                    {item.status === "bought"
                      ? `Bought${item.bought_at ? ` ${timeAgo(item.bought_at)}` : ""}`
                      : "Removed"}
                    {item.shop_id && shopNames.has(item.shop_id) ? ` · ${shopNames.get(item.shop_id)}` : ""}
                    {item.requested_by.length ? ` · ${item.requested_by.join(", ")}` : ""}
                  </div>
                </div>
                <button className="link" onClick={() => reopen(item)}>Put back</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
    </>
  );
}
