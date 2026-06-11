import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // Relative base so the built assets work whether deployed to root or a
  // repo-subpath GitHub Pages URL (e.g. user.github.io/fips-map).
  base: "./",
  // mmdb-lib references a bare `global`; map it to globalThis for the browser.
  define: {
    global: "globalThis",
  },
  server: {
    port: 5174,
  },
});
