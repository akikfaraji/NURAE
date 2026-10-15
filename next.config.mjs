import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const nextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  serverExternalPackages: ['@libsql/client', '@prisma/adapter-libsql', 'libsql', 'nodemailer'],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        stream: false,
        crypto: false,
        fs: false,
        path: false,
        os: false,
        zlib: false,
        util: false,
        url: false,
        async_hooks: false,
        tls: false,
        net: false,
        buffer: false,
        dns: false,
        child_process: false,
        http: false,
        https: false,
        querystring: false,
      };
    }
    return config;
  },
};

export default nextConfig;