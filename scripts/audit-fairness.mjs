#!/usr/bin/env node
/**
 * Proves that every generated map is actually survivable.
 *
 * The player's angular speed is fixed and the only input is a direction flip,
 * so the full set of survivable trajectories can be enumerated: propagate the
 * reachable (angle, direction) set forward one tick at a time and drop states
 * that intersect a live hazard. If the set ever empties, no sequence of taps
 * could have saved the player and the map is unfair.
 *
 * The discretisation is deliberately conservative: hazards are inflated by one
 * bin, so a bin surviving the sweep is genuinely safe rather than an artefact
 * of rounding. That makes a "winnable" verdict trustworthy.
 *
 *   node scripts/audit-fairness.mjs [seedCount] [dayCount]
 */

import { GAME_DURATION, TAU, buildSchedule, getShanghaiDate, speedAt } from "../src/engine.js";

const PLAYER_ANGLE_RADIUS = 0.065;
const BINS = 2048;
const BIN = TAU / BINS;
const DT = 0.01;

const wrap = (bin) => ((bin % BINS) + BINS) % BINS;

function survivalLimit(seed) {
  const { hazards } = buildSchedule(seed);
  // Bit 0 of each state holds the direction, the rest the angle bin.
  let reachable = new Set([wrap(Math.round(-Math.PI / 2 / BIN)) * 2 + 1]);
  const live = [];

  for (let time = 0; time < GAME_DURATION; time += DT) {
    live.length = 0;
    for (const hazard of hazards) {
      const from = hazard.at + hazard.warning;
      if (time >= from && time <= from + hazard.duration) live.push(hazard);
    }

    const step = Math.round((speedAt(time) * DT) / BIN);
    const next = new Set();
    for (const state of reachable) {
      const bin = state >> 1;
      const heading = state & 1 ? 1 : -1;
      for (const direction of [heading, -heading]) {
        const moved = wrap(bin + direction * step);
        const angle = moved * BIN;
        let blocked = false;
        for (const hazard of live) {
          let delta = Math.abs(angle - hazard.angle) % TAU;
          if (delta > Math.PI) delta = TAU - delta;
          // + BIN keeps quantisation error on the safe side.
          if (delta <= hazard.width / 2 + PLAYER_ANGLE_RADIUS + BIN) {
            blocked = true;
            break;
          }
        }
        if (!blocked) next.add(moved * 2 + (direction > 0 ? 1 : 0));
      }
    }

    reachable = next;
    if (reachable.size === 0) return time;
  }
  return Infinity;
}

function upcomingDays(count) {
  const today = getShanghaiDate();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(4, 6));
  const day = Number(today.slice(6, 8));
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ].join("");
  });
}

const seedCount = Number(process.argv[2] || 120);
const dayCount = Number(process.argv[3] || 60);
const seeds = [
  ...upcomingDays(dayCount),
  ...Array.from({ length: seedCount }, (_, index) => `audit-${index}`),
];

const unfair = [];
for (const seed of seeds) {
  const limit = survivalLimit(seed);
  if (limit !== Infinity) unfair.push({ seed, diedAt: Number(limit.toFixed(2)) });
}

console.log(`checked ${seeds.length} maps (${dayCount} upcoming days + ${seedCount} synthetic seeds)`);
if (unfair.length === 0) {
  console.log("every map is survivable");
  process.exit(0);
}
console.error(`UNWINNABLE MAPS: ${unfair.length}`);
for (const { seed, diedAt } of unfair.slice(0, 20)) {
  console.error(`  ${seed} — every trajectory dead by ${diedAt}s`);
}
process.exit(1);
