/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output for the Docker image. Gated behind an env var because the standalone
  // file-tracing step creates symlinks, which require Developer Mode on Windows; the Docker
  // build (Linux) sets NEXT_OUTPUT=standalone.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Workspace packages are plain TS; let Next transpile them.
  transpilePackages: ["@uc/core", "@uc/db", "@uc/connectors", "@uc/notifications"],
  experimental: {
    // Native / server-only modules kept out of the client + server bundles. playwright-core
    // is pulled in transitively by @uc/connectors but never launched by the web app.
    serverComponentsExternalPackages: [
      "@node-rs/argon2",
      "pg",
      "pg-boss",
      "playwright-core",
    ],
  },
  webpack: (config, { isServer }) => {
    // Resolve ESM-style `.js` relative imports to their TS sources.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    // playwright-core is pulled in transitively by @uc/connectors but never launched by the
    // web app. Keep it external (runtime require) so webpack never tries to bundle its
    // internal browser-protocol modules.
    if (isServer) {
      config.externals = [...(config.externals ?? []), { "playwright-core": "commonjs playwright-core" }];
    }
    return config;
  },
};

export default nextConfig;
