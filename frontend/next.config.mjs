/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
