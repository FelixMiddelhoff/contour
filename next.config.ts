import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // keep sharp as a plain require() instead of Turbopack's hashed external
  // module wrapper — the wrapper's runtime module resolution breaks when
  // the app is packaged inside an Electron asar archive
  serverExternalPackages: ["sharp"],
  // we don't want Next's auto-generated AGENTS.md/CLAUDE.md files committed
  agentRules: false,
};

export default nextConfig;
