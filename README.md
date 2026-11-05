# ShoppingSync

The family shopping list, fed by the family WhatsApp group and sorted by shop.
Spec and decisions: see the "Agent Builder — Product Brief & MVP Spec" doc.

## What's here (phase 1)

| Path | What it is |
| --- | --- |
| `app/login` | Family sign-in, and first-time family setup |
| `app/page.tsx` | The list, grouped by shop: add, tick as bought, move, remove; live updates |
| `app/profile` | Family profile: name, WhatsApp group name, members, shops |
| `supabase/migrations/0001_init.sql` | Database tables and access rules |
| `scripts/whatsapp-test.ts` | Connection test: link the bot, find the group, read and react |
| `scripts/whatsapp-listen.ts` | Listener: turns group messages into list items (`npm run wa:listen`) |
| `lib/parse.ts`, `lib/matching.ts` | Message rules (add, got, cancel) and shop matching, shared by page and listener |
| `.env.example` | Settings template; copy it to `.env.local` for your secrets (never committed) |

## First-time setup (on your Mac, in Terminal)

1. **Check Node.js** — `node -v` should print v20.6 or later (v22 recommended).
   If not, install the LTS version from https://nodejs.org.
2. **Install packages**
   ```sh
   cd ~/Projects/ShoppingSync
   npm install
   ```
3. **Create the database** — in Supabase, open *SQL Editor → New query*, paste the whole of
   `supabase/migrations/0001_init.sql`, and click *Run*.
4. **Switch off email confirmation** — *Authentication → Sign In / Providers → Email* → turn off
   *Confirm email*. (The family signs in with a username, so there is no real inbox.)
5. **Create and fill in `.env.local`**
   ```sh
   cp .env.example .env.local
   open -e .env.local
   ```
   Paste in:
   - project URL and publishable key from *Project Settings → API keys / Data API*
   - the secret (service role) key from the same page
   - the exact WhatsApp group name
6. **Run the web page**
   ```sh
   npm run dev
   ```
   Open http://localhost:3000, choose *Set up your family*, then add members and shops on the
   family profile page.
7. **Run the WhatsApp test** (bot phone in hand)
   ```sh
   npm run wa:test
   ```
   Scan the QR code with the bot phone (*WhatsApp → Settings → Linked devices → Link a device*),
   then post `#test milk` in the family group. The bot should react ✅ within a few seconds.

## Run the WhatsApp listener

```sh
npm run wa:listen
```
Leave the window open. Short lists ("milk, eggs and bread") are read by simple rules; ordinary
sentences ("can you pick up milk on the way home, we're out of eggs") are read by the local AI.
If the AI is off, those messages are queued and read as soon as it's back.
Anything the AI read is **confirmed first**: the bot asks, e.g. "I'll add *milk* and *eggs* to the list.
Reply *yes* to confirm, or *no* to skip." Preferences such as "eggs are better in Waitrose" become a
question to save a rule (and add the shop if it's new). Reply *yes*/*no* to the question; a plain "yes"
also works within 30 minutes when only one question is open. Questions expire after 24 hours.
"extra milk" / "2 more eggs" add to the existing milk or eggs instead of creating a new item.
The bot replies to each message with a short note of what it did, e.g. "✅ Added milk (Tesco) and
turmeric (needs review)." or "✅ Ticked off 4 items at Costco."
Messages in other languages are translated to English by the local AI first, then handled the same way
(commands like "list" and "done" are recognised without the AI).
If the local AI (Ollama) is off, messages are parked rather than guessed: the bot says "😴 The LLM is taking a
nap, so this message is parked and will be processed later." (later ones just get 💤), and processes them
in order as soon as Ollama is back, replying with what it did. Commands still work while it naps.
**Synonyms** (family profile page, or "paal means milk" in the group): pairs of words used for the same
thing. The list keeps the word typed; synonyms are used to find the shop (an item's own rule wins), merge
duplicates, and tick items off. Pairs join into groups (thayir = curd = yoghurt). Messages made only of
family words skip translation. Setup, once: run `supabase/migrations/0003_synonyms.sql` in the SQL Editor.
**Tanglish and Hinglish.** Family words are matched despite spelling ("pal" = "paal", "tayir" = "thair" =
"thayir"; one-letter slips only for words of 5+ letters, so "card" never becomes "curd"). "venum", "vendum"
and "chahiye" work like "needed", so "paal venum" is instant. The translator knows common Tanglish/Hinglish
shopping words and reads "X na Y" as "X means Y". When it isn't sure (below 70%), the bot shows its reading
and asks: 'I read that as "pal means milk". Shall I save *pal* = *milk*? Reply yes to confirm, or no to skip.'
Tanglish **"riz na rice"** (also "X-nu Y", "X endral Y") is recognised without the AI and always confirmed:
"Shall I save *riz* = *rice*?" (Hindi "doodh na lao" = "don't bring milk" is never read this way.)
**Lists typed with spaces** ("pal coffee", "milk eggs bread") become separate items only when every piece is
something the list already knows (a rule, a shop's example item or a synonym). Known multi-word items stay whole
("kallu uppu", "rock salt"), and anything with an unknown word stays as typed ("paneer tikka", "kitchen roll").
Lists with commas, "and" or one item per line always keep their items; only unknown items are translated.
**Replace Riz with Rice** (also "rename/change riz to rice") renames items still on the list (case and plurals
ignored), then merges items with the new name under the same shop into one, keeping all requesters and
combining quantities. Items under different shops are never merged.
**help** (or "what are your features?", "what can you do?") lists what the bot can do; **summary** (or "give me a
summary of this chat", "what happened today?") shows today's list activity: added, ticked off, needs review.
Both are written by the app, not the AI, so they're always accurate and work while the AI naps. The chat itself
is never stored, so the summary covers the list only.
**Everything else.** A message that isn't a shopping action is passed to the local AI, which replies briefly
(two short sentences at most) only if it's a question or said to the bot, e.g. "I wonder what time it is
now in Chennai?" -> "It's 3:54 pm on Thursday in Chennai." Family chat and "ok"/"thanks" get no reply.
It never answers for someone else: replies to another person's message, @mentions of someone else, and
messages starting with a family member's name or role (Amma, Appa, Mum, Dad, Akka…) are left alone. The AI
also checks it is the right source; questions only the family can answer ("where are the keys?") get no reply.
The AI is given the current time in common places (UK, India, Sri Lanka, UAE, Singapore, US, Canada, Sydney).
Outings live on the same list: "The new Ramayana movie should be seen at iMax" asks to add *Ramayana movie*
under *iMax* (created as a new place if needed). Afterwards "done iMax" ticks it off like any shop.
Every item posted in the family group is added to the list: matched to a
shop where a rule fits, otherwise under **Unassigned** for you to review. "got bread" ticks bread
off; "cancel eggs" removes eggs. The bot reacts ✅ to each message it handled.
Send `list` (or "shopping list", "list?") and the bot replies with the whole list, shop by shop,
with Needs review items last. Reply **Done** to that list message when the shopping is finished:
every item on it is ticked off as bought (items added after the list was sent stay on).
Send **done costco** (any shop name, or the start of one) to tick off just that shop's items.
Send **add shop Lidl** to create a shop (or **add shop Lidl: fruit, veg** to give it example items too).
Stop it with Ctrl+C; messages sent while it was off are picked up when it starts again.

## Many WhatsApp groups, a super user and group logins

Every WhatsApp group the bot is in is its own shopping group, with its own list, shops, rules, synonyms
and console login. Nothing is shared between groups.

**Two kinds of login** (one sign-in page, `/login`):
- **Super user**: one fixed username and password, created with `npm run superuser:create` (the password
  is typed in Terminal and never shown). Lands on **All groups**, automatically controls every group,
  creates magic words, opens any group's console (with a group switcher), makes setup links, resets group
  passwords and changes its own password. Only the super user sees these.
- **Group login**: one per WhatsApp group; sees and manages that group only.

**Inviting someone (easiest)**
1. On **All groups → Invites**, enter their name and WhatsApp number and click **Create invite**.
2. Click **Send to … on WhatsApp**: their personal link (`/use-me?invite=…`, 7 days, once) opens the
   **Use me** page with their name, the bot's number and a *Save contact* button. Without an invite, the
   page explains ShoppingSync but doesn't show the bot's number.
3. When the invited number adds the bot to a group (or created the group), the bot switches the group on
   straight away, with no magic word, and privately sends them the setup link.
4. Each invite shows its progress: Sent → Opened → Group on → Login set up. Cancel any unused invite.
   The bot shares its own number with the website (stored server-side only) each time it connects.

**Adding a group with a magic word**
1. Add the bot (the bot phone's number) to the WhatsApp group. It posts:
   "👋 Hi, I'm ShoppingSync. Reply to this group with your magic word." Until then it ignores the group.
2. The group appears in **All groups** as *Waiting for magic word*, with **Added by** (the WhatsApp name and
   number of whoever added the bot) so you know who is asking. Click **Create magic word** on its row, then
   **Send privately** to open a WhatsApp chat with that person with the word already typed in.
   The word works only in that group, once, within the group's 24 hours. Only its hash is stored.
3. Someone in the group replies with it. Correct: the group is switched on, and the bot privately messages
   that person a one-time link (48 hours) to create the group's console login. Wrong (including a word made
   for another group): the bot leaves. No correct word within 24 hours: it leaves too.
4. If the private message doesn't arrive, use **New setup link** on the group's row.
5. Removing the bot marks the group inactive (data kept). Adding it back asks for a new magic word.

**Setup, once**
1. Run `supabase/migrations/0004_groups.sql`, then `supabase/migrations/0005_super_user.sql`, in the SQL Editor.
2. `npm run superuser:create` and choose the super user's username (default `admin`) and password.
3. Run `supabase/migrations/0006_added_by.sql` (who added the bot).
4. Run `supabase/migrations/0007_invites.sql` (personal invites).
5. Set `PUBLIC_BASE_URL` in `.env.local` to an address family phones can open: your Mac's Wi-Fi address
   while testing (`http://192.168.x.x:3000`, shown as "Network" when `npm run dev` starts), or the Vercel URL.

## Needs review and the local AI

Items no rule matches appear under **Needs review** at the top of the list. While the listener runs,
the local AI (Qwen in Ollama on this Mac) suggests a shop for each one, with a short reason.
Tap **Confirm**, or pick another shop from the dropdown: either way a rule is saved, so the item
goes straight to that shop next time, and the AI sees the decision as an example for similar items.

Setup, once: run `supabase/migrations/0002_ai_proposals.sql` in the Supabase SQL Editor, and add
`OLLAMA_MODEL=<name from "ollama list">` to `.env.local` (default `qwen2.5:14b`). Keep the Ollama app running.

## Save to GitHub

```sh
git init
git add .
git commit -m "Phase 1: web page, schema, WhatsApp test"
git branch -M main
git remote add origin https://github.com/<your-github-username>/ShoppingSync.git
git push -u origin main
```
`.env.local` and `.wa-session/` are in `.gitignore`, so secrets stay on your Mac.

## Next

- Store the WhatsApp session (encrypted) in Supabase and run the same test inside a Vercel function.
- Phase 2: message pipeline (split, rules, local Qwen worker) and tests T1–T10.
