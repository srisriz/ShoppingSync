/** Phone numbers as digits with country code ("447700900123"), the form WhatsApp uses. */

/** "07700 900123" -> "447700900123"; "+44 7700 900123" -> "447700900123". UK numbers starting 0 get 44. */
export function normalisePhone(input: string): string | null {
  let d = input.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (/^0\d{10}$/.test(d)) d = `44${d.slice(1)}`;
  d = d.replace(/\D/g, "");
  return /^\d{8,15}$/.test(d) ? d : null;
}

/** "447700900123" -> "+44 7700 900123" (UK numbers grouped; others just get a +). */
export function prettyPhone(n: string): string {
  return /^44\d{10}$/.test(n) ? `+44 ${n.slice(2, 6)} ${n.slice(6)}` : `+${n}`;
}

/** A WhatsApp chat with this number, optionally with a message typed in and ready to send. */
export function waLink(n: string, text?: string): string {
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
