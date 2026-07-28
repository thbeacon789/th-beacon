import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 允許用 127.0.0.1 開發頁面（dev server origin 是 localhost，Next 16 預設封鎖跨 origin dev 資源）
  allowedDevOrigins: ['127.0.0.1'],
  // 多 lockfile 環境下明確指定 workspace root，消除啟動警告
  turbopack: { root: __dirname },
  experimental: {
    useTypeScriptCli: true,
  },
}

export default nextConfig
