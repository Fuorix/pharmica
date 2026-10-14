import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pharmica/contracts", "@pharmica/database"]
};

export default nextConfig;
