import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, platform, arch } from "node:os";
const frameworks = ["volt", "elysia", "hono", "fastify", "express", "native-bun"];
const kinds = ["ascii", "unicode", "json", "binary"];
const sizes = [1024, 16384, 65536, 1048576];
const encodings = ["identity", "gzip", "br"];
const port = 4300;
const concurrency = 20;
const durationMs = 1200;
const results: any[] = [];
const encoder = new TextEncoder();
async function waitReady(child: ReturnType<typeof Bun.spawn>) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Server exited early");
    try { const r = await fetch("http://127.0.0.1:" + port + "/bench/ascii/1024/identity"); if (r.ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server startup timeout");
}
async function measure(url: string) {
  let ok = 0, errors = 0, bytes = 0;
  const latencies: number[] = [];
  const start = performance.now();
  const until = start + durationMs;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < until) {
      const t = performance.now();
      try {
        const r = await fetch(url, { headers: { "accept-encoding": "identity" } });
        const body = new Uint8Array(await r.arrayBuffer());
        if (r.status !== 200) throw new Error("HTTP " + r.status);
        bytes += body.byteLength;
        ok++;
        latencies.push(performance.now() - t);
      } catch { errors++; }
    }
  }));
  const elapsed = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)] : null;
  return { rps: +(ok / elapsed).toFixed(1), p50Ms: pct(.5), p95Ms: pct(.95), p99Ms: pct(.99), errors, requests: ok, throughputMBps: +(bytes / elapsed / 1048576).toFixed(2) };
}
async function verify(url: string, kind: string, size: number, encoding: string) {
  const r = await fetch(url, { headers: { "accept-encoding": "identity" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const contentEncoding = r.headers.get("content-encoding");
  if ((encoding === "identity" && contentEncoding) || (encoding !== "identity" && contentEncoding !== encoding)) throw new Error("Wrong content encoding: " + contentEncoding);
  // Fetch automatically decompresses gzip/br; compare decoded bytes.
  const body = new Uint8Array(await r.arrayBuffer());
  if (body.length !== size) throw new Error("Decoded payload size mismatch: " + body.length);
  return true;
}
for (const framework of frameworks) {
  const child = Bun.spawn(["bun", "run", "benchmarks/comparison/server.ts"], { env: { ...process.env, FRAMEWORK: framework, PORT: String(port) }, stdout: "inherit", stderr: "inherit" });
  try {
    await waitReady(child);
    for (const kind of kinds) for (const size of sizes) for (const encoding of encodings) {
      const url = `http://127.0.0.1:${port}/bench/${kind}/${size}/${encoding}`;
      try {
        await verify(url, kind, size, encoding);
        const metrics = await measure(url);
        results.push({ framework, kind, size, encoding, ...metrics, valid: true });
        console.log(framework, kind, size, encoding, metrics.rps, "RPS", metrics.errors, "errors");
      } catch (e) {
        results.push({ framework, kind, size, encoding, valid: false, error: String(e) });
        console.error("FAIL", framework, kind, size, encoding, e);
      }
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(3000)]);
  }
}
mkdirSync("benchmarks/reports", { recursive: true });
const metadata = { timestamp: new Date().toISOString(), runtime: Bun.version, platform: platform(), arch: arch(), cpus: cpus().length, totalMemory: totalmem(), concurrency, durationMs };
writeFileSync("benchmarks/reports/comparison.json", JSON.stringify({ metadata, results }, null, 2));
const cols = ["framework", "kind", "size", "encoding", "valid", "rps", "p50Ms", "p95Ms", "p99Ms", "requests", "errors", "throughputMBps", "error"];
writeFileSync("benchmarks/reports/comparison.csv", [cols.join(","), ...results.map(r => cols.map(k => JSON.stringify(r[k] ?? "")).join(","))].join("\n"));
const escape = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]!));
const rows = results.map(r => "<tr>" + cols.map(k => "<td>" + escape(r[k]) + "</td>").join("") + "</tr>").join("");
writeFileSync("benchmarks/reports/comparison.html", `<!doctype html><meta charset="utf-8"><title>VoltTS Framework Comparison</title><style>body{font:14px system-ui;margin:2rem;background:#101827;color:#e7eef9}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #45536b}th{background:#24344e}tr:nth-child(even){background:#1b293c}</style><h1>VoltTS Cross-Framework Benchmark</h1><p>${escape(JSON.stringify(metadata))}</p><table><thead><tr>${cols.map(k => "<th>" + escape(k) + "</th>").join("")}</tr></thead><tbody>${rows}</tbody></table>`);
console.log("Wrote JSON, CSV, HTML reports; valid:", results.filter(r => r.valid).length, "/", results.length);
if (results.some(r => !r.valid || r.errors > 0)) process.exitCode = 1;
