export const TAU = Math.PI * 2;
export const GAME_DURATION = 45;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeAngle(angle) {
  return ((angle % TAU) + TAU) % TAU;
}

export function signedAngleDelta(from, to) {
  let delta = normalizeAngle(to) - normalizeAngle(from);
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
}

export function angleDistance(a, b) {
  return Math.abs(signedAngleDelta(a, b));
}

export function hashSeed(value) {
  const text = String(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function getShanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}${part("month")}${part("day")}`;
}

export function sanitizeSeed(value, fallback = getShanghaiDate()) {
  const clean = String(value ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
  const reserved = new Set(["__proto__", "constructor", "prototype"]);
  return clean && !reserved.has(clean.toLowerCase()) ? clean : fallback;
}

function hazardSettings(time) {
  if (time < 10) return { gap: 2.45, warning: 1.05, width: 0.42, duration: 1.8 };
  if (time < 22) return { gap: 2.05, warning: 0.95, width: 0.47, duration: 2.0 };
  if (time < 34) return { gap: 1.7, warning: 0.86, width: 0.52, duration: 2.15 };
  return { gap: 1.42, warning: 0.78, width: 0.57, duration: 2.25 };
}

const HAZARD_LABELS = ["临时加会", "再改一下", "老板在吗", "需求变了", "五分钟同步"];

export function buildSchedule(seed, duration = GAME_DURATION) {
  const random = mulberry32(hashSeed(seed));
  const hazards = [];
  const pickups = [];
  let time = 1.35;
  let index = 0;

  while (time < duration - 0.45) {
    const settings = hazardSettings(time);
    const jitter = 0.84 + random() * 0.32;
    let angle = random() * TAU;
    const width = settings.width * (0.88 + random() * 0.24);
    const recent = hazards.at(-1);

    if (
      recent &&
      time - recent.at < 1.8 &&
      angleDistance(angle, recent.angle) < (width + recent.width) / 2 + 0.3
    ) {
      angle = normalizeAngle(angle + 1.35 + random() * 2.1);
    }

    hazards.push({
      id: `h${index}`,
      at: Number(time.toFixed(3)),
      angle,
      width,
      warning: settings.warning,
      duration: settings.duration * (0.9 + random() * 0.2),
      label: HAZARD_LABELS[Math.floor(random() * HAZARD_LABELS.length)],
    });

    time += settings.gap * jitter;
    index += 1;
  }

  time = 2.4;
  index = 0;
  while (time < duration - 1) {
    pickups.push({
      id: `p${index}`,
      at: Number(time.toFixed(3)),
      angle: random() * TAU,
      duration: 5.2,
      type: index > 0 && index % 7 === 0 ? "shield" : "coin",
    });
    time += 2.55 + random() * 1.25;
    index += 1;
  }

  return { hazards, pickups };
}

export function speedAt(elapsed) {
  if (elapsed < 10) return 1.38;
  if (elapsed < 22) return 1.52;
  if (elapsed < 34) return 1.67;
  return 1.82;
}

export function angularTravel(fromElapsed, toElapsed) {
  if (toElapsed < fromElapsed) return -angularTravel(toElapsed, fromElapsed);
  const start = clamp(fromElapsed, 0, GAME_DURATION);
  const end = clamp(toElapsed, 0, GAME_DURATION);
  if (end <= start) return 0;

  const boundaries = [start, 10, 22, 34, end]
    .filter((value) => value >= start && value <= end)
    .sort((a, b) => a - b);
  const points = [...new Set(boundaries)];
  let distance = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentStart = points[index];
    const segmentEnd = points[index + 1];
    distance += (segmentEnd - segmentStart) * speedAt((segmentStart + segmentEnd) / 2);
  }
  return distance;
}

function replayChecksum(bytes) {
  return bytes.reduce((checksum, byte, index) => (checksum ^ ((byte + index * 17) & 0xff)), 0xa7);
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid replay characters");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeReplay({ flips = [], elapsed = 0, won = false } = {}) {
  const safeElapsed = clamp(Number(elapsed) || 0, 0, GAME_DURATION);
  const quantizedElapsed = Math.round(safeElapsed * 100);
  const safeFlips = [];
  for (const value of Array.isArray(flips) ? flips : []) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    const time = Math.round(clamp(numeric, 0, safeElapsed) * 100);
    if (time > 0 && (!safeFlips.length || time > safeFlips.at(-1))) safeFlips.push(time);
    if (safeFlips.length === 255) break;
  }
  const bytes = new Uint8Array(2 + safeFlips.length * 2 + 2 + 1 + 1);
  bytes[0] = 1;
  bytes[1] = safeFlips.length;
  safeFlips.forEach((time, index) => {
    bytes[2 + index * 2] = time >> 8;
    bytes[3 + index * 2] = time & 0xff;
  });
  const elapsedOffset = 2 + safeFlips.length * 2;
  bytes[elapsedOffset] = quantizedElapsed >> 8;
  bytes[elapsedOffset + 1] = quantizedElapsed & 0xff;
  bytes[elapsedOffset + 2] = won && quantizedElapsed === GAME_DURATION * 100 ? 1 : 0;
  bytes[elapsedOffset + 3] = replayChecksum([...bytes.slice(0, -1)]);
  return toBase64Url(bytes);
}

export function decodeReplay(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 700) return null;
  try {
    const bytes = fromBase64Url(value);
    if (bytes[0] !== 1) return null;
    const count = bytes[1];
    const expectedLength = 2 + count * 2 + 2 + 1 + 1;
    if (bytes.length !== expectedLength) return null;
    if (bytes.at(-1) !== replayChecksum([...bytes.slice(0, -1)])) return null;

    const flips = [];
    for (let index = 0; index < count; index += 1) {
      const offset = 2 + index * 2;
      const time = ((bytes[offset] << 8) | bytes[offset + 1]) / 100;
      if (time <= 0 || time > GAME_DURATION || (flips.length && time <= flips.at(-1))) return null;
      flips.push(time);
    }
    const elapsedOffset = 2 + count * 2;
    const elapsed = ((bytes[elapsedOffset] << 8) | bytes[elapsedOffset + 1]) / 100;
    if (elapsed < 0 || elapsed > GAME_DURATION || flips.some((time) => time > elapsed)) return null;
    const flags = bytes[elapsedOffset + 2];
    if (flags > 1) return null;
    const won = flags === 1;
    if (won && elapsed !== GAME_DURATION) return null;
    return { flips, elapsed, won };
  } catch {
    return null;
  }
}

export function clockText(elapsed) {
  const start = 17 * 3600 + 59 * 60 + 15;
  const total = start + Math.floor(clamp(elapsed, 0, GAME_DURATION));
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

export function getResultProfile({ elapsed, won, score, nearMisses = 0 }) {
  if (won) {
    return {
      title: "准点传说",
      emoji: "⚡",
      line: "六点的风，只有你追得上。",
      index: 99,
    };
  }
  if (elapsed >= 38) {
    return {
      title: "下班边缘人",
      emoji: "🏃",
      line: "差一点，就把工位甩在身后了。",
      index: 88,
    };
  }
  if (elapsed >= 28) {
    return {
      title: "会议闪避大师",
      emoji: "🥷",
      line: `躲过 ${nearMisses} 次致命加会，身法很野。`,
      index: 76,
    };
  }
  if (elapsed >= 16) {
    return {
      title: "带薪游泳选手",
      emoji: "🐟",
      line: "看似在工位，灵魂已经到家。",
      index: 61,
    };
  }
  if (elapsed >= 7) {
    return {
      title: "工位萌新",
      emoji: "🌱",
      line: "会躲了，但还没完全会。",
      index: 42,
    };
  }
  return {
    title: "试用期脆皮",
    emoji: "🫠",
    line: score > 0 ? "老板只问了一句，你就交代了。" : "出门太急，工牌落在了起点。",
    index: 18,
  };
}

export function scoreForPickup(combo, type) {
  if (type === "shield") return 180;
  return 160 + Math.min(combo, 8) * 24;
}
