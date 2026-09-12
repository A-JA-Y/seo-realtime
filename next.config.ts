import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // The Neon serverless driver and google-auth-library are server-only.
  serverExternalPackages: ['@neondatabase/serverless', 'google-auth-library'],
};

export default nextConfig;
