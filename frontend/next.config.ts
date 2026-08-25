import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images-uat.corelogic.asia",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "images.corelogic.asia",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
