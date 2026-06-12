import { defineConfig } from 'vite';

export default defineConfig({
  base: '/paper_trade_lib/',

  server: {
    proxy: {
      '/eapi': {
        target: 'https://eapi.binance.com',
        changeOrigin: true,
      },
      '/api': {
        target: 'https://api.binance.com',
        changeOrigin: true,
      },
      '/fapi': {
        target: 'https://fapi.binance.com',
        changeOrigin: true,
      },
      '/cryptopanic': {
        target: 'https://cryptopanic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cryptopanic/, '')
      }
    }
  }
});