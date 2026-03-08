import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ddragon.leagueoflegends.com",
      },
      {
        protocol: "https",
        hostname: "static.lolesports.com",
      },
      {
        protocol: "http",
        hostname: "static.lolesports.com",
      },
      {
        protocol: "https",
        hostname: "raw.communitydragon.org",
      },
    ],
  },
};

export default nextConfig;
