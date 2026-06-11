import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // Served at the root of a custom domain (map.fips.network), so assets load
  // from absolute /assets/... paths.
  base: "/",
  // mmdb-lib references a bare `global`; map it to globalThis for the browser.
  define: {
    global: "globalThis",
  },
  server: {
    port: 5174,
  },
});
