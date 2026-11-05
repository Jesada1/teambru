/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enables a minimal standalone server for fast Docker startup
  output: "standalone",
  reactStrictMode: true,
  // Offline / air-gapped friendly: do not phone home
  poweredByHeader: false,
  experimental: {
    // Keep build self-contained; solver runs in-process on the client
  },
};

export default nextConfig;
