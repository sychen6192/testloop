// Extra CA trust, applied in-process.
//
// Node ships its own compiled-in CA list and ignores the system trust store, which is why
// curl, git and mvn can all work on a TLS-intercepting corporate network while every Node
// tool on the same machine fails. The usual answer is NODE_EXTRA_CA_CERTS, but that is read
// once at process start, so it only works if something exported it before node launched —
// it would apply to `bin/testgen` and silently do nothing for a direct `npx tsx loop.ts`.
//
// Every request the api runner makes goes through an undici dispatcher, and a dispatcher
// takes TLS options at runtime. So the CA is loaded here and handed to the dispatcher
// instead, and UT_CA_CERTS works from .env however the process was started.
import * as fs from "node:fs";
import * as tls from "node:tls";
import { CA_CERTS } from "../config";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export interface CaSource {
  path: string;
  /** Where the path came from, for diagnostics. */
  from: "UT_CA_CERTS" | "NODE_EXTRA_CA_CERTS";
  certs: number;
  error?: string;
}

/** Pure: the configured value(s) as distinct paths, order preserved, duplicates dropped. */
export function sourcePaths(
  caCerts: string = CA_CERTS,
  nodeExtra: string = process.env.NODE_EXTRA_CA_CERTS ?? "",
): Array<{ path: string; from: CaSource["from"] }> {
  const out: Array<{ path: string; from: CaSource["from"] }> = [];
  const push = (raw: string, from: CaSource["from"]) => {
    // A bundle is usually one file, but a root and its intermediate often arrive as two.
    for (const p of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!out.some((e) => e.path === p)) out.push({ path: p, from });
    }
  };
  push(caCerts, "UT_CA_CERTS");
  push(nodeExtra, "NODE_EXTRA_CA_CERTS");
  return out;
}

export function load(
  paths: Array<{ path: string; from: CaSource["from"] }> = sourcePaths(),
): { sources: CaSource[]; pems: string[] } {
  const sources: CaSource[] = [];
  const pems: string[] = [];
  for (const { path, from } of paths) {
    let text: string;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch (e) {
      sources.push({ path, from, certs: 0, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const blocks = text.match(PEM_BLOCK) ?? [];
    if (blocks.length === 0) {
      // Usually a DER/.cer export that was never converted:
      //   openssl x509 -inform der -in cert.cer -out cert.pem
      sources.push({ path, from, certs: 0, error: "找不到 PEM 憑證區塊（可能是 DER 格式）" });
      continue;
    }
    sources.push({ path, from, certs: blocks.length });
    pems.push(...blocks);
  }
  return { sources, pems };
}

const loaded = load();

/** What was configured and whether it parsed. Used by doctor. */
export const CA_SOURCES: CaSource[] = loaded.sources;

/**
 * Pure: certificates to trust, or undefined to leave the defaults alone.
 *
 * Passing `ca` to a TLS connection *replaces* the trust store rather than adding to it —
 * unlike NODE_EXTRA_CA_CERTS, which appends. Concatenating the built-in roots is what keeps
 * ordinary public HTTPS working once a corporate CA is configured.
 */
export function bundleFrom(pems: string[], roots: readonly string[] = tls.rootCertificates) {
  if (pems.length === 0) return undefined;
  return [...roots, ...pems];
}

export function caBundle(): string[] | undefined {
  return bundleFrom(loaded.pems);
}

/** One-line status for diagnostics. */
export function caSummary(sources: CaSource[] = CA_SOURCES): string {
  if (sources.length === 0) return "（未設定，使用 Node 內建 CA 清單）";
  return sources
    .map((s) => (s.error ? `${s.path}（${s.from}）讀取失敗：${s.error}` : `${s.path}（${s.from}，${s.certs} 張）`))
    .join("；");
}
