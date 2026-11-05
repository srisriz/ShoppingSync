"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useFamily, signOut } from "@/lib/useFamily";
import type { Member, Shop, Synonym } from "@/lib/types";
import { buildSynonymGroups, groupList } from "@/lib/matching";

/** Comma-separated text to a list, dropping blanks and case-insensitive repeats. */
const splitList = (s: string) => {
  const seen = new Set<string>();
  return s.split(",").map((x) => x.trim()).filter((x) => {
    const key = x.toLowerCase();
    if (!x || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export default function ProfilePage() {
  const { family, setFamily, loading, isSuper } = useFamily();
  const [members, setMembers] = useState<Member[]>([]);
  const [shops, setShops] = useState<Shop[]>([]);
  const [synonyms, setSynonyms] = useState<Synonym[]>([]);
  const [wordA, setWordA] = useState("");
  const [wordB, setWordB] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [familyName, setFamilyName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [newMember, setNewMember] = useState("");

  useEffect(() => {
    if (family) {
      setFamilyName(family.name);
      setGroupName(family.whatsapp_group_name);
    }
  }, [family]);

  const load = useCallback(async () => {
    if (!family) return;
    const fid = family.id; // limited to this group (the super user can read all groups)
    const [m, s, syn] = await Promise.all([
      supabase.from("members").select("*").eq("family_id", fid).order("display_name"),
      supabase.from("shops").select("*").eq("family_id", fid).order("priority").order("name"),
      supabase.from("synonyms").select("*").eq("family_id", fid).order("created_at"),
    ]);
    if (m.error || s.error || syn.error) setError((m.error ?? s.error ?? syn.error)!.message);
    setMembers((m.data as Member[]) ?? []);
    setShops((s.data as Shop[]) ?? []);
    setSynonyms((syn.data as Synonym[]) ?? []);
  }, [family]);

  useEffect(() => { if (family) load(); }, [family, load]);

  function flash(msg: string) {
    setSaved(msg);
    setTimeout(() => setSaved(null), 2500);
  }

  async function saveFamily(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const values = { name: familyName.trim(), whatsapp_group_name: groupName.trim() };
    if (family) {
      const { error } = await supabase.from("families").update(values).eq("id", family.id);
      if (error) return setError(error.message);
      setFamily({ ...family, ...values });
    } else {
      // Login exists but the family was never created (e.g. email confirmation was on).
      const { data: auth } = await supabase.auth.getSession();
      if (!auth.session) return setError("Please sign in again.");
      const { data, error } = await supabase.from("families")
        .insert({ ...values, owner_id: auth.session.user.id })
        .select("id, name, whatsapp_group_name").single();
      if (error) return setError(error.message);
      setFamily(data);
    }
    flash("Family details saved");
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    if (!family || !newMember.trim()) return;
    const { error } = await supabase.from("members").insert({ family_id: family.id, display_name: newMember.trim() });
    if (error) return setError(error.message);
    setNewMember("");
    load();
  }

  async function addSynonym(e: React.FormEvent) {
    e.preventDefault();
    if (!family || !wordA.trim() || !wordB.trim()) return;
    if (wordA.trim().toLowerCase() === wordB.trim().toLowerCase()) return setError("Use two different words.");
    const { error } = await supabase.from("synonyms").insert({ family_id: family.id, word_a: wordA.trim(), word_b: wordB.trim() });
    if (error) return setError(error.message.includes("duplicate") ? "That pair is already saved." : error.message);
    setWordA("");
    setWordB("");
    flash("Synonym saved");
    load();
  }

  async function removeSynonym(pair: Synonym) {
    const { error } = await supabase.from("synonyms").delete().eq("id", pair.id);
    if (error) return setError(error.message);
    load();
  }

  async function removeMember(m: Member) {
    if (!window.confirm(`Remove ${m.display_name} from the family?`)) return;
    const { error } = await supabase.from("members").delete().eq("id", m.id);
    if (error) return setError(error.message);
    load();
  }

  if (loading) return <main className="page"><p className="empty">Loading…</p></main>;

  return (
    <main className="page">
      <div className="topbar">
        <h1>Group settings</h1>
        <nav>
          {isSuper && <Link href="/admin">All groups</Link>}
          {family && <Link href={isSuper ? `/?g=${family.id}` : "/"}>Shopping list</Link>}
          <button className="link" onClick={signOut}>Sign out</button>
        </nav>
      </div>

      {error && <p className="error">{error}</p>}
      {saved && <div className="banner">{saved}</div>}

      <form className="card stack" onSubmit={saveFamily}>
        <h2>Group</h2>
        <div>
          <label htmlFor="familyName">Name on the console</label>
          <input id="familyName" required value={familyName} onChange={(e) => setFamilyName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="groupName">WhatsApp group name</label>
          <input id="groupName" required value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          <p className="hint">The bot recognises the group by WhatsApp&apos;s own id, so renaming either one is fine.</p>
        </div>
        <button type="submit">{family ? "Save" : "Create family"}</button>
      </form>

      {family && (
        <>
          <section className="card stack">
            <h2>Members <span className="count">{members.length}</span></h2>
            <div className="chips">
              {members.map((m) => (
                <span key={m.id} className="chip">
                  {m.display_name}
                  <button aria-label={`Remove ${m.display_name}`} onClick={() => removeMember(m)}>×</button>
                </span>
              ))}
              {members.length === 0 && <span className="empty">No members yet.</span>}
            </div>
            <form className="row" onSubmit={addMember}>
              <input aria-label="New member name" placeholder="Name as shown in the group"
                value={newMember} onChange={(e) => setNewMember(e.target.value)} />
              <button type="submit" style={{ flex: "0 0 auto" }}>Add</button>
            </form>
          </section>

          <section className="card stack">
            <h2>Synonyms <span className="count">{synonyms.length} pair{synonyms.length === 1 ? "" : "s"}</span></h2>
            <p className="hint" style={{ marginTop: 0 }}>
              Words your family uses for the same thing, e.g. paal and milk. The list keeps the word that was typed;
              synonyms are used to find the shop, merge duplicates, and tick items off. You can also send
              &quot;paal means milk&quot; in the WhatsApp group.
            </p>
            {groupList(buildSynonymGroups(synonyms)).filter((g) => g.length > 2).map((g) => (
              <p key={g.join("|")} className="hint">Same thing: {g.join(" = ")}</p>
            ))}
            <div className="chips">
              {synonyms.map((p) => (
                <span key={p.id} className="chip">
                  {p.word_a} = {p.word_b}
                  <button aria-label={`Remove ${p.word_a} = ${p.word_b}`} onClick={() => removeSynonym(p)}>×</button>
                </span>
              ))}
              {synonyms.length === 0 && <span className="empty">No synonyms yet.</span>}
            </div>
            <form className="row" onSubmit={addSynonym}>
              <input aria-label="Word" placeholder="e.g. paal" value={wordA} onChange={(e) => setWordA(e.target.value)} />
              <input aria-label="Means the same as" placeholder="e.g. milk" value={wordB} onChange={(e) => setWordB(e.target.value)} />
              <button type="submit" style={{ flex: "0 0 auto" }}>Add</button>
            </form>
          </section>

          <section className="stack">
            <h2 style={{ fontSize: 18, margin: "24px 0 4px" }}>Shops</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              Example items are matched straight away. Lower priority numbers win when two shops sell the same thing.
            </p>
            {shops.map((s) => (
              <ShopEditor key={s.id} familyId={family.id} shop={s} onChange={load} onError={setError} onSaved={flash} />
            ))}
            <ShopEditor familyId={family.id} onChange={load} onError={setError} onSaved={flash} />
          </section>
        </>
      )}
    </main>
  );
}

function ShopEditor({ familyId, shop, onChange, onError, onSaved }: {
  familyId: string;
  shop?: Shop;
  onChange: () => void;
  onError: (msg: string) => void;
  onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState(shop?.name ?? "");
  const [categories, setCategories] = useState(shop?.categories.join(", ") ?? "");
  const [examples, setExamples] = useState(shop?.example_items.join(", ") ?? "");
  const [priority, setPriority] = useState(String(shop?.priority ?? 100));
  const [notes, setNotes] = useState(shop?.notes ?? "");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const values = {
      family_id: familyId,
      name: name.trim(),
      categories: splitList(categories),
      example_items: splitList(examples),
      priority: Number.parseInt(priority, 10) || 100,
      notes: notes.trim() || null,
    };
    const query = shop
      ? supabase.from("shops").update(values).eq("id", shop.id).select("id").single()
      : supabase.from("shops").insert(values).select("id").single();
    const { data, error } = await query;
    if (error) { setBusy(false); return onError(error.message); }

    // Every example item becomes a starting rule for this shop.
    if (values.example_items.length > 0) {
      const { error: ruleError } = await supabase.from("rules").upsert(
        values.example_items.map((item_name) => ({ family_id: familyId, item_name, shop_id: data.id, origin: "setup" })),
        { onConflict: "family_id,item_key" }
      );
      if (ruleError) onError(ruleError.message);
    }
    setBusy(false);
    if (!shop) { setName(""); setCategories(""); setExamples(""); setPriority("100"); setNotes(""); }
    onSaved(`${values.name} saved`);
    onChange();
  }

  async function remove() {
    if (!shop || !window.confirm(`Delete ${shop.name}? Its items move to Unassigned.`)) return;
    const { error } = await supabase.from("shops").delete().eq("id", shop.id);
    if (error) return onError(error.message);
    onChange();
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>{shop ? shop.name : "Add a shop"}</h2>
      <div className="row">
        <div style={{ flexBasis: "220px" }}>
          <label>Shop name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tesco" />
        </div>
        <div style={{ flex: "0 1 110px" }}>
          <label>Priority</label>
          <input type="number" min={1} value={priority} onChange={(e) => setPriority(e.target.value)} />
        </div>
      </div>
      <div>
        <label>What you buy there (categories, comma separated)</label>
        <input value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="e.g. dairy, bread, fruit and veg" />
      </div>
      <div>
        <label>Example items (comma separated)</label>
        <input value={examples} onChange={(e) => setExamples(e.target.value)} placeholder="e.g. milk, eggs, bread" />
      </div>
      <div>
        <label>Notes</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional, e.g. closed Sundays" />
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button type="submit" disabled={busy} style={{ flex: "0 0 auto" }}>{shop ? "Save" : "Add shop"}</button>
        {shop && <button type="button" className="danger" style={{ flex: "0 0 auto" }} onClick={remove}>Delete shop</button>}
      </div>
    </form>
  );
}
