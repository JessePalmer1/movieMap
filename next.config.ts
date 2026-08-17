import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Posters are the only thing served from TMDB, and only at display time.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
    ],
  },
};

export default nextConfig;
