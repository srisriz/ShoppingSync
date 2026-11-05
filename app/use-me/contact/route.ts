/**
 * "Save contact" on the Use me page: a contact card for the bot, only for a valid invite.
 * /use-me/contact?invite=…  ->  ShoppingSync.vcf
 */
import { lookupInvite } from "@/lib/invites.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const invite = new URL(req.url).searchParams.get("invite") ?? undefined;
  const view = await lookupInvite(invite);
  if (view.state !== "ok" || !view.botNumber) return new Response("This invite link isn't valid.", { status: 404 });
  const card = ["BEGIN:VCARD", "VERSION:3.0", "FN:ShoppingSync", "N:;ShoppingSync;;;",
    `TEL;TYPE=CELL:+${view.botNumber}`, "NOTE:Family shopping list bot", "END:VCARD", ""].join("\r\n");
  return new Response(card, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ShoppingSync.vcf"',
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
