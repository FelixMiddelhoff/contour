import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // keep sharp as a plain require() instead of Turbopack's hashed external
  // module wrapper — the wrapper's runtime module resolution breaks when
  // the app is packaged inside an Electron asar archive
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
