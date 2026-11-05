import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Use me · ShoppingSync",
  description: "What ShoppingSync is, and how to set it up for your own WhatsApp group.",
};

/** The bot's WhatsApp number, digits with country code (set NEXT_PUBLIC_BOT_NUMBER in Vercel). */
const BOT = (process.env.NEXT_PUBLIC_BOT_NUMBER ?? "").replace(/\D/g, "");
const botPretty = BOT && (/^44\d{10}$/.test(BOT) ? `+44 ${BOT.slice(2, 6)} ${BOT.slice(6)}` : `+${BOT}`);

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

export default function UseMePage() {
  return (
    <main className="guide">
      <header className="guide-hero">
        <p className="guide-kicker">ShoppingSync</p>
        <h1>Your family&apos;s shopping list, kept in your WhatsApp group.</h1>
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

      <section className="guide-section">
        <h2>Before you start</h2>
        <ul className="guide-need">
          <li>
            <strong>The bot&apos;s number</strong>
            {BOT
              ? <> <a href={`https://wa.me/${BOT}`} target="_blank" rel="noreferrer">{botPretty}</a>. Save it as a contact called <em>ShoppingSync</em>.</>
              : <> Ask the person who sent you this page, and save it as a contact called <em>ShoppingSync</em>.</>}
          </li>
          <li><strong>A WhatsApp group</strong> for your family. A new one, or one you already have.</li>
          <li><strong>A magic word</strong> from the person who sent you this page. You&apos;ll ask for it in step 3.</li>
          <li><strong>About 10 minutes.</strong></li>
        </ul>
      </section>

      <section className="guide-section">
        <h2>Set up your group</h2>
        <ol className="guide-steps">
          <li>
            <h3>Add the bot to your group</h3>
            <p>Open the group, tap its name, then <em>Add members</em> and choose <em>ShoppingSync</em>. You need to be a group admin to add people.</p>
          </li>
          <li>
            <h3>Wait for its hello</h3>
            <p>The bot posts: <q>Hi, I&apos;m ShoppingSync. Reply to this group with your magic word.</q> <strong>Don&apos;t guess.</strong> A wrong word makes the bot leave straight away.</p>
          </li>
          <li>
            <h3>Ask for your magic word</h3>
            <p>Message the person who sent you this page and tell them your group&apos;s name. They can see that you added the bot, and will send you a word like <code>MANGO-4821</code> privately.</p>
          </li>
          <li>
            <h3>Reply in the group with the word</h3>
            <p>Reply to the bot&apos;s hello with the magic word, within 24 hours. It works once, and only in your group. The bot says ✅ when it&apos;s accepted.</p>
          </li>
          <li>
            <h3>Open your private setup link</h3>
            <p>The bot sends <em>you</em> a private message with a one-time link. Open it and choose a <strong>username and password</strong> for your group&apos;s web page. The link works once and expires after 48 hours.</p>
          </li>
          <li>
            <h3>Add your shops</h3>
            <p>On the web page, open <em>Group settings</em>. Add the shops you use, each with a few example items (Tesco: milk, bread, eggs). Example items let the bot sort things instantly from day one.</p>
          </li>
          <li>
            <h3>Add your family</h3>
            <p>Still in <em>Group settings</em>, add each person&apos;s name as WhatsApp shows it. Add any family words too, like <em>paal = milk</em>.</p>
          </li>
          <li>
            <h3>Try it</h3>
            <p>Send <code>milk</code> in the group, then <code>list</code>. The bot replies, and milk appears on your web page.</p>
          </li>
        </ol>
      </section>

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
        <h2>Good to know</h2>
        <ul className="guide-points">
          <li><strong>Your list is private.</strong> Only your group&apos;s login sees your list. Other groups can&apos;t see it.</li>
          <li><strong>The chat isn&apos;t kept.</strong> Only the shopping list is saved, never your messages.</li>
          <li><strong>Sometimes it naps.</strong> If you see 😴, the bot&apos;s brain is offline. Your message is parked and handled when it&apos;s back.</li>
          <li><strong>It asks when unsure.</strong> Answer yes or no, or pick the shop on the web page under <em>Needs review</em>. It learns from every answer.</li>
          <li><strong>To stop</strong>, remove the bot from the group. Add it back any time and ask for a new magic word.</li>
        </ul>
      </section>

      <section className="guide-section">
        <h2>If something goes wrong</h2>
        <dl className="guide-faq">
          <dt>The bot left the group</dt>
          <dd>The magic word was wrong, or none arrived within 24 hours. Ask for a new word, add the bot again, and reply with it.</dd>
          <dt>I didn&apos;t get the setup link</dt>
          <dd>Check your WhatsApp chats for a message from the bot&apos;s number. If it isn&apos;t there, ask for a new setup link.</dd>
          <dt>The bot doesn&apos;t reply</dt>
          <dd>It may be offline for a while. Messages are picked up when it&apos;s back, so there&apos;s no need to send them again.</dd>
          <dt>Something went to the wrong shop</dt>
          <dd>Change the shop on the web page. The bot remembers and gets it right next time.</dd>
        </dl>
      </section>

      <footer className="guide-foot">
        <Link href="/login">Already set up? Sign in</Link>
      </footer>
    </main>
  );
}
