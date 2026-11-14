/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  experimental: { instrumentationHook: true, serverComponentsExternalPackages: ['pg', 'qrcode'] },
  async headers() {
    const safe = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
    ];
    return [{ source: '/', headers: safe }, { source: '/api', headers: safe }, { source: '/api/get', headers: safe }];
  },
};

module.exports = nextConfig;
