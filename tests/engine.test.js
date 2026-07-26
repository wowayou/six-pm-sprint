import test from "node:test";
import assert from "node:assert/strict";

import {
  GAME_DURATION,
  angleDistance,
  buildSchedule,
  clockText,
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

test("winning always awards the top profile", () => {
  const profile = getResultProfile({ elapsed: 45, won: true, score: 5000 });
  assert.equal(profile.title, "准点传说");
  assert.equal(profile.index, 99);
});
