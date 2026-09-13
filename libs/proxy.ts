// Corporate proxy support, plus the undici timeout override every request needs.
//
// Two separate problems, one mechanism.
//
// 1. Node's built-in fetch ignores HTTP_PROXY / HTTPS_PROXY entirely — unlike curl, git and
//    mvn, which all read them. On a network whose only egress is a proxy that shows up as a
//    bare ECONNREFUSED with no hint a proxy was ever involved.
// 2. undici's own headersTimeout / bodyTimeout default to 300s and sit *underneath* the
//    api runner's AbortController. A slow model that takes more than five minutes to produce
//    its first byte dies at ~301s with "TypeError: fetch failed", long before
//    UT_AGENT_TIMEOUT_MS. Timeouts are the runner's job; undici must not have an opinion.
//
// Both are fixed by handing fetch an explicit dispatcher, so this module always returns one
// even when no proxy is configured.
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { HTTP_PROXY, HTTPS_PROXY, NO_PROXY, USER_AGENT_OVERRIDE } from "../config";
import { logVerbose } from "./log";
import { caBundle, caSummary } from "./tls";
import * as fs from "node:fs";
import * as path from "node:path";
import { TESTGEN_ROOT } from "../config";

export { HTTP_PROXY, HTTPS_PROXY, NO_PROXY };

// The package version alone, not the full version stamp: a UA is a token, and getToolVersion
// spawns git — neither belongs on an import that every request path pulls in.
const pkgVersion = (() => {
  try {
    const raw = fs.readFileSync(path.join(TESTGEN_ROOT, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Sent on ordinary requests and on the proxy CONNECT, which is where filtering happens. */
export const USER_AGENT = USER_AGENT_OVERRIDE || `testgen/${pkgVersion}`;

/**
 * Pure: standard NO_PROXY semantics. Comma-separated hosts; a leading dot or a bare suffix
 * matches subdomains; `*` disables proxying entirely; a `host:port` entry must match the
 * port too.
 *
 * The port form is the one that matters here: a self-hosted model endpoint is exactly the
 * thing that must bypass the proxy fronting external traffic, and NO_PROXY=localhost:11434
 * — the obvious way to write it — matches nothing without this.
 */
export function bypassesProxy(host: string, noProxy: string = NO_PROXY, port?: string): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    // A bare "*" disables proxying. Checked before the wildcard prefix is stripped, or it
    // reduces to an empty entry and is silently ignored.
    if (trimmed === "*") return true;
    let entry = trimmed.replace(/^\*/, "");
    if (!entry) continue;
    const m = /^(.*):(\d+)$/.exec(entry);
    if (m) {
      if (port === undefined || m[2] !== port) continue;
      entry = m[1] ?? "";
      if (!entry) continue;
    }
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    if (h === entry || h.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Pure: hide credentials in a proxy URL, leaving everything else byte-for-byte intact.
 *
 * Round-tripping through `new URL()` would normalise the value — notably dropping a default
 * port, so `http://host:80` prints as `http://host/`, which reads as "my port vanished" and
 * sends people hunting a bug in their own settings.
 */
export function redactProxy(p: string): string {
  return p.replace(/\/\/([^/@]+)@/, (_m, creds: string) => {
    const [user] = creds.split(":");
    return `//${user ? `${user}:***` : "***"}@`;
  });
}

export function proxySummary(): string {
  const parts: string[] = [];
  if (HTTPS_PROXY) parts.push(`HTTPS_PROXY=${redactProxy(HTTPS_PROXY)}`);
  if (HTTP_PROXY) parts.push(`HTTP_PROXY=${redactProxy(HTTP_PROXY)}`);
  if (NO_PROXY) parts.push(`NO_PROXY=${NO_PROXY}`);
  return parts.length ? parts.join(" | ") : "（未設定，直連）";
}

// Timeouts belong to the api runner's AbortController alone; see the note at the top.
const NO_UNDICI_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;

const CA = caBundle();

/**
 * Dispatcher for unproxied connections. Always created — with no extra CA it still exists to
 * override undici's 300s defaults. Installed globally too, so a fetch that forgets to pass a
 * dispatcher gets both the CA and the timeout fix.
 */
const directAgent: Dispatcher = new Agent({
  ...NO_UNDICI_TIMEOUTS,
  ...(CA ? { connect: { ca: CA } } : {}),
});
setGlobalDispatcher(directAgent);
if (CA) logVerbose(`額外信任的 CA：${caSummary()}`);

const cache = new Map<string, Dispatcher | undefined>();

/** The dispatcher a URL should use. Never undefined — even the direct path needs one. */
export function dispatcherFor(url: string): Dispatcher {
  let host: string;
  let port: string;
  let isHttps: boolean;
  try {
    const u = new URL(url);
    host = u.hostname;
    isHttps = u.protocol === "https:";
    port = u.port || (isHttps ? "443" : "80");
  } catch {
    return directAgent;
  }
  // Bypassing the proxy still needs the CA: an internal endpoint reached directly is exactly
  // the kind of host whose certificate the corporate root signed.
  if (bypassesProxy(host, NO_PROXY, port)) return directAgent;

  const proxy = isHttps ? HTTPS_PROXY || HTTP_PROXY : HTTP_PROXY || HTTPS_PROXY;
  if (!proxy) return directAgent;

  if (!cache.has(proxy)) {
    try {
      cache.set(
        proxy,
        new ProxyAgent({
          uri: proxy,
          ...NO_UNDICI_TIMEOUTS,
          // These ride on the CONNECT request itself, which is where a filtering proxy looks;
          // setting a User-Agent only on the tunnelled request would be too late.
          headers: { "user-agent": USER_AGENT },
          // requestTls is the tunnelled connection to the origin — the one a TLS-intercepting
          // proxy re-signs, so that is where the corporate CA is actually needed. proxyTls
          // only matters for an https:// proxy URL, rare but free to cover.
          ...(CA ? { requestTls: { ca: CA }, proxyTls: { ca: CA } } : {}),
        }),
      );
      logVerbose(`使用 proxy：${redactProxy(proxy)}`);
    } catch (e) {
      logVerbose(
        `proxy 設定無法解析（${redactProxy(proxy)}）：${e instanceof Error ? e.message : String(e)}`,
      );
      cache.set(proxy, undefined);
    }
  }
  return cache.get(proxy) ?? directAgent;
}
