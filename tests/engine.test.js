import test from "node:test";
import assert from "node:assert/strict";

import {
  GAME_DURATION,
  PHASES,
  PHASE_BOUNDARIES,
  TAU,
  angleDistance,
  angularTravel,
  buildSchedule,
  clockText,
  decodeReplay,
  encodeReplay,
  getDailySeed,
  getResultProfile,
  hashSeed,
  normalizeAngle,
  normalizeDailyRecords,
  pruneDailyRecords,
  sanitizeSeed,
  speedAt,
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

// A replay stores only flip times, so the ghost's position is reconstructed by
// integrating the speed ramp. If the phase table and the integrator ever
// disagree the desync is silent — every shared ghost drifts and nothing throws.
test("the movement integrator matches the difficulty phase table", () => {
  assert.deepEqual(
    PHASE_BOUNDARIES,
    PHASES.slice(0, -1).map((phase) => phase.until)
  );
  assert.equal(PHASES.at(-1).until, Infinity);
  for (let index = 1; index < PHASES.length; index += 1) {
    assert.ok(PHASES[index - 1].until < PHASES[index].until, "phases must be ordered");
  }

  // Independent piecewise integration of the same table.
  const expected = (from, to) => {
    let total = 0;
    let cursor = from;
    for (const phase of PHASES) {
      const end = Math.min(to, phase.until);
      if (end > cursor) {
        total += (end - cursor) * phase.speed;
        cursor = end;
      }
      if (cursor >= to) break;
    }
    return total;
  };

  for (let from = 0; from <= GAME_DURATION; from += 0.5) {
    for (let to = from; to <= GAME_DURATION; to += 0.5) {
      assert.ok(
        Math.abs(angularTravel(from, to) - expected(from, to)) < 1e-9,
        `travel mismatch across ${from}s -> ${to}s`
      );
    }
  }

  for (const boundary of PHASE_BOUNDARIES) {
    assert.notEqual(speedAt(boundary - 0.001), speedAt(boundary), "phases must change speed");
  }
});

// The reachability proof in scripts/audit-fairness.mjs is the real guarantee but
// costs ~0.5s per map. This is the cheap structural stand-in: whatever the
// tuning, some contiguous stretch of track must stay wide enough to stand in.
test("every map always leaves a standable stretch of track open", () => {
  const PLAYER_ANGLE_RADIUS = 0.065;
  const REQUIRED = 1.0; // rad; the player occupies 0.13, observed worst case is ~2.04

  let worst = Infinity;
  for (let index = 0; index < 60; index += 1) {
    const { hazards } = buildSchedule(`fairness-${index}`);
    for (let time = 0; time < GAME_DURATION; time += 0.05) {
      const spans = [];
      for (const hazard of hazards) {
        const from = hazard.at + hazard.warning;
        if (time < from || time > from + hazard.duration) continue;
        const half = hazard.width / 2 + PLAYER_ANGLE_RADIUS;
        const start = normalizeAngle(hazard.angle - half);
        spans.push({ start, end: start + half * 2 });
      }
      if (!spans.length) continue;

      spans.sort((a, b) => a.start - b.start);
      const merged = [];
      for (const span of spans) {
        const last = merged.at(-1);
        if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
        else merged.push({ ...span });
      }
      if (merged.length > 1 && merged.at(-1).end - TAU >= merged[0].start) {
        merged[0].start = merged.at(-1).start - TAU;
        merged.pop();
      }

      let widest = 0;
      if (merged.length === 1) {
        widest = TAU - (merged[0].end - merged[0].start);
      } else {
        for (let i = 0; i < merged.length; i += 1) {
          const next = merged[(i + 1) % merged.length];
          const gap = (i + 1 === merged.length ? next.start + TAU : next.start) - merged[i].end;
          if (gap > widest) widest = gap;
        }
      }
      worst = Math.min(worst, widest);
    }
  }

  assert.ok(worst >= REQUIRED, `widest free gap shrank to ${worst.toFixed(3)} rad`);
});

test("daily seeds step whole days in Shanghai time", () => {
  // Shanghai is UTC+8, so 16:30Z has already rolled over to the next day there
  // while 15:30Z has not.
  assert.equal(getDailySeed(0, new Date("2026-08-01T15:30:00Z")), "20260801");
  const rolled = new Date("2026-08-01T16:30:00Z");
  assert.equal(getDailySeed(0, rolled), "20260802");
  assert.equal(getDailySeed(-1, rolled), "20260801");

  // Month and year rollovers must not produce malformed seeds.
  assert.equal(getDailySeed(-1, new Date("2026-03-01T04:00:00Z")), "20260228");
  assert.equal(getDailySeed(-1, new Date("2026-01-01T04:00:00Z")), "20251231");
  for (let offset = -40; offset <= 0; offset += 1) {
    assert.match(getDailySeed(offset, rolled), /^\d{8}$/);
  }
});

test("per-map records upgrade from the legacy bare-number format", () => {
  const records = normalizeDailyRecords({
    "20260801": 1200,
    "20260802": { score: 900, seen: 42 },
    broken: "nonsense",
    negative: -5,
  });
  assert.deepEqual(records["20260801"], { score: 1200, seen: 0 });
  assert.deepEqual(records["20260802"], { score: 900, seen: 42 });
  assert.ok(!("broken" in records));
  assert.ok(!("negative" in records));
  assert.equal(Object.getPrototypeOf(records), null, "must resist prototype pollution");
});

// Practice seeds start with a letter, so the old "keep the lexicographically
// last N" pruning evicted every YYYYMMDD record before touching a practice one.
test("pruning keeps the most recently played maps, not the highest seed names", () => {
  const daily = normalizeDailyRecords({
    "20260801": { score: 10, seen: 5000 },
    "20260802": { score: 20, seen: 6000 },
    zpractice1: { score: 30, seen: 1000 },
    zpractice2: { score: 40, seen: 2000 },
  });
  pruneDailyRecords(daily, 2);
  assert.deepEqual(Object.keys(daily).sort(), ["20260801", "20260802"]);

  const untouched = normalizeDailyRecords({ a: 1, b: 2 });
  pruneDailyRecords(untouched, 5);
  assert.equal(Object.keys(untouched).length, 2, "no pruning below the limit");
});
