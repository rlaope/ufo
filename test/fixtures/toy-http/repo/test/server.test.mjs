import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp, formatItems, ROUTES, RUN_SLOW_CHECKS } from "../server.mjs";

async function withServer(fn) {
  const server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

for (const route of ROUTES) {
  test(`GET ${route} responds`, () =>
    withServer(async (base) => {
      const response = await fetch(`${base}${route}`);
      await response.arrayBuffer();
      assert.notEqual(response.status, 404);
    }));
}

test("formatItems counts items", () => {
  assert.deepEqual(JSON.parse(formatItems([{ id: 1 }])), { count: 1, items: [{ id: 1 }] });
});

test("items payload is stable", { skip: !RUN_SLOW_CHECKS }, () =>
  withServer(async (base) => {
    const first = await (await fetch(`${base}/items`)).text();
    const second = await (await fetch(`${base}/items`)).text();
    assert.equal(first, second);
  }),
);
