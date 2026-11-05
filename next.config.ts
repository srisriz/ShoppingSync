import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Baileys (WhatsApp) runs only in server code; keep it out of the browser bundle.
  serverExternalPackages: ["baileys", "pino"],
};

export default nextConfig;
