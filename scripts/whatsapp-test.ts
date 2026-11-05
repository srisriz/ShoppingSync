/**
 * WhatsApp connection test (phase 1).
 *
 * Proves the bot can (1) link to WhatsApp, (2) find the family group,
 * (3) read new messages and (4) react to one. Nothing is stored except the
 * login session in .wa-session/ (git-ignored) so you only scan the QR once.
 *
 * Run:  npm run wa:test
 * Then: scan the QR with the BOT phone, and post "#test milk" in the family group.
 * Stop: press Ctrl+C.
 */
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

const GROUP_NAME = (process.env.WHATSAPP_GROUP_NAME ?? "").trim();
// 0 = keep listening until you press Ctrl+C
const TEST_SECONDS = Number(process.env.TEST_SECONDS ?? 0);

let groupJid: string | undefined;
let timerStarted = false;

if (!GROUP_NAME) {
  console.error("Set WHATSAPP_GROUP_NAME in .env.local first.");
  process.exit(1);
}

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(".wa-session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["ShoppingSync", "Chrome", "1.0"],
    markOnlineOnConnect: false, // don't show the bot as "online" to the family
    syncFullHistory: false,     // we never need old chat history
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nOn the BOT phone: WhatsApp > Settings > Linked devices > Link a device, then scan:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log(`\n✓ Connected as ${sock.user?.name ?? sock.user?.id}`);
      const groups = Object.values(await sock.groupFetchAllParticipating());
      console.log(`  The bot is in ${groups.length} group(s): ${groups.map((g) => `"${g.subject}"`).join(", ") || "none"}`);

      const match = groups.find((g) => g.subject.trim().toLowerCase() === GROUP_NAME.toLowerCase());
      if (!match) {
        console.log(`\n✗ Group "${GROUP_NAME}" not found. Check the bot was added and the name in .env.local matches exactly.`);
      } else {
        groupJid = match.id;
        console.log(`✓ Found "${match.subject}" (${match.participants.length} members)`);
        const howLong = TEST_SECONDS > 0 ? `for ${TEST_SECONDS}s` : "until you press Ctrl+C";
        console.log(`\nListening ${howLong}. Post a message containing #test in the group; the bot will react ✅.\n`);
      }

      if (!timerStarted && TEST_SECONDS > 0) {
        timerStarted = true;
        setTimeout(() => {
          console.log("\nTest window over. Session saved in .wa-session/. Goodbye.");
          sock.end(undefined);
          process.exit(0);
        }, TEST_SECONDS * 1000);
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("\n✗ WhatsApp logged this device out. Delete the .wa-session folder and run the test again.");
        process.exit(1);
      }
      // After the first QR scan WhatsApp asks for a restart; other drops are retried too.
      console.log(code === DisconnectReason.restartRequired ? "Linked. Reconnecting…" : `Connection dropped (${code ?? "unknown"}). Reconnecting…`);
      void connect();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" || !groupJid) return;
    for (const m of messages) {
      if (m.key.remoteJid !== groupJid || m.key.fromMe) continue;
      // Unwrap disappearing-message and view-once wrappers before reading the text.
      const msg = m.message?.ephemeralMessage?.message ?? m.message?.viewOnceMessage?.message ?? m.message;
      const text = msg?.conversation ?? msg?.extendedTextMessage?.text ?? "";
      if (!text) continue;
      console.log(`  [${m.pushName ?? "someone"}] ${text}`);
      if (text.toLowerCase().includes("#test")) {
        await sock.sendMessage(groupJid, { react: { text: "✅", key: m.key } });
        console.log("  → reacted ✅  (read + react both work)");
      }
    }
  });
}

void connect();
