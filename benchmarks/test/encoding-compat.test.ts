import { describe, test, expect } from "bun:test";
import { Volt } from "../../packages/volt/src/index";

const cases = {
  ascii: "Hello World 123 !@#$",
  lao: "ສະບາຍດີ ປະເທດລາວ",
  thai: "สวัสดีครับ",
  chinese: "你好世界",
  japanese: "こんにちは世界",
  korean: "안녕하세요",
  arabic: "مرحبا بالعالم",
  emoji: "🚀⚡👩🏽‍💻🌍",
  mixed: "Hello ສະບາຍດີ 你好 🚀",
  combining: "e\u0301",
  zeroWidth: "a\u200Bb",
  nullCharacter: "a\u0000b",
  escaped: "<>&\\\"'\\\\\\n\\t",
} as const;

describe("Volt HTTP request/response encoding compatibility", () => {
  const app = new Volt();
  app.post("/echo/text", async (c) => new Response(await c.request.text(), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  }));
  app.post("/echo/json", async (c) => Response.json(await c.request.json()));
  app.post("/echo/binary", async (c) => new Response(await c.request.arrayBuffer(), {
    headers: { "content-type": "application/octet-stream" },
  }));
  app.get("/response/:value", (c) => Response.json({ value: c.params.value }));
  app.get("/query", (c) => Response.json({ value: new URL(c.request.url).searchParams.get("value") }));

  for (const [name, value] of Object.entries(cases)) {
    test(`text roundtrip: ${name}`, async () => {
      const response = await app.handle(new Request("http://localhost/echo/text", {
        method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: value,
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(value);
    });

    test(`JSON roundtrip: ${name}`, async () => {
      const body = { value, nested: { value }, items: [value] };
      const response = await app.handle(new Request("http://localhost/echo/json", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
    });

    test(`URL route parameter: ${name}`, async () => {
      const response = await app.handle(new Request(`http://localhost/response/${encodeURIComponent(value)}`));
      expect(response.status).toBe(200);
      expect((await response.json()).value).toBe(value);
    });

    test(`query parameter: ${name}`, async () => {
      const response = await app.handle(new Request(`http://localhost/query?value=${encodeURIComponent(value)}`));
      expect(response.status).toBe(200);
      expect((await response.json()).value).toBe(value);
    });
  }

  for (const size of [0, 128, 1024, 16384, 65536, 1048576]) {
    test(`binary roundtrip: ${size} bytes`, async () => {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256);
      const response = await app.handle(new Request("http://localhost/echo/binary", {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes,
      }));
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    });
  }
});
