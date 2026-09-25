/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Build into a staging directory when NEXT_DIST_DIR is set, so a build never
  // overwrites the `.next` the running server is serving from. The operator
  // builds to `.next.new`, then swaps and restarts; a failed build cannot take
  // the portal down.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // The API base URL is read at request time rather than baked in at build, so
  // one built image can be promoted between environments.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws',
  },
  eslint: {
    // Lint is a separate step in CI; a lint failure must not block a build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
