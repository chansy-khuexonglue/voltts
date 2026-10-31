import { Volt } from "../../packages/volt/src/index";
import { Elysia } from "elysia";
import { Hono } from "hono";
import Fastify from "fastify";
import express from "express";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.PORT || 4300);
const framework = process.env.FRAMEWORK || "volt";
const textFixtures: Record<string, string> = {
  ascii: "Hello world! The quick brown fox jumps over the lazy dog. ",
  unicode: "ສະບາຍດີ สวัสดี 你好 こんにちは 안녕하세요 مرحبا 🚀 ",
  json: JSON.stringify({ message: "Hello ສະບາຍດີ 🚀", items: Array.from({ length: 12 }, (_, i) => ({ id: i, name: "Product " + i })) }),
  binary: "0123456789abcdef",
};
const sizes = [1024, 16384, 65536, 1048576];
const payloads = new Map<string, Uint8Array>();
for (const [kind, seed] of Object.entries(textFixtures)) {
  for (const size of sizes) {
    const unit = new TextEncoder().encode(seed);
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = unit[i % unit.length]!;
    payloads.set(kind + ":" + size, out);
  }
}
function response(kind: string, size: number, encoding: string): Response {
  const data = payloads.get(kind + ":" + size);
  if (!data) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = {
    "content-type": kind === "binary" ? "application/octet-stream" : kind === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "vary": "Accept-Encoding",
  };
  let body = data;
  if (encoding === "gzip") {
    body = gzipSync(data, { level: 6 });
    headers["content-encoding"] = "gzip";
  } else if (encoding === "br") {
    body = brotliCompressSync(data);
    headers["content-encoding"] = "br";
  }
  return new Response(body, { headers });
}
function resolve(url: string) {
  const u = new URL(url);
  const parts = u.pathname.split("/");
  const kind = parts[2] || "";
  const size = Number(parts[3]);
  const encoding = parts[4] || "identity";
  if (!(kind in textFixtures) || !sizes.includes(size) || !["identity", "gzip", "br"].includes(encoding)) return null;
  return { kind, size, encoding };
}
function serveResponse(req: Request): Response {
  const p = resolve(req.url);
  if (!p) return new Response("Not found", { status: 404 });
  return response(p.kind, p.size, p.encoding);
}
let stop: () => Promise<void> | void;
switch (framework) {
  case "volt": {
    const app = new Volt({ port });
    app.get("/bench/:kind/:size/:encoding", c => response(c.params.kind, Number(c.params.size), c.params.encoding));
    const server = app.listen(port);
    stop = () => server.stop(true);
    break;
  }
  case "elysia": {
    const app = new Elysia().get("/bench/:kind/:size/:encoding", ({ params }) => response(params.kind, Number(params.size), params.encoding));
    app.listen(port);
    stop = () => app.stop();
    break;
  }
  case "hono": {
    const app = new Hono();
    app.get("/bench/:kind/:size/:encoding", c => response(c.req.param("kind"), Number(c.req.param("size")), c.req.param("encoding")));
    const server = Bun.serve({ port, fetch: app.fetch });
    stop = () => server.stop(true);
    break;
  }
  case "fastify": {
    const app = Fastify({ logger: false });
    app.get("/bench/:kind/:size/:encoding", async (req, reply) => {
      const p = req.params as Record<string, string>;
      const r = response(p.kind, Number(p.size), p.encoding);
      reply.code(r.status);
      r.headers.forEach((v, k) => reply.header(k, v));
      return Buffer.from(await r.arrayBuffer());
    });
    await app.listen({ port, host: "127.0.0.1" });
    stop = () => app.close();
    break;
  }
  case "express": {
    const app = express();
    app.get("/bench/:kind/:size/:encoding", (req, res) => {
      const r = response(req.params.kind, Number(req.params.size), req.params.encoding);
      res.status(r.status);
      r.headers.forEach((v, k) => res.setHeader(k, v));
      r.arrayBuffer().then(bytes => res.end(Buffer.from(bytes)));
    });
    const server = app.listen(port, "127.0.0.1");
    stop = () => new Promise<void>((done, reject) => server.close(err => err ? reject(err) : done()));
    break;
  }
  case "native-bun": {
    const server = Bun.serve({ port, fetch: serveResponse });
    stop = () => server.stop(true);
    break;
  }
  default: throw new Error("Unknown framework: " + framework);
}
console.log("READY " + framework + " " + port);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { Promise.resolve(stop()).finally(() => process.exit(0)); });
