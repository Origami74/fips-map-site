// FIPS peer discovery over Nostr, extracted from join-fips-site's App.vue so
// both the table site and this map site share one implementation. Subscribes
// to kind-37195 adverts on a set of relays and exposes the live peer set plus
// the controls (relays, branch, filters) that drive the subscription.
import { computed, onBeforeUnmount, ref } from "vue";
import { RelayPool, onlyEvents } from "applesauce-relay";
import { nip19 } from "nostr-tools";
import { PINNED } from "../pinned.js";

// hex pubkey → { name } for fast lookup against incoming events.
const PINNED_BY_HEX = new Map();
for (const entry of PINNED) {
  try {
    const dec = nip19.decode(entry.npub);
    if (dec.type === "npub") {
      PINNED_BY_HEX.set(dec.data, { name: entry.name ?? null });
    }
  } catch (_) {
    // Bad npub in pinned.js — skip rather than crash the whole list.
  }
}

// Kind 37195 is FIPS's parameterized replaceable advert (digits spell FIPS:
// 7=F, 1=I, 9=P, 5=S).
export const ADVERT_KIND = 37195;

// Each FIPS branch publishes its adverts under a distinct d-tag namespace so
// wire-incompatible branches never try to mesh with each other.
export const BRANCHES = [
  { id: "master", label: "Stable", hint: "master · FMP-v0", d: "fips-overlay-v1" },
  { id: "next", label: "Next", hint: "next · FMP-v1", d: "fips-overlay-v1-next" },
];

// FIPS in-tree defaults (src/config/node.rs::default_advert_relays).
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://offchain.pub",
];

function tagValue(ev, name) {
  const t = ev.tags.find((x) => x[0] === name);
  return t ? t[1] : null;
}

function parseAdvert(ev) {
  try {
    if (ev.content && ev.content.trim().startsWith("{")) {
      return JSON.parse(ev.content);
    }
  } catch (_) {
    // Tolerate malformed bodies so the pubkey still shows up.
  }
  return null;
}

export function useFipsScan() {
  const activeBranch = ref("master");
  const advertD = computed(
    () => BRANCHES.find((b) => b.id === activeBranch.value)?.d ?? BRANCHES[0].d,
  );

  const relaysText = ref(DEFAULT_RELAYS.join("\n"));
  const sinceDays = ref(0);
  const limit = ref(1000);
  const showExpired = ref(false);
  const status = ref("idle");
  const errorMsg = ref("");
  const eventCount = ref(0);
  const peers = ref(new Map());

  let pool = null;
  let sub = null;

  const relayUrls = computed(() =>
    relaysText.value
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("ws://") || s.startsWith("wss://")),
  );

  const nowSec = ref(Math.floor(Date.now() / 1000));
  const clock = setInterval(() => {
    nowSec.value = Math.floor(Date.now() / 1000);
  }, 5000);

  function isExpired(p) {
    const exp = tagValue(p.event, "expiration");
    return exp ? Number(exp) < nowSec.value : false;
  }

  // Every known peer, pin-annotated, optionally hiding expired ones.
  const peerList = computed(() => {
    const list = [...peers.value.values()];
    return list
      .filter((p) => (showExpired.value ? true : !isExpired(p)))
      .map((p) => ({
        ...p,
        pin: PINNED_BY_HEX.get(p.event.pubkey) ?? null,
        expired: isExpired(p),
      }));
  });

  const expiredCount = computed(() => {
    let n = 0;
    for (const p of peers.value.values()) if (isExpired(p)) n++;
    return n;
  });
  const liveCount = computed(() => peers.value.size - expiredCount.value);

  function onEvent(ev) {
    if (!ev || ev.kind !== ADVERT_KIND) return;
    if (tagValue(ev, "d") !== advertD.value) return;
    eventCount.value++;
    const existing = peers.value.get(ev.pubkey);
    if (existing && existing.event.created_at >= ev.created_at) return;
    const next = new Map(peers.value);
    next.set(ev.pubkey, { event: ev, advert: parseAdvert(ev) });
    peers.value = next;
  }

  function stop() {
    if (sub) {
      try {
        sub.unsubscribe();
      } catch (_) {
        // RelayPool teardown is best-effort.
      }
      sub = null;
    }
    status.value = "idle";
  }

  function scan() {
    stop();
    errorMsg.value = "";
    peers.value = new Map();
    eventCount.value = 0;

    if (relayUrls.value.length === 0) {
      errorMsg.value = "Add at least one relay.";
      return;
    }

    if (!pool) pool = new RelayPool();

    const filter = { kinds: [ADVERT_KIND], "#d": [advertD.value] };
    if (sinceDays.value > 0) {
      filter.since = Math.floor(Date.now() / 1000) - sinceDays.value * 86400;
    }
    if (limit.value > 0) filter.limit = limit.value;

    status.value = "scanning…";
    try {
      sub = pool
        .subscription(relayUrls.value, filter)
        .pipe(onlyEvents())
        .subscribe({
          next: (ev) => {
            status.value = "live";
            onEvent(ev);
          },
          error: (e) => {
            errorMsg.value = "relay error: " + (e?.message || String(e));
            status.value = "error";
          },
          complete: () => {
            status.value = "complete";
          },
        });
    } catch (e) {
      errorMsg.value = "query failed: " + (e?.message || String(e));
      status.value = "error";
    }
  }

  function selectBranch(id) {
    if (id === activeBranch.value) return;
    activeBranch.value = id;
    scan();
  }

  function resetRelays() {
    relaysText.value = DEFAULT_RELAYS.join("\n");
  }

  onBeforeUnmount(() => {
    stop();
    clearInterval(clock);
  });

  return {
    // controls
    activeBranch,
    advertD,
    relaysText,
    relayUrls,
    sinceDays,
    limit,
    showExpired,
    // state
    status,
    errorMsg,
    eventCount,
    nowSec,
    peers,
    peerList,
    liveCount,
    expiredCount,
    // actions
    scan,
    stop,
    selectBranch,
    resetRelays,
  };
}
