import type { Metadata } from "next";
import Link from "next/link";
import { Atkinson_Hyperlegible, Bricolage_Grotesque, Caveat } from "next/font/google";
import { lookupInvite, type InviteView } from "@/lib/invites.server";
import { prettyPhone, waLink } from "@/lib/phone";
import Simulator from "../demo/Simulator";
import "../demo/demo.css";
import "./use-me.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "700", "800"], variable: "--um-display" });
const body = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--um-body" });
const hand = Caveat({ subsets: ["latin"], weight: ["500", "700"], variable: "--um-hand" });

export const dynamic = "force-dynamic";   // every visit checks the invite afresh

export const metadata: Metadata = {
  title: "ShoppingSync: your family's shopping list in WhatsApp",
  description: "Try ShoppingSync in a pretend family WhatsApp group, and set it up for your own.",
  referrer: "no-referrer",                // never pass the invite link on to other sites
};

const until = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

export default async function UseMePage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const { invite } = await searchParams;
  const view = await lookupInvite(invite, { markOpened: true });
  const ok = view.state === "ok" ? view : null;

  return (
    <div className={`um ${display.variable} ${body.variable} ${hand.variable}`}>
      <header className="um-hero">
        <div className="um-wrap">
          <nav className="um-nav">
            <span className="um-mark">ShoppingSync</span>
            <span className="um-nav-links"><a href="#try">Try it</a><Link href="/login">Sign in</Link></span>
          </nav>

          <div className="um-hero-grid">
            <div className="um-hero-copy">
              <h1>Your family&apos;s shopping list, sorted by shop, right in WhatsApp.</h1>
              <p className="um-lede">
                Anyone in the group types what&apos;s needed, in their own words. ShoppingSync puts each thing
                under the right shop and ticks it off when it&apos;s bought. Nothing new to install.
              </p>
              <InviteCard view={view} invite={invite} />
              <a className="um-try-cta" href="#try">
                <span>Try it now</span>
                <small>A pretend family group, right on this page</small>
              </a>
            </div>

            <Demo />
          </div>
        </div>
      </header>

      <main>
        <section className="um-section um-wrap">
          <h2>What it does</h2>
          <div className="um-points">
            <div><h3>Reads the group</h3><p>Every message is checked. Shopping goes on the list; everything else is left alone.</p></div>
            <div><h3>Sorts by shop</h3><p>It learns which shop sells what. When it isn&apos;t sure, it asks, and remembers the answer.</p></div>
            <div><h3>One list, two places</h3><p>Ask for it in WhatsApp, or open your group&apos;s private web page to add, tick and tidy.</p></div>
            <div><h3>Speaks family</h3><p>Typos, plurals, Tanglish and Hinglish are understood. Teach it your own words.</p></div>
            <div><h3>Stays out of the way</h3><p>It never answers messages meant for someone else in the group.</p></div>
          </div>
        </section>

        {ok && (
          <section className="um-band" id="setup-steps">
            <div className="um-wrap um-steps-grid">
              <div className="um-steps-intro">
                <h2>Set up your group</h2>
                <p>Six steps, about ten minutes. No codes to type: your invite does that part.</p>
              </div>
              <ol className="um-steps">
                <li>
                  <h3>Save the bot&apos;s number</h3>
                  {ok.botNumber ? (
                    <>
                      <p>The bot is <strong>{prettyPhone(ok.botNumber)}</strong>. Save it as a contact called ShoppingSync.</p>
                      <div className="um-actions">
                        <a className="um-btn" href={`/use-me/contact?invite=${invite}`}>Save contact</a>
                        <a className="um-btn um-btn-quiet" href={waLink(ok.botNumber)} target="_blank" rel="noreferrer">Open in WhatsApp</a>
                      </div>
                    </>
                  ) : (
                    <p>The bot&apos;s number isn&apos;t available right now. Ask the person who invited you for it.</p>
                  )}
                </li>
                <li>
                  <h3>Add it to your family group, from your phone</h3>
                  <p>
                    Open the group, tap its name, choose <em>Add members</em>, then ShoppingSync. Add it from{" "}
                    <strong>{prettyPhone(ok.number)}</strong>: that&apos;s the number you were invited on, and how the bot knows it&apos;s you.
                  </p>
                </li>
                <li>
                  <h3>It switches itself on</h3>
                  <p>The bot says hello in the group and privately sends <em>you</em> a one-time link for your group&apos;s web page.</p>
                </li>
                <li>
                  <h3>Answer a few questions</h3>
                  <p>Right there in the chat it asks which shops you use, and what you buy at each. Reply <em>yes</em> to its guesses, or say your own. <a href="#try">Try it below</a> first if you like.</p>
                </li>
                <li>
                  <h3>Choose your login</h3>
                  <p>Open the private link and choose a username and password for your group&apos;s web page. It works once, for 48 hours.</p>
                </li>
                <li>
                  <h3>Try it</h3>
                  <p>Send <q>milk</q> in the group, then <q>list</q>. The bot replies, and milk appears on your web page.</p>
                </li>
              </ol>
            </div>
          </section>
        )}

        <section className="um-section um-try" id="try-it">
          <div className="um-wrap">
            <div className="sim">
              <Simulator intro={<>
                <h2>Try it in a pretend family group</h2>
                <p className="um-sub">
                  Type as anyone in the family and watch the bot reply, sort the list by shop and learn your family&apos;s words.
                  It&apos;s the bot&apos;s real message handling, running right here. Nothing is saved.
                </p>
              </>} />
            </div>
          </div>
        </section>

        <section className="um-section um-wrap um-two">
          <div>
            <h2>Sharing the web page</h2>
            <ul className="um-list">
              <li>Your family shares one username and password. Send them privately, not in the group.</li>
              <li>On a phone, open the page and choose <em>Share</em>, then <em>Add to Home Screen</em>. It opens like an app.</li>
              <li>To lock someone out, ask for a new password and share it only with the people who should keep it.</li>
            </ul>
          </div>
          <div className="um-privacy">
            <h2>Your privacy</h2>
            <ul className="um-list">
              <li><strong>Your shopping list is kept, your chat isn&apos;t.</strong> Ordinary chat is ignored and never saved. Shopping messages the bot needs to check with you, or park for later, are kept with your list so it can finish the job.</li>
              <li><strong>Your list is private.</strong> Only your group&apos;s login can see it.</li>
              <li><strong>The AI runs on a private computer,</strong> not a public AI service. If you see 😴 it&apos;s offline; your message waits and is handled when it&apos;s back.</li>
              <li><strong>You&apos;re in control.</strong> Remove the bot from the group and it stops reading straight away.</li>
            </ul>
          </div>
        </section>

        {ok && (
          <section className="um-section um-wrap">
            <h2>If something goes wrong</h2>
            <div className="um-faq">
              <details>
                <summary>The bot asked for a magic word</summary>
                <p>
                  It was added from a different number than {prettyPhone(ok.number)}. Don&apos;t guess a word: a wrong one
                  makes the bot leave. Ask the person who invited you to invite the number that added it, and the bot
                  switches on by itself within a couple of minutes.
                </p>
              </details>
              <details>
                <summary>I didn&apos;t get the setup link</summary>
                <p>Look in your WhatsApp chats for a message from ShoppingSync. If it isn&apos;t there, ask for a new setup link.</p>
              </details>
              <details>
                <summary>The bot doesn&apos;t reply</summary>
                <p>It may be offline for a while. Messages are picked up when it&apos;s back, so there&apos;s no need to send them again.</p>
              </details>
              <details>
                <summary>Something went to the wrong shop</summary>
                <p>Change the shop on the web page. The bot remembers, and gets it right next time.</p>
              </details>
            </div>
          </section>
        )}
      </main>

      <footer className="um-foot">
        <div className="um-wrap">
          <span className="um-mark">ShoppingSync</span>
          <Link href="/login">Already set up? Sign in</Link>
        </div>
      </footer>
    </div>
  );
}

/** The hero's one moment: messages arrive in the chat and get written onto the fridge list. */
function Demo() {
  return (
    <div className="um-demo" aria-label="Example: three WhatsApp messages become a shopping list sorted by shop">
      <div className="um-chat">
        <div className="um-msg d1"><b>Mom</b>paal venum, and we&apos;re out of rice</div>
        <div className="um-msg d2"><b>Bob</b>eggs and bread pls</div>
        <div className="um-msg d3"><b>Betty</b>got the bread 👍</div>
      </div>
      <div className="um-note" aria-hidden="true">
        <div className="um-shop d1">Tesco</div>
        <div className="um-item d1">milk</div>
        <div className="um-item d2">eggs</div>
        <div className="um-item um-done d3">bread</div>
        <div className="um-shop d1">Indian grocer</div>
        <div className="um-item d1">rice</div>
      </div>
    </div>
  );
}

/** The personal part of the hero: what to do next depends on the invite. */
function InviteCard({ view, invite }: { view: InviteView; invite?: string }) {
  if (view.state === "ok") {
    return (
      <div className="um-ticket">
        <p className="um-ticket-title">{view.name}, you&apos;re invited</p>
        <p>
          This invite is for <strong>{prettyPhone(view.number)}</strong> and works until {until(view.expiresAt)}.
          Keep this link to yourself: it&apos;s how the bot recognises you.
        </p>
        {view.botNumber && (
          <div className="um-actions">
            <a className="um-btn" href={`/use-me/contact?invite=${invite}`}>Save the bot&apos;s number</a>
            <a className="um-btn um-btn-quiet" href="#setup-steps">See the steps</a>
          </div>
        )}
      </div>
    );
  }
  if (view.state === "used") {
    return (
      <div className="um-ticket">
        <p className="um-ticket-title">You&apos;re all set up</p>
        <p>
          This invite has already switched on {view.groupName ? <strong>{view.groupName}</strong> : "your group"}.
        </p>
        <div className="um-actions"><Link className="um-btn" href="/login">Sign in to your list</Link></div>
      </div>
    );
  }
  return (
    <div className="um-ticket um-ticket-plain">
      <p className="um-ticket-title">{view.state === "invalid" ? "This invite link has expired" : "ShoppingSync is invite-only"}</p>
      <p>
        {view.state === "invalid"
          ? "Invite links work for 7 days, and only once. Ask the person who invited you for a new one."
          : "To set it up for your family, ask the person who shared this page for your personal invite link."}
      </p>
    </div>
  );
}
