import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SCOPE = "https://example.com/six-pm-sprint/";
const SW_URL = `${SCOPE}sw.js`;
const SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

class FakeResponse {
  constructor(tag, ok = true) {
    this.tag = tag;
    this.ok = ok;
  }
  clone() {
    return new FakeResponse(this.tag, this.ok);
  }
}

class FakeRequest {
  constructor(input, init = {}) {
    if (input instanceof FakeRequest) {
      this.url = input.url;
      this.method = init.method ?? input.method;
      this.mode = init.mode ?? input.mode;
      this.cache = init.cache ?? input.cache;
    } else {
      this.url = new URL(input, SW_URL).href;
      this.method = init.method ?? "GET";
      this.mode = init.mode ?? "cors";
      this.cache = init.cache;
    }
  }
}

// Boots sw.js against a stub ServiceWorkerGlobalScope and returns handles for
// driving fetch events and inspecting what hit the network vs the cache.
function bootServiceWorker({ offline = false, cached = {} } = {}) {
  const listeners = {};
  const store = new Map();
  const log = { network: [], puts: [] };

  const keyOf = (req) => (typeof req === "string" ? new URL(req, SW_URL).href : req.url);
  for (const [path, tag] of Object.entries(cached)) {
    store.set(new URL(path, SW_URL).href, new FakeResponse(tag));
  }

  const cacheApi = {
    async match(request) {
      return store.get(keyOf(request))?.clone();
    },
    async put(request, response) {
      log.puts.push(keyOf(request));
      store.set(keyOf(request), response);
    },
    async addAll(paths) {
      for (const path of paths) store.set(keyOf(path), new FakeResponse(`precached:${path}`));
    },
  };

  const context = {
    URL,
    Request: FakeRequest,
    Response: FakeResponse,
    caches: {
      open: async () => cacheApi,
      keys: async () => [],
      delete: async () => true,
    },
    async fetch(request, init) {
      log.network.push({ url: keyOf(request), cache: init?.cache ?? request?.cache });
      if (offline) throw new TypeError("Failed to fetch");
      return new FakeResponse(`network:${keyOf(request)}`);
    },
    self: {
      location: { href: SW_URL, origin: "https://example.com" },
      addEventListener: (type, handler) => (listeners[type] = handler),
      skipWaiting: () => {},
      clients: { claim: () => {} },
    },
  };
  context.self.caches = context.caches;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: "sw.js" });

  return {
    log,
    store,
    // Returns the promise passed to respondWith, or null when the worker
    // declined to handle the request and let it fall through to the network.
    dispatch(request) {
      let responded = null;
      listeners.fetch({ request, respondWith: (value) => (responded = value), waitUntil: () => {} });
      return responded;
    },
    install() {
      let pending = Promise.resolve();
      listeners.install({ waitUntil: (value) => (pending = value) });
      return pending;
    },
  };
}

const get = (path, init) => new FakeRequest(path, init);
const navigate = (path) => new FakeRequest(path, { mode: "navigate" });

test("shell assets are served from the network, not a stale cache", async () => {
  const sw = bootServiceWorker({ cached: { "./src/game.js": "STALE" } });
  const response = await sw.dispatch(get("./src/game.js"));
  assert.match(response.tag, /^network:/, "a cached copy must never win for shell code");
  assert.equal(sw.log.network.length, 1);
  assert.ok(sw.store.get(new URL("./src/game.js", SW_URL).href).tag.startsWith("network:"));
});

test("shell assets revalidate past the CDN's max-age", async () => {
  const sw = bootServiceWorker();
  await sw.dispatch(get("./styles.css"));
  assert.equal(sw.log.network[0].cache, "no-cache", "must bypass the 600s HTTP cache");
});

test("shell assets fall back to the cache when the network is gone", async () => {
  const sw = bootServiceWorker({ offline: true, cached: { "./src/game.js": "OFFLINE_COPY" } });
  const response = await sw.dispatch(get("./src/game.js"));
  assert.equal(response.tag, "OFFLINE_COPY");
});

test("a shell miss while offline rejects rather than resolving to nothing", async () => {
  const sw = bootServiceWorker({ offline: true });
  await assert.rejects(sw.dispatch(get("./src/game.js")), /Failed to fetch/);
});

test("navigations are network-first and share the shell HTML cache entry", async () => {
  const sw = bootServiceWorker();
  const response = await sw.dispatch(navigate("./?seed=20260731&ghost=AQQAeAFUA3oF8AjKALE"));
  assert.match(response.tag, /^network:/);
  // The query string must not create a second, unreachable cache entry.
  assert.deepEqual(sw.log.puts, [new URL("./index.html", SW_URL).href]);
  // Navigations must not be rebuilt: doing so downgrades their request mode.
  assert.equal(sw.log.network[0].cache, undefined);
});

test("an offline navigation with any query string still returns the shell", async () => {
  const sw = bootServiceWorker({ offline: true, cached: { "./index.html": "SHELL" } });
  const response = await sw.dispatch(navigate("./?seed=probe7"));
  assert.equal(response.tag, "SHELL");
});

test("icons are served from the cache without touching the network", async () => {
  const sw = bootServiceWorker({ cached: { "./assets/icon-192.png": "ICON" } });
  const response = await sw.dispatch(get("./assets/icon-192.png"));
  assert.equal(response.tag, "ICON");
  assert.equal(sw.log.network.length, 0);
});

test("uncached non-shell assets are fetched and then cached", async () => {
  const sw = bootServiceWorker();
  const response = await sw.dispatch(get("./assets/social-card.png"));
  assert.match(response.tag, /^network:/);
  assert.equal(sw.log.puts.length, 1);
});

test("non-GET and cross-origin requests are left alone", async () => {
  const sw = bootServiceWorker();
  assert.equal(sw.dispatch(get("./src/game.js", { method: "POST" })), null);
  assert.equal(sw.dispatch(get("https://cdn.example.org/thing.js")), null);
  assert.equal(sw.log.network.length, 0);
});

// This is the regression guard for the failure that motivated network-first:
// game.js resolves #mapPicker and friends at module scope, so pairing new JS
// with an old cached index.html throws a TypeError and the stage never boots.
// Any asset the shell HTML pulls in must therefore update in lockstep with it.
test("every asset index.html loads is pinned to the shell strategy", async () => {
  const referenced = [
    ...HTML.matchAll(/<script[^>]+src="([^"]+)"/g),
    ...HTML.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g),
  ].map((match) => match[1]);

  assert.ok(referenced.length >= 2, "expected to find the game script and stylesheet");

  for (const path of referenced) {
    const sw = bootServiceWorker({ cached: { [`./${path}`]: "STALE" } });
    const response = await sw.dispatch(get(`./${path}`));
    assert.match(
      response.tag,
      /^network:/,
      `${path} is loaded by index.html but is not in the service worker's SHELL list, so it could be served stale against fresh HTML`
    );
  }
});

test("the precache covers the whole shell so a first offline load works", async () => {
  const sw = bootServiceWorker();
  await sw.install();
  for (const path of ["./", "./index.html", "./styles.css", "./src/engine.js", "./src/game.js"]) {
    assert.ok(sw.store.has(new URL(path, SW_URL).href), `${path} must be precached`);
  }
});
