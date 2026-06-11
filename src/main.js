// Must be first: installs globalThis.Buffer before mmdb-lib's subtree is
// evaluated (see polyfills.js for why import order matters here).
import "./polyfills.js";

import { createApp } from "vue";
import App from "./App.vue";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "leaflet/dist/leaflet.css";
import "./style.css";

createApp(App).mount("#app");
