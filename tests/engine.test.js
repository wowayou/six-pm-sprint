import test from "node:test";
import assert from "node:assert/strict";

import {
  GAME_DURATION,
  angleDistance,
  angularTravel,
  buildSchedule,
  clockText,
  decodeReplay,
  encodeReplay,
  getResultProfile,
  hashSeed,
  normalizeAngle,
  sanitizeSeed,
} from "../src/engine.js";

test("angles normalize and wrap across zero", () => {
  assert.equal(normalizeAngle(-Math.PI), Math.PI);
  assert.ok(angleDistance(0.05, Math.PI * 2 - 0.05) < 0.101);
});

test("daily schedule is deterministic and stays inside the round", () => {
  const first = buildSchedule("20260726");
  const second = buildSchedule("20260726");
  assert.deepEqual(first, second);
  assert.ok(first.hazards.length >= 20);
  assert.ok(first.hazards.every((item) => item.at < GAME_DURATION));
  assert.ok(first.pickups.some((item) => item.type === "shield"));
});

test("different seeds create different schedules", () => {
  assert.notEqual(hashSeed("day-one"), hashSeed("day-two"));
  assert.notDeepEqual(buildSchedule("day-one"), buildSchedule("day-two"));
});

test("seed input is safe for URLs and storage", () => {
  assert.equal(sanitizeSeed("../../bad seed!?", "fallback"), "badseed");
  assert.equal(sanitizeSeed("", "fallback"), "fallback");
  assert.equal(sanitizeSeed("__proto__", "fallback"), "fallback");
});

test("clock reaches 18:00 after the full round", () => {
  assert.equal(clockText(0), "17:59:15");
  assert.equal(clockText(45), "18:00:00");
});

test("angular travel is deterministic across frame boundaries", () => {
  const whole = angularTravel(0, GAME_DURATION);
  const segmented = angularTravel(0, 7.3) + angularTravel(7.3, 18.8) + angularTravel(18.8, 36.1) + angularTravel(36.1, 45);
  assert.ok(Math.abs(whole - 72.1) < 0.000001);
  assert.ok(Math.abs(whole - segmented) < 0.000001);
  assert.equal(angularTravel(12, 8), -angularTravel(8, 12));
});

test("replays round-trip into compact URL-safe data", () => {
  const encoded = encodeReplay({ flips: [0.42, 3.17, 9.999, 22.45], elapsed: 31.237, won: false });
  assert.match(encoded, /^[a-zA-Z0-9_-]+$/);
  assert.ok(encoded.length < 40);
  assert.deepEqual(decodeReplay(encoded), {
    flips: [0.42, 3.17, 10, 22.45],
    elapsed: 31.24,
    won: false,
  });
});

test("replay decoder rejects corrupted and untrusted payloads", () => {
  const encoded = encodeReplay({ flips: [1, 2], elapsed: 4, won: true });
  const middle = Math.floor(encoded.length / 2);
  const corrupted = `${encoded.slice(0, middle)}${encoded[middle] === "A" ? "B" : "A"}${encoded.slice(middle + 1)}`;
  assert.equal(decodeReplay(corrupted), null);
  assert.equal(decodeReplay("../../not-a-replay"), null);
  assert.equal(decodeReplay("A".repeat(300)), null);
});

test("replay encoder sanitizes unordered, duplicate, and out-of-range flips", () => {
  const encoded = encodeReplay({
    flips: [-2, 1.234, 1.234, 0.8, Number.NaN, 50],
    elapsed: 4.567,
    won: true,
  });
  assert.deepEqual(decodeReplay(encoded), {
    flips: [1.23, 4.57],
    elapsed: 4.57,
    won: false,
  });
});

test("replay decoder rejects unknown flag bits even with a valid checksum", () => {
  const encoded = encodeReplay({ flips: [], elapsed: 2, won: false });
  const padded = encoded
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  bytes[bytes.length - 2] = 2;
  bytes[bytes.length - 1] = [...bytes.slice(0, -1)].reduce(
    (checksum, byte, index) => checksum ^ ((byte + index * 17) & 0xff),
    0xa7
  );
  const forged = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  assert.equal(decodeReplay(forged), null);
});

test("replay format safely supports rapid players without oversized links", () => {
  const flips = Array.from({ length: 255 }, (_, index) => (index + 1) * 0.17);
  const encoded = encodeReplay({ flips, elapsed: 45, won: true });
  const decoded = decodeReplay(encoded);
  assert.equal(decoded.flips.length, 255);
  assert.equal(decoded.won, true);
  assert.ok(encoded.length <= 700);
});

test("winning always awards the top profile", () => {
  const profile = getResultProfile({ elapsed: 45, won: true, score: 5000 });
  assert.equal(profile.title, "准点传说");
  assert.equal(profile.index, 99);
});
