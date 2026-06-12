// Browser-side IP → country geolocation.
//
// Everything here runs in the visitor's browser: we lazy-fetch a single
// offline database (DB-IP IP-to-Country Lite, CC-BY) and read it with the
// pure-JS mmdb-lib reader. No peer IP ever leaves the page — that keeps the
// map honest with the rest of the FIPS sites' "no third parties" stance.
//
// Resolution is country-level, so a peer's marker sits at its country's
// centroid rather than its true location. That is deliberately coarse.
import { Buffer } from "buffer";
import { Reader } from "mmdb-lib";
import { COUNTRY_CENTROIDS } from "./centroids.js";

// Vite rewrites import.meta.env.BASE_URL to the deploy base (we use a relative
// "./" base), so the fetch works whether served from a domain root or a
// repo-subpath GitHub Pages URL.
const DB_URL = `${import.meta.env.BASE_URL}dbip-country-lite.mmdb`;

let readerPromise = null;

// Stream the database so callers can show real download progress — the file is
// ~8 MB, which is a noticeable wait on slow connections. onProgress receives a
// fraction in [0, 1]; it's only wired up on the first (memoized) call.
async function fetchArrayBufferWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geo db ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  // No body stream or unknown length: fall back to a single read (no progress).
  if (!res.body || !total) return res.arrayBuffer();

  const stream = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await stream.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(Math.min(1, received / total));
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

// Load + parse the mmdb once; subsequent callers share the same promise.
export function loadGeoDb(onProgress) {
  if (!readerPromise) {
    readerPromise = fetchArrayBufferWithProgress(DB_URL, onProgress).then(
      (ab) => new Reader(Buffer.from(ab)),
    );
  }
  return readerPromise;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

// Pull the bare host out of a FIPS endpoint address. Endpoints look like
// "1.2.3.4:9000" (v4), "[2001:db8::1]:9000" (v6), "nat", "host:port", or a
// "<hash>.onion[:port]" Tor address. We only return something for literal IPs;
// hostnames and onion addresses can't be geolocated offline, so they're
// dropped (returned as null) and simply won't appear on the map.
export function ipFromEndpoint(endpoint) {
  if (!endpoint || !endpoint.addr) return null;
  let s = String(endpoint.addr).trim();
  if (!s || s.toLowerCase() === "nat") return null;
  if (/\.onion(:\d+)?$/i.test(s)) return null;

  // Bracketed IPv6 with optional port: [2001:db8::1]:9000
  const bracket = s.match(/^\[([0-9a-fA-F:]+)\](?::\d+)?$/);
  if (bracket) return isIpv6(bracket[1]) ? bracket[1] : null;

  // IPv4 with optional port.
  const v4 = s.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/);
  if (v4 && IPV4_RE.test(v4[1])) return v4[1];

  // Bare IPv6 (no brackets, no port).
  if (isIpv6(s)) return s;

  return null;
}

function isIpv6(s) {
  // Cheap structural check — must contain a colon and only hex/colon chars.
  // mmdb-lib does the real validation; this just filters obvious non-IPs.
  return s.includes(":") && /^[0-9a-fA-F:]+$/.test(s);
}

// Resolve a single IP to { code, name, lat, lng } or null when the database
// has no entry or we have no centroid for the resolved country.
export function locateIp(reader, ip) {
  let rec;
  try {
    rec = reader.get(ip);
  } catch (_) {
    return null;
  }
  const code = rec?.country?.iso_code;
  if (!code) return null;
  const centroid = COUNTRY_CENTROIDS[code];
  if (!centroid) return null;
  return {
    code,
    name: centroid.name,
    lat: centroid.lat,
    lng: centroid.lng,
  };
}

// Given a peer's advert endpoints, return the first geolocatable location.
// FIPS peers usually advertise a single routable endpoint; if there are
// several we take the first that resolves.
export function locatePeer(reader, endpoints) {
  for (const ep of endpoints || []) {
    const ip = ipFromEndpoint(ep);
    if (!ip) continue;
    const loc = locateIp(reader, ip);
    if (loc) return { ...loc, ip, endpoint: ep };
  }
  return null;
}
