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
  errorMsg,
  nowSec,
  peerList,
  liveCount,
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
const geoLoading = ref(true);
const geoProgress = ref(0); // download fraction [0, 1]
const geoPct = computed(() => Math.round(geoProgress.value * 100));

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

// Within a country, starred (pinned) nodes first — alphabetically by their
// pin name — then the rest, newest advert first.
function compareNodes(a, b) {
  const pa = a.peer.pin ? 0 : 1;
  const pb = b.peer.pin ? 0 : 1;
  if (pa !== pb) return pa - pb;
  if (a.peer.pin && b.peer.pin) {
    return (a.peer.pin.name || "").localeCompare(b.peer.pin.name || "");
  }
  return b.peer.event.created_at - a.peer.event.created_at;
}

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
  const list = [...groups.values()];
  for (const g of list) {
    g.items.sort(compareNodes);
    g.pinned = g.items.reduce((n, it) => n + (it.peer.pin ? 1 : 0), 0);
  }
  // Countries with starred nodes float to the top, then by peer count.
  return list.sort(
    (a, b) => Number(b.pinned > 0) - Number(a.pinned > 0) || b.items.length - a.items.length,
  );
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

// --- Selection (Vue-driven detail panel) ---------------------------------
// We deliberately do NOT use Leaflet popups: on touch devices the map swallows
// the tap and closes the popup almost immediately. Driving the panel from Vue
// state keeps it open until the user dismisses it, and lets a node be selected
// for its own detail view.
const selectedCode = ref(null); // country shown in the panel
const selectedKey = ref(null); // pubkey of the node shown in detail
const sideEl = ref(null);

const selectedGroup = computed(
  () => countryGroups.value.find((g) => g.code === selectedCode.value) ?? null,
);
const selectedPeer = computed(() => {
  if (!selectedGroup.value || !selectedKey.value) return null;
  return (
    selectedGroup.value.items.find(
      (it) => it.peer.event.pubkey === selectedKey.value,
    ) ?? null
  );
});

function revealPanelOnMobile() {
  if (typeof window !== "undefined" && window.innerWidth <= 860) {
    // Let the DOM update (panel switches view) before scrolling to it.
    requestAnimationFrame(() => {
      sideEl.value?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

function selectCountry(code, { fly = true } = {}) {
  selectedCode.value = code;
  selectedKey.value = null;
  if (fly) {
    const marker = markersByCode.get(code);
    if (marker && map) {
      map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 4), {
        duration: 0.6,
      });
    }
  }
  revealPanelOnMobile();
}

function selectPeer(pubkey) {
  selectedKey.value = pubkey;
  revealPanelOnMobile();
}

function clearSelection() {
  selectedCode.value = null;
  selectedKey.value = null;
}

// If the selected country drops out of the live set (rescan, expiry), fall
// back to the list rather than showing a stale/empty detail view.
watch(countryGroups, (groups) => {
  if (selectedCode.value && !groups.some((g) => g.code === selectedCode.value)) {
    clearSelection();
  }
});

// --- Node detail helpers -------------------------------------------------
function tagValue(ev, name) {
  const t = ev.tags.find((x) => x[0] === name);
  return t ? t[1] : null;
}
function peerProtocol(peer) {
  return tagValue(peer.event, "protocol") || "(missing)";
}
function peerVersion(peer) {
  return tagValue(peer.event, "version") || "?";
}
function formatUnix(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", "Z");
}
function relativeTime(ts) {
  if (!ts) return "";
  const diff = nowSec.value - ts;
  const abs = Math.abs(diff);
  const unit =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.floor(abs / 60)}m`
        : abs < 86400
          ? `${Math.floor(abs / 3600)}h`
          : `${Math.floor(abs / 86400)}d`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

const copiedKey = ref(null);
async function copyValue(key, value) {
  try {
    await navigator.clipboard.writeText(value);
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, 1200);
  } catch (_) {
    // Clipboard API can fail in non-secure contexts; ignore.
  }
}

// --- Leaflet map ---------------------------------------------------------
const mapEl = ref(null);
let map = null;
let markerLayer = null;
const markersByCode = new Map();

function badgeTier(count) {
  if (count >= 10) return "lg";
  if (count >= 4) return "md";
  return "sm";
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
    const marker = L.marker([group.lat, group.lng], {
      icon,
      // Larger touch target so taps land reliably on mobile.
      riseOnHover: true,
    });
    const code = group.code;
    // Tap/click selects the country into the Vue panel (no Leaflet popup).
    marker.on("click", () => selectCountry(code, { fly: false }));
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
  selectCountry(code);
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
    reader.value = await loadGeoDb((frac) => {
      geoProgress.value = frac;
    });
    geoStatus.value = "geo db ready";
  } catch (e) {
    geoStatus.value = "geo db failed: " + (e?.message || String(e));
  } finally {
    geoLoading.value = false;
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
                <span class="pill-k">known location</span>
                <span class="pill-v">{{ locatedPeers.length }}</span>
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

            <!-- Geo DB download overlay. The ~8 MB database must arrive before
                 any peer can be placed, so we keep the map masked until it's
                 ready and show real progress. -->
            <div v-if="geoLoading" class="map-loading">
              <div class="loading-card">
                <span class="spinner" aria-hidden="true" />
                <p class="loading-title">Loading geolocation database…</p>
                <div class="progress-track">
                  <div class="progress-bar" :style="{ width: geoPct + '%' }" />
                </div>
                <p class="loading-sub">
                  {{ geoPct }}% · ~8 MB offline database — this may take a while
                  on slow connections (cached after the first load).
                </p>
              </div>
            </div>
          </div>

          <aside ref="sideEl" class="side">
            <!-- Loading -->
            <div v-if="geoLoading" class="side-empty">
              <span class="spinner small" aria-hidden="true" />
              <p>Loading geolocation database… {{ geoPct }}%</p>
            </div>

            <!-- Node detail -->
            <template v-else-if="selectedPeer">
              <div class="side-head detail-head">
                <button
                  class="back-btn"
                  @click="selectedKey = null"
                  aria-label="Back to country"
                >
                  ‹ {{ selectedGroup.name }}
                </button>
              </div>
              <div class="node-detail">
                <div class="node-title">
                  <span v-if="selectedPeer.peer.pin" class="pin-star">★</span>
                  <span class="node-name">{{ peerLabel(selectedPeer.peer) }}</span>
                  <span
                    class="dot"
                    :class="{ off: selectedPeer.peer.expired }"
                    :title="selectedPeer.peer.expired ? 'expired' : 'live'"
                  />
                </div>

                <dl class="kv">
                  <dt>country</dt>
                  <dd>{{ selectedPeer.loc.name }} ({{ selectedPeer.loc.code }})</dd>

                  <dt>protocol</dt>
                  <dd>
                    {{ peerProtocol(selectedPeer.peer) }}
                    <span class="muted">v{{ peerVersion(selectedPeer.peer) }}</span>
                  </dd>

                  <dt>endpoints</dt>
                  <dd>
                    <div
                      v-for="e in selectedPeer.peer.advert?.endpoints || []"
                      :key="`${e.transport}:${e.addr}`"
                      class="ep-row"
                    >
                      <span class="mono">{{ e.transport }}:{{ e.addr }}</span>
                      <button
                        class="copy-btn"
                        @click="copyValue(`ep:${e.addr}`, `${e.transport}:${e.addr}`)"
                      >
                        {{ copiedKey === `ep:${e.addr}` ? "✓" : "copy" }}
                      </button>
                    </div>
                    <span
                      v-if="!(selectedPeer.peer.advert?.endpoints || []).length"
                      class="muted"
                      >none</span
                    >
                  </dd>

                  <dt>npub</dt>
                  <dd class="wrap">
                    <span class="mono small">{{ npubFor(selectedPeer.peer.event.pubkey) }}</span>
                    <button
                      class="copy-btn"
                      @click="copyValue('npub', npubFor(selectedPeer.peer.event.pubkey))"
                    >
                      {{ copiedKey === "npub" ? "✓" : "copy" }}
                    </button>
                  </dd>

                  <dt>pubkey</dt>
                  <dd class="wrap">
                    <span class="mono small muted">{{ selectedPeer.peer.event.pubkey }}</span>
                    <button
                      class="copy-btn"
                      @click="copyValue('hex', selectedPeer.peer.event.pubkey)"
                    >
                      {{ copiedKey === "hex" ? "✓" : "copy" }}
                    </button>
                  </dd>

                  <dt>last seen</dt>
                  <dd>
                    {{ relativeTime(selectedPeer.peer.event.created_at) }}
                    <span class="muted small">{{ formatUnix(selectedPeer.peer.event.created_at) }}</span>
                  </dd>
                </dl>
              </div>
            </template>

            <!-- Country detail: list of nodes -->
            <template v-else-if="selectedGroup">
              <div class="side-head detail-head">
                <button
                  class="back-btn"
                  @click="clearSelection"
                  aria-label="Back to all countries"
                >
                  ‹ all countries
                </button>
                <span class="side-count">{{ selectedGroup.items.length }}</span>
              </div>
              <div class="detail-country">
                <span class="country-code">{{ selectedGroup.code }}</span>
                {{ selectedGroup.name }}
              </div>
              <ul class="node-list">
                <li
                  v-for="it in selectedGroup.items"
                  :key="it.peer.event.pubkey"
                  class="node-row"
                  @click="selectPeer(it.peer.event.pubkey)"
                >
                  <span class="node-row-main">
                    <span v-if="it.peer.pin" class="pin-star">★</span>
                    <span class="node-name">{{ peerLabel(it.peer) }}</span>
                    <span class="tag accent-red" v-if="it.peer.expired">expired</span>
                  </span>
                  <span class="node-ep mono">{{ it.loc.endpoint.transport }}:{{ it.loc.endpoint.addr }}</span>
                </li>
              </ul>
            </template>

            <!-- Country list (default) -->
            <template v-else>
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
                  @click="selectCountry(g.code)"
                  @mouseenter="hoveredCode = g.code"
                  @mouseleave="hoveredCode = null"
                >
                  <span class="country-name">
                    <span v-if="g.pinned" class="pin-star" title="has recommended node">★</span>
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
            </template>
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

/* Map loading overlay --------------------------------------------------- */
.map-loading {
  position: absolute;
  inset: 0;
  z-index: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 10, 18, 0.82);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.loading-card {
  width: min(360px, 86%);
  text-align: center;
  padding: var(--space-lg);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-surface);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.loading-title {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  color: var(--text-primary);
  margin: var(--space-sm) 0;
}
.loading-sub {
  font-size: 0.6875rem;
  color: var(--text-muted);
  line-height: 1.5;
  margin: var(--space-sm) 0 0;
}
.progress-track {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-surface-alt);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: var(--color-app-border);
  box-shadow: 0 0 10px rgba(64, 160, 96, 0.7);
  transition: width 0.2s ease;
}
.spinner {
  display: inline-block;
  width: 26px;
  height: 26px;
  border: 3px solid var(--border-subtle);
  border-top-color: var(--color-app-border);
  border-radius: 50%;
  animation: fips-spin 0.8s linear infinite;
}
.spinner.small {
  width: 18px;
  height: 18px;
  border-width: 2px;
  margin-bottom: var(--space-sm);
}
@keyframes fips-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Detail / node views --------------------------------------------------- */
.detail-head {
  gap: var(--space-sm);
}
.back-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  padding: 4px 10px;
  border-radius: 5px;
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.back-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-medium);
  background: rgba(255, 255, 255, 0.03);
}
.detail-country {
  font-family: var(--font-mono);
  font-size: 0.9375rem;
  color: var(--text-primary);
  margin-bottom: var(--space-sm);
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.node-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.node-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 8px;
  border-radius: 5px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.12s ease;
}
.node-row:hover {
  background: rgba(64, 160, 96, 0.1);
}
.node-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
}
.node-name {
  font-size: 0.8125rem;
  color: var(--text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-ep {
  font-size: 0.6875rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pin-star {
  color: var(--accent-gold);
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-app-border);
  box-shadow: 0 0 8px var(--color-app-border);
  flex-shrink: 0;
}
.dot.off {
  background: var(--color-transport-border);
  box-shadow: 0 0 6px var(--color-transport-border);
}

.node-detail {
  overflow-y: auto;
  flex: 1;
}
.node-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--space-md);
}
.node-title .node-name {
  font-size: 0.9375rem;
  white-space: normal;
}
.kv {
  margin: 0;
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 8px var(--space-md);
}
.kv dt {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  padding-top: 2px;
}
.kv dd {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-primary);
  min-width: 0;
}
.kv dd.wrap .mono {
  word-break: break-all;
}
.kv .mono {
  font-family: var(--font-mono);
}
.kv .small {
  font-size: 0.6875rem;
}
.kv .muted {
  color: var(--text-muted);
}
.ep-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.copy-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  padding: 1px 7px;
  border-radius: 4px;
  cursor: pointer;
}
.copy-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-medium);
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
