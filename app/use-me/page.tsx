import type { Metadata } from "next";
import Link from "next/link";
import { lookupInvite, type InviteView } from "@/lib/invites.server";
import { prettyPhone, waLink } from "@/lib/phone";

export const dynamic = "force-dynamic";   // every visit checks the invite afresh

export const metadata: Metadata = {
  title: "Use me · ShoppingSync",
  description: "What ShoppingSync is, and how to set it up for your own WhatsApp group.",
  referrer: "no-referrer",                // never pass the invite link on to other sites
};

const SAY: [string, string][] = [
  ["milk", "Adds milk to the list, under the right shop."],
  ["eggs, bread and butter", "Adds several things at once."],
  ["paal venum · doodh chahiye", "Tanglish, Hinglish and other languages work too."],
  ["we're out of rice", "Running out counts as “add it”."],
  ["extra milk · 2 more eggs", "Adds to what's already on the list."],
  ["list", "The bot replies with the whole list, grouped by shop."],
  ["got milk", "Ticks one thing off."],
  ["done Tesco", "Ticks off everything for that shop."],
  ["Done (as a reply to the list)", "Ticks off everything on that list."],
  ["cancel eggs", "Takes something off without buying it."],
  ["add shop Lidl", "Adds a new shop."],
  ["eggs are better in Waitrose", "Remembers where you like to buy things."],
  ["paal means milk", "Teaches it your family's words."],
  ["replace riz with rice", "Fixes a misspelt item."],
  ["help · summary", "What the bot can do · what happened on the list today."],
];

const until = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

export default async function UseMePage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const { invite } = await searchParams;
  const view = await lookupInvite(invite, { markOpened: true });
  const ok = view.state === "ok" ? view : null;

  return (
    <main className="guide">
      <header className="guide-hero">
        <p className="guide-kicker">ShoppingSync{ok ? " · Your invite" : ""}</p>
        <h1>{ok ? `Hi ${ok.name}, your family's shopping list is a few minutes away.` : "Your family's shopping list, kept in your WhatsApp group."}</h1>
        <p className="guide-lede">
          Anyone in the group types what&apos;s needed, in their own words. ShoppingSync sorts it by shop,
          keeps one tidy list, and ticks things off as you buy them. No new app to install.
        </p>
        <div className="guide-chat" aria-label="Example WhatsApp conversation">
          <div className="bubble them"><span>Amma</span>paal venum, and we&apos;re out of rice</div>
          <div className="bubble bot"><span>ShoppingSync</span>✅ Added milk (Tesco) and rice (Indian grocer).</div>
          <div className="bubble them"><span>Ravi</span>list</div>
          <div className="bubble bot"><span>ShoppingSync</span><b>Tesco</b>: milk, bread<br /><b>Indian grocer</b>: rice, curry leaves</div>
        </div>
      </header>

      <InviteCard view={view} invite={invite} />

      <section className="guide-section">
        <h2>What it does</h2>
        <ul className="guide-points">
          <li><strong>Reads the group.</strong> Every message is checked; shopping is added, everything else is left alone.</li>
          <li><strong>Sorts by shop.</strong> It learns which shop sells what. If it isn&apos;t sure, it asks, and remembers your answer.</li>
          <li><strong>One list, two places.</strong> Ask for it in WhatsApp, or open your group&apos;s private web page to add, tick and tidy.</li>
          <li><strong>Speaks family.</strong> Typos, plurals, Tanglish and Hinglish are understood. Teach it your own words.</li>
          <li><strong>Stays out of the way.</strong> It never replies to messages meant for someone else in the group.</li>
        </ul>
      </section>

      {ok && (
        <section className="guide-section">
          <h2>Set up your group</h2>
          <ol className="guide-steps">
            <li>
              <h3>Save the bot&apos;s number</h3>
              {ok.botNumber ? (
                <>
                  <p>The bot is <strong>{prettyPhone(ok.botNumber)}</strong>. Save it as a contact called <em>ShoppingSync</em>.</p>
                  <div className="guide-actions">
                    <a className="button-link" href={`/use-me/contact?invite=${invite}`}>Save contact</a>
                    <a className="button-ghost" href={waLink(ok.botNumber)} target="_blank" rel="noreferrer">Open in WhatsApp</a>
                  </div>
                </>
              ) : (
                <p>The bot&apos;s number isn&apos;t available right now. Ask the person who invited you for it.</p>
              )}
            </li>
            <li>
              <h3>Add it to your family group, from your own phone</h3>
              <p>
                Open the group, tap its name, then <em>Add members</em> and choose <em>ShoppingSync</em>.
                Add it from <strong>{prettyPhone(ok.number)}</strong>: that&apos;s the number you were invited on, and how the bot knows it&apos;s you.
              </p>
            </li>
            <li>
              <h3>It switches itself on</h3>
              <p>Because you were invited, there&apos;s <strong>no magic word</strong>. The bot says hello in the group and privately sends <em>you</em> a one-time setup link.</p>
            </li>
            <li>
              <h3>Choose your login</h3>
              <p>Open the link and choose a <strong>username and password</strong> for your group&apos;s web page. The link works once and expires after 48 hours.</p>
            </li>
            <li>
              <h3>Add your shops and family</h3>
              <p>
                On the web page, open <em>Group settings</em>. Add the shops you use, each with a few example items
                (Tesco: milk, bread, eggs), and each person&apos;s name as WhatsApp shows it.
              </p>
            </li>
            <li>
              <h3>Try it</h3>
              <p>Send <code>milk</code> in the group, then <code>list</code>. The bot replies, and milk appears on your web page.</p>
            </li>
          </ol>
        </section>
      )}

      <section className="guide-section">
        <h2>Things you can say</h2>
        <p className="guide-note">Type these in the group. Capitals don&apos;t matter, and full sentences work too.</p>
        <div className="guide-table">
          {SAY.map(([say, does]) => (
            <div className="guide-row" key={say}>
              <code>{say}</code>
              <span>{does}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="guide-section">
        <h2>Sharing the web page</h2>
        <ul className="guide-points">
          <li>Everyone in your family uses the same username and password. Send them privately, not in the group.</li>
          <li>On a phone, open the page and choose <em>Share → Add to Home Screen</em>. It then opens like an app.</li>
          <li>To lock someone out, ask for a new password and share it only with the people who should keep it.</li>
        </ul>
      </section>

      <section className="guide-section">
        <h2>Your privacy</h2>
        <ul className="guide-points">
          <li><strong>We keep your shopping list, not your chat.</strong> Ordinary chat is ignored and never saved. Shopping messages the bot needs to check with you, or park for later, are kept with your list so it can finish the job.</li>
          <li><strong>Your list is private.</strong> Only your group&apos;s login sees it. Other groups can&apos;t.</li>
          <li><strong>The AI runs on a private computer,</strong> not a public AI service. If you see 😴 it&apos;s offline; your message is parked and handled when it&apos;s back.</li>
          <li><strong>You&apos;re in control.</strong> Remove the bot from the group at any time and it stops reading straight away.</li>
        </ul>
      </section>

      {ok && (
        <section className="guide-section">
          <h2>If something goes wrong</h2>
          <dl className="guide-faq">
            <dt>The bot asked for a magic word</dt>
            <dd>
              It was added from a different number than {prettyPhone(ok.number)}. Don&apos;t guess a word. Ask the person who
              invited you to invite the number that added it; the bot switches on by itself within a couple of minutes.
            </dd>
            <dt>I didn&apos;t get the setup link</dt>
            <dd>Check your WhatsApp chats for a message from ShoppingSync. If it isn&apos;t there, ask for a new setup link.</dd>
            <dt>The bot doesn&apos;t reply</dt>
            <dd>It may be offline for a while. Messages are picked up when it&apos;s back, so there&apos;s no need to send them again.</dd>
            <dt>Something went to the wrong shop</dt>
            <dd>Change the shop on the web page. The bot remembers and gets it right next time.</dd>
          </dl>
        </section>
      )}

      <footer className="guide-foot">
        <Link href="/login">Already set up? Sign in</Link>
      </footer>
    </main>
  );
}

/** The personal part of the page: what to do next depends on the invite. */
function InviteCard({ view, invite }: { view: InviteView; invite?: string }) {
  if (view.state === "ok") {
    return (
      <section className="guide-invite ok">
        <h2>You&apos;re invited</h2>
        <p>
          This invite is for <strong>{view.name}</strong> on <strong>{prettyPhone(view.number)}</strong> and works until{" "}
          <strong>{until(view.expiresAt)}</strong>. Keep this link to yourself: it&apos;s how the bot recognises you.
        </p>
        <p className="guide-note" style={{ margin: 0 }}>Six steps below. It takes about 10 minutes.</p>
      </section>
    );
  }
  if (view.state === "used") {
    return (
      <section className="guide-invite">
        <h2>You&apos;re all set up</h2>
        <p>
          This invite has already switched on {view.groupName ? <strong>{view.groupName}</strong> : "your group"}.{" "}
          <Link href="/login">Sign in</Link> to see your list, or keep reading for everything you can say to the bot.
        </p>
      </section>
    );
  }
  return (
    <section className="guide-invite">
      <h2>{view.state === "invalid" ? "This invite link has expired" : "ShoppingSync is invite-only"}</h2>
      <p>
        {view.state === "invalid"
          ? "Invite links work for 7 days and only once. Ask the person who invited you for a new one."
          : "To set it up for your family, ask the person who shared this page for your personal invite link. It shows you the bot's number and switches your group on without any codes."}
      </p>
    </section>
  );
}
