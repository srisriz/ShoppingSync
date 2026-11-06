"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { handleMessage, maybeStartOnboarding, processQueuedMessages, proposeForReviewItems } from "@/lib/bot/core";
import { demoSeed, memoryStore, newGroupSeed, newId, type DemoData } from "@/lib/bot/memory";
import type { Bot, BotState, IncomingMessage } from "@/lib/bot/ports";
import { demoAi, type AiMode } from "@/lib/sim/demoAi";
import { normalise } from "@/lib/matching";

type ChatMsg = {
  id: string;
  from: string;                 // "bot" or a family member
  text: string;
  at: Date;
  quotedId: string | null;
  reaction?: string;
  trace?: string[];             // what the bot did with this message
  system?: boolean;
};

const SENDERS = ["You", "Amma", "Appa", "Ravi", "Priya"];
const NAME_COLOURS: Record<string, string> = { Amma: "#b4357a", Appa: "#1f7a8c", Ravi: "#7a4fc4", Priya: "#c2571a" };

const SETUP_TRY = { label: "Answer the setup questions", messages: ["Tesco, Lidl and the Indian shop", "we mostly go to Tesco and the Indian shop near us, sometimes Boots", "yes", "milk, bread, eggs, pasta", "skip", "stop setup"] };

/** Things you can say: tap one to send it in the demo. */
const TRY: { label: string; items: [string, string][] }[] = [
  { label: "Adding things", items: [
    ["milk", "Goes straight under the right shop."],
    ["eggs, bread and butter", "Several at once."],
    ["2 more eggs", "Adds to what's already there."],
    ["kitchen roll", "Not sure where? It goes to Needs review and the AI suggests a shop."],
    ["we're out of rice", "Running out counts as “add it”."],
  ] },
  { label: "In your own words", items: [
    ["paal venum", "Tanglish: family words are kept as typed."],
    ["doodh chahiye", "Hinglish is translated first."],
    ["thakkali theernduchu", "“Tomatoes are finished”, so it adds tomatoes."],
    ["रास्ते में नमक खरीद लें", "Other scripts too; it checks before acting."],
    ["can you pick up lemons and coriander on the way home", "A sentence: the AI reads it and asks you to confirm."],
  ] },
  { label: "Ticking off", items: [
    ["got milk", "Ticks one thing off."],
    ["done Tesco", "Ticks off a whole shop."],
    ["list", "The whole list by shop. Reply “Done” to it (tap the list, then ↩) to tick off everything."],
    ["cancel eggs", "Takes something off without buying it."],
  ] },
  { label: "Teaching it", items: [
    ["thakkali means tomatoes", "A family word, remembered from now on."],
    ["eggs are better in Waitrose", "Where you like to buy something."],
    ["The new Ramayana movie should be seen at iMax", "Outings get a place too."],
    ["add shop Lidl: fruit, veg", "A new shop, with what you buy there."],
    ["replace riz with rice", "Fixes a misspelt item."],
  ] },
  { label: "Everything else", items: [
    ["help", "What the bot can do."],
    ["summary", "What happened on the list today."],
    ["what time is it in Chennai?", "Answers questions meant for it."],
    ["Amma what time are you home?", "Stays out of family conversations."],
  ] },
];
const QUICK = ["milk", "paal venum", "eggs, bread and butter", "we're out of rice", "list", "got milk", "eggs are better in Waitrose", "what time is it in Chennai?"];

/** WhatsApp formatting: *bold*, _italic_, line breaks. */
function Formatted({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*[^*]+\*$/.test(p) ? <strong key={i}>{p.slice(1, -1)}</strong>
          : /^_[^_]+_$/.test(p) ? <em key={i}>{p.slice(1, -1)}</em>
            : <span key={i}>{p}</span>)}
    </>
  );
}

const plain = (t: string) => t.split("\n")[0].replace(/[*_]/g, "");
const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const isAiLine = (line: string) => /^AI\b|asking the AI|AI read|AI translated|AI suggests|AI guessed|AI:|^↳/.test(line);

export default function Simulator() {
  const [start, setStart] = useState<"new" | "ready">("new");
  const data = useRef<DemoData>(newGroupSeed());
  // Which AI answers: Qwen on Groq when the website has a key, else the built-in stand-in.
  const aiMode = useRef<AiMode>("standin");
  const [aiStatus, setAiStatus] = useState<{ mode: AiMode; model?: string; note?: string }>({ mode: "standin", note: "checking…" });
  const state = useRef<BotState>({ aiReady: true, napNotified: false, aiBusy: false });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [sender, setSender] = useState("You");
  const [replyTo, setReplyTo] = useState<ChatMsg | null>(null);
  const [typing, setTyping] = useState(false);
  const [aiOn, setAiOn] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [tapped, setTapped] = useState<string | null>(null);   // on touch screens, shows that bubble's ↩ button
  const chatBox = useRef<HTMLDivElement>(null);
  const phone = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<ChatMsg[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    const box = chatBox.current;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  /** From the phrasebook: send it, and on a phone bring the chat back into view. */
  const tryPhrase = (t: string) => {
    send(t);
    const el = phone.current;
    if (el && window.matchMedia("(max-width: 860px)").matches) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 120 || r.top > window.innerHeight - 120) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const push = useCallback((m: ChatMsg) => setMessages((all) => [...all, m]), []);

  /** The bot, wired to this page: memory for data, the on-screen chat, the demo AI. */
  const makeBot = useCallback((trace: string[]): Bot => ({
    store: memoryStore(data.current),
    ai: demoAi(data.current, () => aiMode.current, (line) => trace.push(line),
      (why) => setAiStatus((st) => ({ ...st, note: `Groq unavailable just now (${why}); the stand-in is filling in` }))),
    state: state.current,
    chat: {
      async send(t, quote) {
        const id = newId("bot");
        setTyping(false);
        push({ id, from: "bot", text: t, at: new Date(), quotedId: quote?.id ?? null });
        refresh();
        return id;
      },
      async react(msg, emoji) {
        const id = (msg as IncomingMessage).id ?? String((msg as { ref: unknown }).ref);
        setMessages((all) => all.map((m) => (m.id === id ? { ...m, reaction: emoji } : m)));
      },
    },
    log: (line) => { trace.push(line); },
    pause: async (min, max) => {
      setTyping(true);
      await new Promise((r) => setTimeout(r, Math.min(min, 700) + Math.random() * (Math.min(max, 1200) - Math.min(min, 700))));
    },
    afterChange: () => {
      // As in the listener: AI shop suggestions run after the message, never alongside it.
      queue.current = queue.current.then(async () => {
        await proposeForReviewItems(makeBot(trace));   // its steps join this message's steps
        setTyping(false);
        refresh();
      });
    },
    now: () => new Date(),
  }), [push, refresh]);

  /** One message at a time, like the real bot's single queue. */
  const send = useCallback((raw: string, as = sender) => {
    const body = raw.trim();
    if (!body) return;
    const quoted = replyTo;
    const msg: ChatMsg = { id: newId("msg"), from: as, text: body, at: new Date(), quotedId: quoted?.id ?? null, trace: [] };
    push(msg);
    setSelected(msg.id);
    setText("");
    setReplyTo(null);
    queue.current = queue.current.then(async () => {
      const trace: string[] = [];
      const incoming: IncomingMessage = {
        id: msg.id, text: body, sender: as, quotedId: quoted?.id ?? null,
        quotedFrom: quoted ? (quoted.from === "bot" ? "bot" : "other") : null,
        mentionsBot: /@shoppingsync\b/i.test(body), mentionsOthers: /@(?!shoppingsync\b)\w+/i.test(body), ref: msg.id,
      };
      try {
        await handleMessage(makeBot(trace), incoming);
      } catch (err) {
        trace.push(`✗ ${err instanceof Error ? err.message : String(err)}`);
      }
      setTyping(false);
      setMessages((all) => all.map((m) => (m.id === msg.id ? { ...m, trace } : m)));
      refresh();
    });
  }, [sender, replyTo, push, makeBot, refresh]);

  /** Switching the AI back on: the listener's health check does the same. */
  const toggleAi = useCallback(() => {
    const on = !aiOn;
    setAiOn(on);
    state.current.aiReady = on;
    if (!on) return;
    state.current.napNotified = false;
    queue.current = queue.current.then(async () => {
      const trace: string[] = [];
      const parked = data.current.tasks.some((t) => t.kind === "extract" && t.status === "queued");
      if (parked) {
        const id = newId("sys");
        push({ id, from: "system", text: "The AI is back, so parked messages are picked up.", at: new Date(), quotedId: null, trace, system: true });
        setSelected(id);
      }
      const bot = makeBot(trace);
      await processQueuedMessages(bot);
      await proposeForReviewItems(bot);
      setTyping(false);
      refresh();
    });
  }, [aiOn, makeBot, push, refresh]);

  /** A new group: the bot says hello and starts the setup chat, as it does after a magic word or invite. */
  const begin = useCallback((mode: "new" | "ready") => {
    if (mode !== "new") return;
    queue.current = queue.current.then(async () => {
      const trace: string[] = [];
      const id = newId("sys");
      push({ id, from: "system", text: "ShoppingSync joined the group and was switched on.", at: new Date(), quotedId: null, trace, system: true });
      setSelected(id);
      await maybeStartOnboarding(makeBot(trace));
      setTyping(false);
      refresh();
    });
  }, [makeBot, push, refresh]);

  // First visit: find out whether Groq is set up, then start as a new group.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fetch("/api/demo-ai").then((r) => r.json()).then((j: { configured?: boolean; model?: string }) => {
      aiMode.current = j.configured ? "groq" : "standin";
      setAiStatus({ mode: aiMode.current, model: j.model?.replace(/^.*\//, ""), note: j.configured ? undefined : "not set up on this website" });
    }).catch(() => setAiStatus({ mode: "standin", note: "not reachable" }))
      .finally(() => begin("new"));
  }, [begin]);

  const reset = (mode: "new" | "ready" = start) => {
    setStart(mode);
    data.current = mode === "new" ? newGroupSeed() : demoSeed();
    state.current = { aiReady: true, napNotified: false, aiBusy: false };
    queue.current = Promise.resolve();
    setAiOn(true);
    setMessages([]);
    setSelected(null);
    setReplyTo(null);
    setTyping(false);
    refresh();
    begin(mode);
  };

  /** The web page's "Confirm" on an AI suggestion: saves a rule and moves the item. */
  const confirmSuggestion = (itemId: string, shopId: string) => {
    const d = data.current;
    const it = d.items.find((i) => i.id === itemId);
    if (!it) return;
    it.shop_id = shopId;
    const key = normalise(it.name);
    d.rules = d.rules.filter((r) => r.item_key !== key);
    d.rules.push({ item_key: key, item_name: it.name, shop_id: shopId, origin: "answer", created_at: Date.now() });
    refresh();
  };

  const d = data.current;
  const setupOpen = !!d.onboarding && d.onboarding.step !== "done";
  const shops = [...d.shops].sort((a, b) => a.priority - b.priority);
  const needed = d.items.filter((i) => i.status === "needed");
  const review = needed.filter((i) => !i.shop_id);
  const done = d.items.filter((i) => i.status !== "needed");
  const shopName = (id: string | null) => shops.find((s) => s.id === id)?.name ?? "";
  const chosen = messages.find((m) => m.id === selected) ?? [...messages].reverse().find((m) => m.trace);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const synonymPairs = d.synonyms;

  return (
    <div className="sim-grid">
      {/* ---------------------------------------------------------------- phone */}
      <section className="sim-phone-col">
        <div className="sim-phone" aria-label="WhatsApp group chat" ref={phone}>
          <div className="sim-notch" aria-hidden="true" />
          <header className="sim-wa-head">
            <div className="sim-avatar" aria-hidden="true">🛒</div>
            <div>
              <div className="sim-wa-title">Family Shopping</div>
              <div className="sim-wa-sub">{typing ? "ShoppingSync is typing…" : "Amma, Appa, Ravi, Priya, ShoppingSync, You"}</div>
            </div>
          </header>

          <div className="sim-chat" role="log" aria-live="polite" ref={chatBox}>
            {messages.length === 0 && (
              <div className="sim-empty">
                <p>👋 This is a family WhatsApp group with ShoppingSync in it.</p>
                <p>Type a message below, or tap a suggestion.</p>
              </div>
            )}
            {messages.map((m) => {
              if (m.system) return (
                <button key={m.id} className={`sim-system${selected === m.id ? " is-selected" : ""}`} onClick={() => setSelected(m.id)}>{m.text}</button>
              );
              const mine = m.from === "You";
              const bot = m.from === "bot";
              const quoted = m.quotedId ? byId.get(m.quotedId) : null;
              return (
                <div key={m.id} className={`sim-row ${mine ? "mine" : "theirs"}`}>
                  <div
                    className={`sim-bubble${bot ? " bot" : ""}${selected === m.id ? " is-selected" : ""}${tapped === m.id ? " tapped" : ""}`}
                    onClick={() => { setTapped(m.id); if (m.trace) setSelected(m.id); }}
                  >
                    {!mine && <div className="sim-name" style={{ color: bot ? "#128c7e" : NAME_COLOURS[m.from] }}>{bot ? "ShoppingSync" : m.from}</div>}
                    {quoted && (
                      <div className="sim-quote">
                        <b>{quoted.from === "bot" ? "ShoppingSync" : quoted.from}</b>
                        <span>{plain(quoted.text)}</span>
                      </div>
                    )}
                    <div className="sim-text"><Formatted text={m.text} /></div>
                    <div className="sim-meta">
                      {clock(m.at)}{mine && <span className="sim-ticks">✓✓</span>}
                    </div>
                    {m.reaction && <span className="sim-reaction">{m.reaction}</span>}
                    <button className="sim-reply" onClick={(e) => { e.stopPropagation(); setReplyTo(m); input.current?.focus(); }}
                      aria-label="Reply to this message" title="Reply">↩</button>
                  </div>
                </div>
              );
            })}
            {typing && <div className="sim-row theirs"><div className="sim-bubble bot sim-typing"><span /><span /><span /></div></div>}
          </div>

          <div className="sim-compose">
            <div className="sim-quick" aria-label="Suggestions">
              {(setupOpen ? SETUP_TRY.messages : QUICK).map((t) => (
                <button key={t} onClick={() => send(t)}>{t}</button>
              ))}
            </div>
            <div className="sim-as" role="radiogroup" aria-label="Send as">
              {SENDERS.map((s) => (
                <button key={s} role="radio" aria-checked={sender === s} className={sender === s ? "on" : ""} onClick={() => setSender(s)}>{s}</button>
              ))}
            </div>
            {replyTo && (
              <div className="sim-replying">
                <div><b>Replying to {replyTo.from === "bot" ? "ShoppingSync" : replyTo.from}</b><span>{plain(replyTo.text)}</span></div>
                <button onClick={() => setReplyTo(null)} aria-label="Cancel reply">✕</button>
              </div>
            )}
            <form className="sim-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
              <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message as ${sender}`} aria-label="Message" />
              <button type="submit" aria-label="Send" disabled={!text.trim()}>➤</button>
            </form>
          </div>
        </div>

        <div className="sim-controls">
          <div className="sim-seg" role="radiogroup" aria-label="Start as">
            <button role="radio" aria-checked={start === "new"} className={start === "new" ? "on" : ""} onClick={() => reset("new")}>New group</button>
            <button role="radio" aria-checked={start === "ready"} className={start === "ready" ? "on" : ""} onClick={() => reset("ready")}>Family already set up</button>
          </div>
          <button className="sim-link" onClick={() => reset()}>Start again</button>
        </div>
        <div className="sim-controls">
          <span className={`sim-ai-chip ${aiStatus.mode === "groq" && !aiStatus.note ? "live" : ""}`}>
            AI: {aiStatus.mode === "groq" ? `Qwen${aiStatus.model ? ` (${aiStatus.model})` : ""} on Groq` : "built-in stand-in"}
            {aiStatus.note ? <small> · {aiStatus.note}</small> : null}
          </span>
          <label className="sim-switch">
            <input type="checkbox" checked={aiOn} onChange={toggleAi} />
            <span>{aiOn ? "AI on" : "AI off: messages that need it are parked"}</span>
          </label>
        </div>
      </section>

      {/* ---------------------------------------------------------------- side */}
      <section className="sim-side">
        <div className="sim-panel">
          <h2>What the bot did</h2>
          {chosen?.trace ? (
            <>
              <p className="sim-hint">For <q>{chosen.text}</q>. Tap any message to see its steps.</p>
              <ol className="sim-trace">
                {chosen.trace.length === 0 && <li>Nothing to do.</li>}
                {chosen.trace.map((line, i) => <li key={i} className={isAiLine(line) ? "ai" : ""}><Formatted text={line} /></li>)}
              </ol>
              <p className="sim-note">
                Highlighted steps use the AI, with the bot&apos;s own prompts: here Qwen hosted on Groq (or a small built-in
                stand-in if that&apos;s unavailable); in a real family group, Qwen running on a private computer. Every other
                step is the bot&apos;s own code, unchanged.
              </p>
            </>
          ) : <p className="sim-hint">Send a message to see each step the bot takes.</p>}
        </div>

        <div className="sim-panel">
          <h2>The list <span className="sim-count">{needed.length}</span></h2>
          <p className="sim-hint">What the family sees on their web page.</p>
          {review.length > 0 && (
            <div className="sim-shop review">
              <h3>Needs review</h3>
              <ul>
                {review.map((i) => (
                  <li key={i.id}>
                    <span>{i.name}{i.quantity ? ` (${i.quantity})` : ""}</span>
                    {i.proposed_shop_id ? (
                      <span className="sim-suggest">
                        AI suggests {shopName(i.proposed_shop_id)}
                        <button onClick={() => confirmSuggestion(i.id, i.proposed_shop_id!)}>Confirm</button>
                      </span>
                    ) : <span className="sim-who">{i.proposed_at ? "no suggestion" : "AI is looking…"}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {shops.map((s) => {
            const list = needed.filter((i) => i.shop_id === s.id);
            if (!list.length) return null;
            return (
              <div key={s.id} className="sim-shop">
                <h3>{s.name}</h3>
                <ul>
                  {list.map((i) => (
                    <li key={i.id}>
                      <span>{i.name}{i.quantity ? ` (${i.quantity})` : ""}</span>
                      <span className="sim-who">{i.requested_by.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {needed.length === 0 && <p className="sim-hint">Nothing on the list yet.</p>}
          {done.length > 0 && (
            <p className="sim-done">Ticked off or removed: {done.map((i) => i.name).join(", ")}</p>
          )}
        </div>

        <div className="sim-panel sim-try-panel">
          <h2>Things you can say</h2>
          <p className="sim-hint">Tap any of these to send it as {sender}. Capitals don&apos;t matter, and full sentences work too.</p>
          {setupOpen && (
            <div className="sim-try">
              <h3>{SETUP_TRY.label}</h3>
              <div className="sim-phrases">
                {SETUP_TRY.messages.map((t) => (
                  <button key={t} className="sim-phrase" onClick={() => tryPhrase(t)}><span className="sim-say">{t}</span></button>
                ))}
              </div>
            </div>
          )}
          {TRY.map((g) => (
            <div key={g.label} className="sim-try">
              <h3>{g.label}</h3>
              <div className="sim-phrases">
                {g.items.map(([t, does]) => (
                  <button key={t} className="sim-phrase" onClick={() => tryPhrase(t)}>
                    <span className="sim-say">{t}</span>
                    <span className="sim-does">{does}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="sim-panel sim-wide">
          <h2>What it knows</h2>
          <dl className="sim-known">
            <dt>Shops</dt>
            <dd>{shops.map((s) => s.name).join(", ")}</dd>
            <dt>Family words</dt>
            <dd>{synonymPairs.map((p) => `${p.word_a} = ${p.word_b}`).join(", ") || "none yet"}</dd>
            <dt>Learned</dt>
            <dd>{d.rules.length ? d.rules.map((r) => `${r.item_name} → ${shopName(r.shop_id)}`).join(", ") : "nothing yet; answer a question or confirm a suggestion"}</dd>
          </dl>
        </div>
      </section>
    </div>
  );
}
