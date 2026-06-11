<script setup>
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import L from "leaflet";
import { nip19 } from "nostr-tools";
import { useFipsScan, BRANCHES } from "./composables/useFipsScan.js";
import { loadGeoDb, locatePeer } from "./geo/lookup.js";

const {
  activeBranch,
  relaysText,
  sinceDays,
  limit,
  showExpired,
  status,
  errorMsg,
  peerList,
  liveCount,
  expiredCount,
  scan,
  selectBranch,
  resetRelays,
} = useFipsScan();

const filtersOpen = ref(false);

// --- Geolocation ---------------------------------------------------------
// reader is a plain (non-reactive) object; we hold it in a shallowRef so the
// located-peers computed re-runs once the offline db finishes loading.
const reader = shallowRef(null);
const geoStatus = ref("loading geo db…");

// Each peer that resolved to a country, carrying its location + advert meta.
const locatedPeers = computed(() => {
  if (!reader.value) return [];
  const out = [];
  for (const p of peerList.value) {
    const loc = locatePeer(reader.value, p.advert?.endpoints || []);
    if (loc) out.push({ peer: p, loc });
  }
  return out;
});

// Peers we know about but can't place (NAT-only, onion, hostname, or an IP the
// db has no entry for). Surfaced so the map never silently hides nodes.
const unlocatedCount = computed(
  () => peerList.value.length - locatedPeers.value.length,
);

// Group located peers by country for one marker per country.
const countryGroups = computed(() => {
  const groups = new Map();
  for (const { peer, loc } of locatedPeers.value) {
    let g = groups.get(loc.code);
    if (!g) {
      g = { code: loc.code, name: loc.name, lat: loc.lat, lng: loc.lng, items: [] };
      groups.set(loc.code, g);
    }
    g.items.push({ peer, loc });
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
});

// Country currently under the cursor (on a map marker or a list row). Drives
// the highlight in both directions and floats the matching row to the top.
const hoveredCode = ref(null);

// List order: hovered country first, otherwise the count-ranked order.
const displayGroups = computed(() => {
  const groups = countryGroups.value;
  if (!hoveredCode.value) return groups;
  const idx = groups.findIndex((g) => g.code === hoveredCode.value);
  if (idx <= 0) return groups;
  const copy = groups.slice();
  const [hit] = copy.splice(idx, 1);
  copy.unshift(hit);
  return copy;
});

function npubFor(hex) {
  try {
    return nip19.npubEncode(hex);
  } catch (_) {
    return hex;
  }
}
function shortNpub(hex) {
  const npub = npubFor(hex);
  return npub.length > 22 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub;
}
function peerLabel(peer) {
  return peer.pin?.name || shortNpub(peer.event.pubkey);
}

function statusPillClass(s) {
  if (s === "live" || s === "scanning…") return "accent-green";
  if (s === "error") return "accent-red";
  return "";
}

// --- Leaflet map ---------------------------------------------------------
const mapEl = ref(null);
let map = null;
let markerLayer = null;
const markersByCode = new Map();

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function badgeTier(count) {
  if (count >= 10) return "lg";
  if (count >= 4) return "md";
  return "sm";
}

function popupHtml(group) {
  const rows = group.items
    .map(({ peer, loc }) => {
      const star = peer.pin ? '<span class="pop-star">★</span>' : "";
      const exp = peer.expired ? '<span class="pop-exp">expired</span>' : "";
      const ep = loc.endpoint
        ? escapeHtml(`${loc.endpoint.transport}:${loc.endpoint.addr}`)
        : "";
      return `<li>${star}<span class="pop-name">${escapeHtml(
        peerLabel(peer),
      )}</span>${exp}<span class="pop-ep">${ep}</span></li>`;
    })
    .join("");
  return `<div class="pop">
    <div class="pop-head">${escapeHtml(group.name)} <span class="pop-code">${escapeHtml(
      group.code,
    )}</span></div>
    <div class="pop-sub">${group.items.length} peer${
      group.items.length === 1 ? "" : "s"
    }</div>
    <ul class="pop-list">${rows}</ul>
  </div>`;
}

function renderMarkers() {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();
  markersByCode.clear();
  for (const group of countryGroups.value) {
    const count = group.items.length;
    const icon = L.divIcon({
      className: "fips-marker",
      html: `<span class="fips-badge ${badgeTier(count)}">${count}</span>`,
      iconSize: [0, 0],
    });
    const marker = L.marker([group.lat, group.lng], { icon }).bindPopup(
      popupHtml(group),
      { className: "fips-popup", maxWidth: 320 },
    );
    const code = group.code;
    marker.on("mouseover", () => {
      hoveredCode.value = code;
    });
    marker.on("mouseout", () => {
      if (hoveredCode.value === code) hoveredCode.value = null;
    });
    marker.addTo(markerLayer);
    markersByCode.set(code, marker);
  }
  syncMarkerHighlight();
}

// Toggle the highlight class on whichever marker matches hoveredCode. The
// badge lives in Leaflet's DOM (a divIcon), so we reach for its element.
function syncMarkerHighlight() {
  for (const [code, marker] of markersByCode) {
    const el = marker.getElement()?.querySelector(".fips-badge");
    if (el) el.classList.toggle("is-hovered", code === hoveredCode.value);
  }
}

function focusCountry(code) {
  const marker = markersByCode.get(code);
  if (!marker || !map) return;
  map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 4), { duration: 0.6 });
  marker.openPopup();
}

onMounted(async () => {
  map = L.map(mapEl.value, {
    center: [25, 5],
    zoom: 2,
    minZoom: 2,
    maxZoom: 8,
    worldCopyJump: true,
    attributionControl: true,
  });
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 8,
    },
  ).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  scan();

  try {
    reader.value = await loadGeoDb();
    geoStatus.value = "geo db ready";
  } catch (e) {
    geoStatus.value = "geo db failed: " + (e?.message || String(e));
  }
});

// Redraw whenever the located set changes.
watch(countryGroups, renderMarkers, { deep: false });

// Reflect hover state onto the map markers (covers list-row hover too).
watch(hoveredCode, syncMarkerHighlight);

onBeforeUnmount(() => {
  if (map) {
    map.remove();
    map = null;
  }
});
</script>

<template>
  <header class="site-header">
    <div class="container">
      <a class="logo" href="https://fips.network" aria-label="FIPS home">
        <img
          src="/fips_logo.png"
          alt=""
          class="logo-icon"
          aria-hidden="true"
          width="28"
          height="28"
        />
        <span class="logo-words">
          <span class="logo-text">FIPS</span>
          <span class="logo-sub">map.fips.network</span>
        </span>
      </a>
      <nav class="main-nav">
        <a href="https://fips.network">Main</a>
        <a href="https://join.fips.network">Peers</a>
        <a href="https://learn.fips.network">Learn</a>
        <a href="https://awesome.fips.network">Awesome</a>
      </nav>
      <div class="header-actions">
        <a
          class="action-link"
          href="https://github.com/jmcorgan/fips"
          target="_blank"
          rel="noopener noreferrer"
          >GitHub</a
        >
        <a
          class="action-link bordered"
          href="https://github.com/jmcorgan/fips/tree/master/docs/design"
          target="_blank"
          rel="noopener noreferrer"
          >Docs</a
        >
      </div>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container hero-inner">
        <h1 class="hero-title">Where the mesh lives</h1>
        <p class="hero-tagline">
          Live FIPS nodes announcing themselves on Nostr, placed on the map by
          the country of their advertised IP. Geolocation runs entirely in your
          browser against an offline database — no peer address leaves the page.
        </p>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <!-- Branch tabs swap which d-tag namespace we scan. -->
        <div class="tabs" role="tablist" aria-label="FIPS branch">
          <button
            v-for="b in BRANCHES"
            :key="b.id"
            class="tab"
            :class="{ active: activeBranch === b.id }"
            role="tab"
            :aria-selected="activeBranch === b.id"
            @click="selectBranch(b.id)"
          >
            <span class="tab-label">{{ b.label }}</span>
            <span class="tab-hint">{{ b.hint }}</span>
          </button>
        </div>

        <div class="bar">
          <div class="bar-left">
            <div class="stats">
              <span class="pill accent-green">
                <span class="pill-k">live</span>
                <span class="pill-v">{{ liveCount }}</span>
              </span>
              <span class="pill">
                <span class="pill-k">on map</span>
                <span class="pill-v">{{ locatedPeers.length }}</span>
              </span>
              <span class="pill">
                <span class="pill-k">unplaced</span>
                <span class="pill-v">{{ unlocatedCount }}</span>
              </span>
              <span class="pill accent-red">
                <span class="pill-k">expired</span>
                <span class="pill-v">{{ expiredCount }}</span>
              </span>
              <span class="pill" :class="statusPillClass(status)">
                <span class="pill-k">status</span>
                <span class="pill-v">{{ status }}</span>
              </span>
            </div>
          </div>
          <div class="bar-actions">
            <button
              class="secondary"
              :aria-expanded="filtersOpen"
              @click="filtersOpen = !filtersOpen"
            >
              <span>Filters</span>
              <svg
                :class="{ open: filtersOpen }"
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>

        <div v-if="filtersOpen" class="panel">
          <div class="panel-head">
            <div>
              <span class="eyebrow">relays</span>
              <p class="panel-hint">
                FIPS nodes publish to <code>wss://relay.damus.io</code>,
                <code>wss://nos.lol</code>, and
                <code>wss://offchain.pub</code> by default. Adverts carry a
                <code>~1 h</code> NIP-40 expiration, so offline peers can be
                invisible.
              </p>
            </div>
            <button class="secondary tiny" @click="resetRelays">
              reset defaults
            </button>
          </div>
          <textarea
            v-model="relaysText"
            spellcheck="false"
            aria-label="Relays, one per line"
          />

          <div class="controls-row">
            <div class="field">
              <label>Lookback (days)</label>
              <input v-model.number="sinceDays" type="number" min="0" step="1" />
            </div>
            <div class="field">
              <label>Limit per relay</label>
              <input v-model.number="limit" type="number" min="0" step="100" />
            </div>
          </div>

          <div class="toggles">
            <label>
              <input v-model="showExpired" type="checkbox" />
              <span>show expired (offline) peers</span>
            </label>
          </div>

          <div class="panel-apply">
            <button @click="scan">Apply</button>
          </div>
        </div>

        <div class="map-layout">
          <div class="map-wrap">
            <div ref="mapEl" class="map" />
            <div class="map-legend">
              <span class="legend-dot" /> peer count per country ·
              <span class="muted">country-level (approximate)</span>
            </div>
          </div>

          <aside class="side">
            <div class="side-head">
              <span class="eyebrow">countries</span>
              <span class="side-count">{{ countryGroups.length }}</span>
            </div>
            <ul v-if="countryGroups.length" class="country-list">
              <li
                v-for="g in displayGroups"
                :key="g.code"
                class="country-row"
                :class="{ 'is-hovered': g.code === hoveredCode }"
                @click="focusCountry(g.code)"
                @mouseenter="hoveredCode = g.code"
                @mouseleave="hoveredCode = null"
              >
                <span class="country-name">
                  <span class="country-code">{{ g.code }}</span>
                  {{ g.name }}
                </span>
                <span class="country-count">{{ g.items.length }}</span>
              </li>
            </ul>
            <div v-else class="side-empty">
              <p>{{ geoStatus }}</p>
              <p v-if="reader" class="muted">
                No peers placed yet. Adverts are still arriving, or live peers
                only expose NAT/onion endpoints.
              </p>
            </div>
            <p v-if="unlocatedCount > 0 && reader" class="side-note">
              {{ unlocatedCount }} live peer{{ unlocatedCount === 1 ? "" : "s" }}
              not shown (NAT-only, onion, or unrecognized address).
            </p>
          </aside>
        </div>

        <div v-if="errorMsg" class="err">{{ errorMsg }}</div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="footer-brand">
        <span class="footer-logo">FIPS</span>
        <span class="footer-domain">map.fips.network</span>
      </div>
      <div class="footer-note">
        No analytics. No cookies. Geolocation runs in your browser against an
        offline DB-IP database. Map tiles © OpenStreetMap, © CARTO.
      </div>
    </div>
  </footer>
</template>

<style scoped>
.container {
  max-width: var(--content-wide-max-width);
  margin: 0 auto;
  padding: 0 var(--space-lg);
}

/* Header ---------------------------------------------------------------- */
.site-header {
  border-bottom: 1px solid var(--border-subtle);
  padding: var(--space-md) 0;
  position: sticky;
  top: 0;
  z-index: 1000;
  background: rgba(11, 15, 26, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.site-header > .container {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 1;
  color: var(--text-primary);
}
.logo:hover {
  text-decoration: none;
}
.logo-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 4px;
}
.logo-words {
  display: flex;
  flex-direction: column;
}
.logo-text {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.logo:hover .logo-text {
  color: var(--color-app-border);
}
.logo-sub {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-top: 2px;
}
.main-nav {
  display: flex;
  gap: var(--space-lg);
  flex: 1;
  justify-content: center;
  flex-wrap: wrap;
}
.main-nav a {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-muted);
  transition: color 0.2s;
}
.main-nav a:hover {
  color: var(--text-primary);
  text-decoration: none;
}
.header-actions {
  display: flex;
  gap: var(--space-sm);
}
.action-link {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-secondary);
  padding: 5px 12px;
  border-radius: 5px;
  border: 1px solid transparent;
  transition: all 0.15s;
}
.action-link:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--border-subtle);
  text-decoration: none;
}
.action-link.bordered {
  border-color: var(--border-subtle);
}

/* Hero ------------------------------------------------------------------ */
.hero {
  padding: calc(var(--space-lg) + var(--space-md)) 0 var(--space-lg);
}
.hero-title {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: clamp(2rem, 5vw, 3.25rem);
  letter-spacing: -0.02em;
  margin: var(--space-sm) 0 var(--space-md);
  line-height: 1;
}
.hero-tagline {
  color: var(--text-secondary);
  max-width: 680px;
  font-size: 1rem;
  line-height: 1.6;
  margin: 0;
}

/* Sections -------------------------------------------------------------- */
.section {
  padding-bottom: calc(var(--space-xl) + var(--space-lg));
}

/* Branch tabs ----------------------------------------------------------- */
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
}
.tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  cursor: pointer;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.tab:hover {
  background: rgba(255, 255, 255, 0.03);
}
.tab.active {
  border-bottom-color: var(--color-app-border);
}
.tab-label {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-muted);
}
.tab.active .tab-label {
  color: var(--text-primary);
}
.tab-hint {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.tab.active .tab-hint {
  color: var(--color-app-border);
}

/* Results bar ----------------------------------------------------------- */
.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
  flex-wrap: wrap;
}
.bar-actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bar-actions svg {
  transition: transform 0.2s ease;
}
.bar-actions svg.open {
  transform: rotate(180deg);
}
.stats {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.stats .pill {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.stats .pill-k {
  color: var(--text-muted);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.stats .pill-v {
  color: var(--text-primary);
  font-weight: 500;
}
.stats .pill.accent-green {
  color: var(--color-app-border);
  border-color: var(--color-app-border);
  background: rgba(64, 160, 96, 0.08);
}
.stats .pill.accent-green .pill-v {
  color: var(--color-app-border);
}
.stats .pill.accent-red {
  color: var(--color-transport-border);
  border-color: var(--color-transport-border);
  background: rgba(192, 96, 64, 0.08);
}
.stats .pill.accent-red .pill-v {
  color: var(--color-transport-border);
}

/* Panel (controls) ------------------------------------------------------ */
.panel {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: var(--space-lg);
  margin-bottom: var(--space-lg);
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}
.panel-head > div {
  flex: 1;
}
.panel-hint {
  font-size: 0.8125rem;
  color: var(--text-muted);
  margin: var(--space-sm) 0 0;
  line-height: 1.55;
  max-width: 640px;
}
.panel-hint code {
  font-size: 0.8125rem;
}
button.tiny {
  padding: 5px 11px;
  font-size: 0.6875rem;
  font-weight: 500;
}
.controls-row {
  display: flex;
  gap: var(--space-md);
  align-items: flex-end;
  margin-top: var(--space-md);
  flex-wrap: wrap;
}
.field {
  flex: 1;
  min-width: 180px;
}
.field label {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.field input {
  width: 100%;
}
.toggles {
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  gap: var(--space-lg);
  flex-wrap: wrap;
}
.toggles label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
}
.toggles input[type="checkbox"] {
  accent-color: var(--color-app-border);
  width: 14px;
  height: 14px;
  padding: 0;
}
.panel-apply {
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  justify-content: flex-end;
}

/* Map layout ------------------------------------------------------------ */
.map-layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: var(--space-md);
  align-items: stretch;
}
.map-wrap {
  position: relative;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-surface);
}
.map {
  width: 100%;
  height: clamp(560px, 78vh, 960px);
  background: #0a0a12;
}
.map-legend {
  position: absolute;
  bottom: 8px;
  left: 8px;
  z-index: 500;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--text-secondary);
  background: rgba(11, 15, 26, 0.85);
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  padding: 4px 9px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.map-legend .legend-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--color-app-border);
  box-shadow: 0 0 8px var(--color-app-border);
}
.map-legend .muted {
  color: var(--text-muted);
}

/* Side list ------------------------------------------------------------- */
.side {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-surface);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  max-height: clamp(560px, 78vh, 960px);
}
.side-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-sm);
}
.side-count {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-primary);
}
.country-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.country-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-sm);
  padding: 7px 8px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.country-row:hover,
.country-row.is-hovered {
  background: rgba(64, 160, 96, 0.14);
  box-shadow: inset 2px 0 0 var(--color-app-border);
}
.country-name {
  font-size: 0.8125rem;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.country-code {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--text-muted);
  flex-shrink: 0;
}
.country-count {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--color-app-border);
  font-weight: 600;
  flex-shrink: 0;
}
.side-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.8125rem;
  gap: var(--space-sm);
  padding: var(--space-md);
}
.side-empty .muted {
  color: var(--text-muted);
  font-size: 0.75rem;
}
.side-note {
  margin: var(--space-sm) 0 0;
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-subtle);
  font-size: 0.6875rem;
  color: var(--text-muted);
  line-height: 1.45;
}

.err {
  color: var(--color-transport-border);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  margin-top: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-transport-border);
  background: var(--color-transport);
  border-radius: 5px;
}

/* Footer ---------------------------------------------------------------- */
.site-footer {
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  padding: var(--space-lg) 0;
  margin-top: var(--space-xl);
}
.site-footer .container {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-md);
  flex-wrap: wrap;
}
.footer-brand {
  display: flex;
  flex-direction: column;
  line-height: 1;
}
.footer-logo {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 1rem;
}
.footer-domain {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-top: 2px;
}
.footer-note {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--text-muted);
  letter-spacing: 0.02em;
  max-width: 520px;
  text-align: right;
}

/* Mobile ---------------------------------------------------------------- */
@media (max-width: 860px) {
  .map-layout {
    grid-template-columns: 1fr;
  }
  .side {
    max-height: 320px;
  }
  .main-nav {
    display: none;
  }
  .footer-note {
    text-align: left;
  }
}
</style>
