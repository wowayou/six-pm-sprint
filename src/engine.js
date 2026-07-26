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
