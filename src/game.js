import {
  GAME_DURATION,
  TAU,
  angleDistance,
  angularTravel,
  buildSchedule,
  clamp,
  clockText,
  decodeReplay,
  encodeReplay,
  getResultProfile,
  getShanghaiDate,
  normalizeAngle,
  sanitizeSeed,
  scoreForPickup,
} from "./engine.js";

const $ = (selector) => document.querySelector(selector);

const elements = {
  canvas: $("#gameCanvas"),
  stage: $("#stageFrame"),
  overlay: $("#gameOverlay"),
  startPanel: $("#startPanel"),
  resultPanel: $("#resultPanel"),
  pausePanel: $("#pausePanel"),
  startButton: $("#startButton"),
  againButton: $("#againButton"),
  resumeButton: $("#resumeButton"),
  shareButton: $("#shareButton"),
  sideShareButton: $("#sideShareButton"),
  saveCardButton: $("#saveCardButton"),
  soundButton: $("#soundButton"),
  clockValue: $("#clockValue"),
  scoreValue: $("#scoreValue"),
  comboValue: $("#comboValue"),
  seedLabel: $("#seedLabel"),
  challengeBanner: $("#challengeBanner"),
  challengeLabel: $("#challengeLabel"),
  challengeHint: $("#challengeHint"),
  challengeTarget: $("#challengeTarget"),
  challengeResult: $("#challengeResult"),
  shieldIndicator: $("#shieldIndicator"),
  ghostIndicator: $("#ghostIndicator"),
  ghostStatus: $("#ghostStatus"),
  bestValue: $("#bestValue"),
  playsValue: $("#playsValue"),
  dailyBestValue: $("#dailyBestValue"),
  totalCoinsValue: $("#totalCoinsValue"),
  maxComboValue: $("#maxComboValue"),
  resultEyebrow: $("#resultEyebrow"),
  resultEmoji: $("#resultEmoji"),
  resultTitle: $("#resultTitle"),
  resultLine: $("#resultLine"),
  resultScore: $("#resultScore"),
  resultMeta: $("#resultMeta"),
  toast: $("#toast"),
  liveRegion: $("#liveRegion"),
};

const context = elements.canvas.getContext("2d", { alpha: false });
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const STORAGE_KEY = "six-pm-sprint:v1";
const PLAYER_ANGLE_RADIUS = 0.065;

function readStats() {
  const emptyDaily = () => Object.create(null);
  const fallback = { best: 0, plays: 0, totalCoins: 0, maxCombo: 0, daily: emptyDaily() };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return fallback;
    const safeNumber = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const daily = emptyDaily();
    if (parsed.daily && typeof parsed.daily === "object") {
      for (const [key, value] of Object.entries(parsed.daily)) {
        if (Number.isFinite(Number(value))) daily[key] = Math.max(0, Number(value));
      }
    }
    return {
      best: safeNumber(parsed.best),
      plays: safeNumber(parsed.plays),
      totalCoins: safeNumber(parsed.totalCoins),
      maxCombo: safeNumber(parsed.maxCombo),
      daily,
    };
  } catch {
    return fallback;
  }
}

function writeStats(stats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // The game still works when storage is blocked.
  }
}

function parseGameParams() {
  const params = new URLSearchParams(location.search);
  const today = getShanghaiDate();
  const seed = sanitizeSeed(params.get("seed"), today);
  const rawTarget = Number.parseInt(params.get("target") || "", 10);
  const target = Number.isFinite(rawTarget) ? clamp(rawTarget, 1, 999999) : 0;
  const replay = decodeReplay(params.get("ghost"));
  return { seed, target, replay, isDaily: seed === today };
}

class SoundEngine {
  constructor() {
    try {
      this.enabled = localStorage.getItem("six-pm-sprint:sound") !== "off";
    } catch {
      this.enabled = true;
    }
    this.audioContext = null;
  }

  ensure() {
    if (!this.enabled) return null;
    if (!this.audioContext) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) this.audioContext = new AudioContext();
    }
    if (this.audioContext?.state === "suspended") this.audioContext.resume();
    return this.audioContext;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    try {
      localStorage.setItem("six-pm-sprint:sound", enabled ? "on" : "off");
    } catch {
      // Sound toggling still works for the current session.
    }
    if (enabled) {
      this.ensure();
      this.tone(520, 0.06, "sine", 0.035);
    }
  }

  tone(frequency, duration, type = "sine", volume = 0.045, delay = 0) {
    const audio = this.ensure();
    if (!audio) return;
    const start = audio.currentTime + delay;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  reverse() {
    this.tone(430, 0.055, "square", 0.025);
    this.tone(620, 0.06, "square", 0.018, 0.035);
  }

  warn() {
    this.tone(185, 0.09, "sawtooth", 0.025);
  }

  pickup(combo = 1) {
    const base = 520 + Math.min(combo, 8) * 30;
    this.tone(base, 0.09, "sine", 0.045);
    this.tone(base * 1.5, 0.12, "sine", 0.035, 0.06);
  }

  shield() {
    this.tone(330, 0.11, "triangle", 0.04);
    this.tone(660, 0.18, "sine", 0.04, 0.07);
  }

  hit() {
    this.tone(150, 0.2, "sawtooth", 0.06);
    this.tone(82, 0.35, "square", 0.04, 0.08);
  }

  win() {
    [523, 659, 784, 1047].forEach((frequency, index) => {
      this.tone(frequency, 0.28, "triangle", 0.04, index * 0.1);
    });
  }
}

const params = parseGameParams();
const sound = new SoundEngine();
const stats = readStats();

const game = {
  mode: "menu",
  seed: params.seed,
  target: params.target,
  ghostReplay: params.replay,
  ghost: null,
  isDaily: params.isDaily,
  width: 800,
  height: 610,
  dpr: 1,
  idleTime: 0,
  elapsed: 0,
  score: 0,
  displayedScore: -1,
  playerAngle: -Math.PI / 2,
  direction: 1,
  combo: 1,
  comboUntil: 0,
  nearMisses: 0,
  coins: 0,
  maxCombo: 1,
  shield: false,
  hazards: [],
  pickups: [],
  particles: [],
  floaters: [],
  trails: [],
  ghostTrails: [],
  flipTimes: [],
  lastReverse: -1,
  lastFrame: performance.now(),
  shake: 0,
  flash: 0,
  flashColor: "#ff5b5b",
  result: null,
  revealTimer: null,
};

function formatScore(value) {
  return String(Math.max(0, Math.floor(value))).padStart(4, "0");
}

function updatePersistentUI() {
  const dailyBest = stats.daily[game.seed] || 0;
  elements.seedLabel.textContent = game.seed.toUpperCase();
  elements.bestValue.textContent = stats.best ? formatScore(stats.best) : "----";
  elements.playsValue.textContent = String(stats.plays || 0);
  elements.dailyBestValue.textContent = dailyBest ? formatScore(dailyBest) : "----";
  elements.totalCoinsValue.textContent = String(stats.totalCoins || 0);
  elements.maxComboValue.textContent = String(stats.maxCombo || 0);
  elements.soundButton.setAttribute("aria-pressed", String(sound.enabled));
  elements.soundButton.setAttribute("aria-label", sound.enabled ? "关闭声音" : "打开声音");

  if (game.target || game.ghostReplay) {
    elements.challengeBanner.hidden = false;
    elements.challengeTarget.textContent = game.target
      ? formatScore(game.target)
      : `${game.ghostReplay.elapsed.toFixed(1)}s`;
    elements.challengeLabel.textContent = game.ghostReplay ? "好友幽灵" : "好友战绩";
    elements.challengeHint.textContent = game.ghostReplay ? "TA 的真实掉头路线会陪你跑" : "超过 TA，才算下班";
    elements.startButton.querySelector("span").textContent = game.ghostReplay ? "追上 TA" : "开始夺秒";
    document.querySelector(".daily-pill").lastChild.textContent = " 好友地图";
  }
}

function setPanel(panel) {
  elements.startPanel.hidden = panel !== "start";
  elements.resultPanel.hidden = panel !== "result";
  elements.pausePanel.hidden = panel !== "pause";
  elements.overlay.classList.toggle("is-visible", Boolean(panel));
}

function resizeCanvas() {
  const bounds = elements.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  game.width = Math.max(1, bounds.width);
  game.height = Math.max(1, bounds.height);
  game.dpr = dpr;
  elements.canvas.width = Math.round(game.width * dpr);
  elements.canvas.height = Math.round(game.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function cloneSchedule() {
  const schedule = buildSchedule(game.seed);
  game.hazards = schedule.hazards.map((hazard) => ({ ...hazard, warned: false, nearMissed: false, disabled: false }));
  game.pickups = schedule.pickups.map((pickup) => ({ ...pickup, picked: false }));
}

function createGhost() {
  if (!game.ghostReplay) return null;
  return {
    angle: -Math.PI / 2,
    direction: 1,
    nextFlip: 0,
    finished: false,
    alive: true,
    deathAngle: null,
    replay: game.ghostReplay,
  };
}

function startGame() {
  clearTimeout(game.revealTimer);
  sound.ensure();
  cloneSchedule();
  Object.assign(game, {
    mode: "playing",
    elapsed: 0,
    score: 0,
    displayedScore: -1,
    playerAngle: -Math.PI / 2,
    direction: 1,
    combo: 1,
    comboUntil: 0,
    nearMisses: 0,
    coins: 0,
    maxCombo: 1,
    shield: false,
    particles: [],
    floaters: [],
    trails: [],
    ghostTrails: [],
    flipTimes: [],
    ghost: createGhost(),
    lastReverse: -1,
    shake: 0,
    flash: 0,
    flashColor: "#ff5b5b",
    result: null,
    lastFrame: performance.now(),
  });
  elements.clockValue.textContent = clockText(0);
  elements.scoreValue.textContent = "0000";
  elements.comboValue.textContent = "×1";
  elements.shieldIndicator.classList.remove("is-active");
  elements.ghostIndicator.hidden = !game.ghost;
  elements.ghostIndicator.classList.remove("is-finished");
  elements.ghostStatus.textContent = "好友幽灵陪跑中";
  setPanel(null);
  elements.liveRegion.textContent = game.ghost
    ? "幽灵挑战开始。好友的真实路线正在陪跑，单击或按空格键反向。"
    : "游戏开始。单击或按空格键反向，撑到十八点。";
  elements.canvas.focus({ preventScroll: true });
  pulseAtPlayer(game.ghost ? "追上 TA！" : "开溜！", "#eaff4f");
}

function pauseGame() {
  if (game.mode !== "playing") return;
  game.mode = "paused";
  setPanel("pause");
  elements.liveRegion.textContent = "游戏已暂停。";
}

function resumeGame() {
  if (game.mode !== "paused") return;
  game.mode = "playing";
  game.lastFrame = performance.now();
  setPanel(null);
  elements.canvas.focus({ preventScroll: true });
}

function orbitPosition(angle, radiusOffset = 0) {
  const layout = getLayout();
  const radius = layout.trackRadius + radiusOffset;
  return {
    x: layout.cx + Math.cos(angle) * radius,
    y: layout.cy + Math.sin(angle) * radius,
  };
}

function playerPosition(radiusOffset = 0) {
  return orbitPosition(game.playerAngle, radiusOffset);
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function reverseDirection() {
  if (game.mode !== "playing" || game.elapsed - game.lastReverse < 0.095) return;
  game.direction *= -1;
  game.lastReverse = game.elapsed;
  game.flipTimes.push(game.elapsed);
  sound.reverse();
  vibrate(8);

  const position = playerPosition();
  burst(position.x, position.y, "#eaff4f", 7, 80);

  const closeHazard = game.hazards.find((hazard) => {
    if (hazard.disabled || hazard.nearMissed) return false;
    const age = game.elapsed - hazard.at;
    if (age < hazard.warning || age > hazard.warning + hazard.duration) return false;
    const edgeDistance = angleDistance(game.playerAngle, hazard.angle) - hazard.width / 2;
    return edgeDistance > PLAYER_ANGLE_RADIUS && edgeDistance < 0.34;
  });

  if (closeHazard) {
    closeHazard.nearMissed = true;
    game.nearMisses += 1;
    game.combo = Math.min(game.combo + 1, 12);
    game.maxCombo = Math.max(game.maxCombo, game.combo);
    game.comboUntil = game.elapsed + 3.2;
    game.score += 110 * game.combo;
    game.shake = Math.max(game.shake, 2.5);
    pulseAtPlayer("极限掉头 +" + 110 * game.combo, "#68e7e2");
  }
}

function finishGhostRun() {
  const ghost = game.ghost;
  if (!ghost || ghost.finished) return;
  ghost.finished = true;
  ghost.alive = ghost.replay.won;
  ghost.deathAngle = ghost.angle;
  elements.ghostIndicator.classList.add("is-finished");

  if (ghost.replay.won) {
    elements.ghostStatus.textContent = "TA 已准点下班";
    return;
  }

  elements.ghostStatus.textContent = `TA 于 ${clockText(ghost.replay.elapsed)} 被截停`;
  const position = orbitPosition(ghost.angle);
  burst(position.x, position.y, "#68e7e2", 18, 125);
}

function updateGhost(fromElapsed, toElapsed) {
  const ghost = game.ghost;
  if (!ghost || ghost.finished) return;
  const activeEnd = Math.min(toElapsed, ghost.replay.elapsed);
  let cursor = Math.min(fromElapsed, activeEnd);

  while (
    ghost.nextFlip < ghost.replay.flips.length &&
    ghost.replay.flips[ghost.nextFlip] <= activeEnd + 0.00001
  ) {
    const flipTime = ghost.replay.flips[ghost.nextFlip];
    if (flipTime >= cursor) {
      ghost.angle = normalizeAngle(ghost.angle + ghost.direction * angularTravel(cursor, flipTime));
      cursor = flipTime;
    }
    ghost.direction *= -1;
    ghost.nextFlip += 1;
  }

  if (activeEnd > cursor) {
    ghost.angle = normalizeAngle(ghost.angle + ghost.direction * angularTravel(cursor, activeEnd));
  }

  if (activeEnd > fromElapsed) {
    game.ghostTrails.unshift({ ...orbitPosition(ghost.angle), life: 1 });
    if (game.ghostTrails.length > 15) game.ghostTrails.pop();
  }

  if (toElapsed >= ghost.replay.elapsed) finishGhostRun();
}

function updateGame(delta) {
  const previousElapsed = game.elapsed;
  game.elapsed = Math.min(GAME_DURATION, game.elapsed + delta);
  game.playerAngle = normalizeAngle(
    game.playerAngle + game.direction * angularTravel(previousElapsed, game.elapsed)
  );
  updateGhost(previousElapsed, game.elapsed);
  game.score += delta * (30 + game.combo * 2.5);

  if (game.combo > 1 && game.elapsed > game.comboUntil) game.combo = 1;

  const position = playerPosition();
  game.trails.unshift({ ...position, life: 1 });
  if (game.trails.length > 18) game.trails.pop();

  for (const hazard of game.hazards) {
    if (hazard.disabled) continue;
    const age = game.elapsed - hazard.at;
    if (age >= 0 && !hazard.warned) {
      hazard.warned = true;
      sound.warn();
    }
    const active = age >= hazard.warning && age <= hazard.warning + hazard.duration;
    if (!active) continue;
    const colliding = angleDistance(game.playerAngle, hazard.angle) <= hazard.width / 2 + PLAYER_ANGLE_RADIUS;
    if (!colliding) continue;

    if (game.shield) {
      game.shield = false;
      hazard.disabled = true;
      game.flash = 0.65;
      game.flashColor = "#68e7e2";
      game.shake = 12;
      elements.shieldIndicator.classList.remove("is-active");
      burst(position.x, position.y, "#68e7e2", 28, 190);
      pulseAtPlayer("免加会！", "#68e7e2");
      sound.shield();
      vibrate([18, 25, 18]);
    } else {
      finishGame(false, hazard.label);
      return;
    }
  }

  for (const pickup of game.pickups) {
    if (pickup.picked) continue;
    const age = game.elapsed - pickup.at;
    if (age < 0 || age > pickup.duration) continue;
    if (angleDistance(game.playerAngle, pickup.angle) > 0.12) continue;

    pickup.picked = true;
    game.combo = Math.min(game.combo + 1, 12);
    game.maxCombo = Math.max(game.maxCombo, game.combo);
    game.comboUntil = game.elapsed + 3.2;
    game.score += scoreForPickup(game.combo, pickup.type);
    const layout = getLayout();
    const pickupPosition = {
      x: layout.cx + Math.cos(pickup.angle) * layout.trackRadius,
      y: layout.cy + Math.sin(pickup.angle) * layout.trackRadius,
    };

    if (pickup.type === "shield") {
      game.shield = true;
      elements.shieldIndicator.classList.add("is-active");
      pulseAtPlayer("免加会券", "#68e7e2");
      burst(pickupPosition.x, pickupPosition.y, "#68e7e2", 18, 130);
      sound.shield();
    } else {
      game.coins += 1;
      pulseAtPlayer(`工资 +${scoreForPickup(game.combo, pickup.type)}`, "#eaff4f");
      burst(pickupPosition.x, pickupPosition.y, "#eaff4f", 11, 110);
      sound.pickup(game.combo);
    }
    vibrate(10);
  }

  if (game.elapsed >= GAME_DURATION) finishGame(true);
  updateHud();
}

function finishGame(won, reason = "") {
  if (game.mode !== "playing") return;
  game.mode = "result";
  game.elapsed = won ? GAME_DURATION : game.elapsed;
  game.score += won ? 1500 + game.shield * 250 : 0;
  const finalScore = Math.floor(game.score);
  const profile = getResultProfile({
    elapsed: game.elapsed,
    won,
    score: finalScore,
    nearMisses: game.nearMisses,
  });

  game.result = {
    won,
    reason,
    score: finalScore,
    elapsed: game.elapsed,
    nearMisses: game.nearMisses,
    coins: game.coins,
    maxCombo: game.maxCombo,
    profile,
    replay: {
      flips: [...game.flipTimes],
      elapsed: game.elapsed,
      won,
    },
  };
  updateHud();

  stats.plays += 1;
  stats.best = Math.max(stats.best || 0, finalScore);
  stats.totalCoins = (stats.totalCoins || 0) + game.coins;
  stats.maxCombo = Math.max(stats.maxCombo || 0, game.maxCombo);
  stats.daily[game.seed] = Math.max(stats.daily[game.seed] || 0, finalScore);
  const dailyKeys = Object.keys(stats.daily);
  if (dailyKeys.length > 14) {
    dailyKeys.sort().slice(0, -14).forEach((key) => delete stats.daily[key]);
  }
  writeStats(stats);
  updatePersistentUI();
  updateResultPanel();

  const position = playerPosition();
  if (won) {
    sound.win();
    vibrate([20, 40, 20, 40, 35]);
    game.flash = 0.8;
    game.flashColor = "#eaff4f";
    createConfetti();
    elements.liveRegion.textContent = `成功准点下班，最终战绩 ${finalScore}。`;
  } else {
    sound.hit();
    vibrate([40, 40, 70]);
    game.shake = 18;
    game.flash = 0.9;
    game.flashColor = "#ff5b5b";
    burst(position.x, position.y, "#ff5b5b", 34, 220);
    pulseAtPlayer(reason || "被抓到了", "#ff8a8a");
    elements.liveRegion.textContent = `被${reason || "临时加会"}拦住，坚持了 ${game.elapsed.toFixed(1)} 秒。`;
  }

  game.revealTimer = setTimeout(() => setPanel("result"), reducedMotion ? 50 : 620);
}

function updateHud() {
  const nextScore = Math.floor(game.score);
  elements.clockValue.textContent = clockText(game.elapsed);
  if (nextScore !== game.displayedScore) {
    game.displayedScore = nextScore;
    elements.scoreValue.textContent = formatScore(nextScore);
  }
  elements.comboValue.textContent = `×${game.combo}`;
}

function updateResultPanel() {
  const { result } = game;
  if (!result) return;
  elements.resultEyebrow.textContent = result.won ? "准点下班认证" : `被「${result.reason || "临时加会"}」截停`;
  elements.resultEmoji.textContent = result.profile.emoji;
  elements.resultTitle.textContent = result.profile.title;
  elements.resultLine.textContent = result.profile.line;
  elements.resultScore.textContent = formatScore(result.score);
  elements.resultMeta.textContent = `坚持 ${result.elapsed.toFixed(1)} 秒 · 近失 ${result.nearMisses} 次 · 工资币 ${result.coins}`;

  if (game.target) {
    const beatTarget = result.score > game.target;
    elements.challengeResult.hidden = false;
    elements.challengeResult.classList.toggle("is-lost", !beatTarget);
    elements.challengeResult.textContent = beatTarget
      ? `${game.ghostReplay ? "甩开好友幽灵" : "超过好友"} ${formatScore(result.score - game.target)} 分，下班成功！`
      : `还差 ${formatScore(game.target - result.score + 1)} 分超过好友`;
  } else if (game.ghostReplay) {
    const elapsedDelta = result.elapsed - game.ghostReplay.elapsed;
    const tied = Math.abs(elapsedDelta) < 0.005 && result.won === game.ghostReplay.won;
    const outlasted = result.won !== game.ghostReplay.won
      ? result.won
      : elapsedDelta > 0;
    elements.challengeResult.hidden = false;
    elements.challengeResult.classList.toggle("is-lost", !outlasted && !tied);
    elements.challengeResult.textContent = tied
      ? result.won ? "你和 TA 同时准点下班，打成平手" : `你和 TA 都撑到 ${clockText(result.elapsed)}，打成平手`
      : outlasted
        ? `比 TA 多撑了 ${Math.abs(elapsedDelta).toFixed(1)} 秒`
        : `TA 比你多撑了 ${Math.abs(elapsedDelta).toFixed(1)} 秒`;
  } else {
    elements.challengeResult.hidden = true;
  }
}

function updateEffects(delta) {
  game.shake = Math.max(0, game.shake - delta * 32);
  game.flash = Math.max(0, game.flash - delta * 2.4);
  game.trails.forEach((trail) => {
    trail.life -= delta * 2.4;
  });
  game.trails = game.trails.filter((trail) => trail.life > 0);
  game.ghostTrails.forEach((trail) => {
    trail.life -= delta * 2.1;
  });
  game.ghostTrails = game.ghostTrails.filter((trail) => trail.life > 0);

  game.particles.forEach((particle) => {
    particle.x += particle.vx * delta;
    particle.y += particle.vy * delta;
    particle.vy += particle.gravity * delta;
    particle.life -= delta / particle.maxLife;
    particle.rotation += particle.spin * delta;
  });
  game.particles = game.particles.filter((particle) => particle.life > 0);

  game.floaters.forEach((floater) => {
    floater.y -= delta * 28;
    floater.life -= delta / floater.maxLife;
  });
  game.floaters = game.floaters.filter((floater) => floater.life > 0);
}

function burst(x, y, color, count = 10, velocity = 100) {
  const amount = reducedMotion ? Math.min(4, count) : count;
  for (let index = 0; index < amount; index += 1) {
    const angle = Math.random() * TAU;
    const speed = velocity * (0.35 + Math.random() * 0.65);
    const life = 0.35 + Math.random() * 0.45;
    game.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      gravity: 50,
      life: 1,
      maxLife: life,
      size: 2 + Math.random() * 4,
      color,
      rotation: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 10,
      rectangle: Math.random() > 0.55,
    });
  }
}

function createConfetti() {
  const colors = ["#eaff4f", "#68e7e2", "#ff5b5b", "#f6f2e8", "#b9a7e8"];
  const count = reducedMotion ? 20 : 90;
  for (let index = 0; index < count; index += 1) {
    const life = 1.5 + Math.random() * 1.2;
    game.particles.push({
      x: Math.random() * game.width,
      y: -20 - Math.random() * game.height * 0.25,
      vx: (Math.random() - 0.5) * 80,
      vy: 90 + Math.random() * 170,
      gravity: 90,
      life: 1,
      maxLife: life,
      size: 4 + Math.random() * 7,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 8,
      rectangle: true,
    });
  }
}

function pulseAtPlayer(text, color) {
  const position = playerPosition(-18);
  game.floaters.push({ x: position.x, y: position.y, text, color, life: 1, maxLife: 0.85 });
}

function getLayout() {
  const minimum = Math.min(game.width, game.height);
  return {
    cx: game.width / 2,
    cy: game.height / 2 + (game.height > game.width ? 5 : 0),
    trackRadius: minimum * (game.height > game.width ? 0.335 : 0.32),
    clockRadius: minimum * 0.205,
    minimum,
  };
}

function drawBackground(ctx, layout) {
  const gradient = ctx.createRadialGradient(layout.cx, layout.cy, 20, layout.cx, layout.cy, layout.minimum * 0.72);
  gradient.addColorStop(0, "#25183b");
  gradient.addColorStop(0.52, "#151022");
  gradient.addColorStop(1, "#0c0914");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, game.width, game.height);

  ctx.save();
  ctx.strokeStyle = "rgba(246,242,232,0.035)";
  ctx.lineWidth = 1;
  const grid = Math.max(26, layout.minimum * 0.055);
  for (let x = (game.width / 2) % grid; x < game.width; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, game.height);
    ctx.stroke();
  }
  for (let y = (game.height / 2) % grid; y < game.height; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(game.width, y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(layout.cx, layout.cy);
  ctx.strokeStyle = "rgba(234,255,79,0.055)";
  ctx.setLineDash([3, 9]);
  for (const scale of [1.28, 1.52]) {
    ctx.beginPath();
    ctx.arc(0, 0, layout.trackRadius * scale, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTrack(ctx, layout, elapsed) {
  ctx.save();
  ctx.translate(layout.cx, layout.cy);
  ctx.lineCap = "round";

  ctx.strokeStyle = "rgba(246,242,232,0.1)";
  ctx.lineWidth = Math.max(2, layout.minimum * 0.006);
  ctx.beginPath();
  ctx.arc(0, 0, layout.trackRadius, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = "rgba(246,242,232,0.07)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 10]);
  ctx.beginPath();
  ctx.arc(0, 0, layout.trackRadius - 13, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, layout.trackRadius + 13, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  const progress = clamp(elapsed / GAME_DURATION, 0, 1);
  if (progress > 0) {
    ctx.strokeStyle = "rgba(234,255,79,0.65)";
    ctx.shadowColor = "rgba(234,255,79,0.55)";
    ctx.shadowBlur = 12;
    ctx.lineWidth = Math.max(2, layout.minimum * 0.006);
    ctx.beginPath();
    ctx.arc(0, 0, layout.trackRadius + 21, -Math.PI / 2, -Math.PI / 2 + TAU * progress);
    ctx.stroke();
  }
  ctx.restore();
}

function drawClock(ctx, layout, elapsed) {
  const radius = layout.clockRadius;
  ctx.save();
  ctx.translate(layout.cx, layout.cy);

  const face = ctx.createRadialGradient(-radius * 0.22, -radius * 0.25, 0, 0, 0, radius);
  face.addColorStop(0, "#35264c");
  face.addColorStop(1, "#1b132a");
  ctx.fillStyle = face;
  ctx.shadowColor = "rgba(0,0,0,0.48)";
  ctx.shadowBlur = 28;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(246,242,232,0.17)";
  ctx.lineWidth = 1;
  ctx.stroke();

  for (let index = 0; index < 60; index += 1) {
    const angle = (index / 60) * TAU - Math.PI / 2;
    const major = index % 5 === 0;
    const inner = radius * (major ? 0.79 : 0.85);
    const outer = radius * 0.91;
    ctx.strokeStyle = major ? "rgba(246,242,232,0.55)" : "rgba(246,242,232,0.18)";
    ctx.lineWidth = major ? 1.8 : 1;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.stroke();
  }

  const currentSeconds = 15 + elapsed;
  const secondAngle = (currentSeconds / 60) * TAU - Math.PI / 2;
  const minuteAngle = ((59 + currentSeconds / 60) / 60) * TAU - Math.PI / 2;

  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(246,242,232,0.68)";
  ctx.lineWidth = Math.max(2, radius * 0.025);
  ctx.beginPath();
  ctx.moveTo(-Math.cos(minuteAngle) * radius * 0.1, -Math.sin(minuteAngle) * radius * 0.1);
  ctx.lineTo(Math.cos(minuteAngle) * radius * 0.52, Math.sin(minuteAngle) * radius * 0.52);
  ctx.stroke();

  ctx.strokeStyle = "#ff5b5b";
  ctx.shadowColor = "rgba(255,91,91,0.7)";
  ctx.shadowBlur = 8;
  ctx.lineWidth = Math.max(1.5, radius * 0.017);
  ctx.beginPath();
  ctx.moveTo(-Math.cos(secondAngle) * radius * 0.15, -Math.sin(secondAngle) * radius * 0.15);
  ctx.lineTo(Math.cos(secondAngle) * radius * 0.68, Math.sin(secondAngle) * radius * 0.68);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#eaff4f";
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(3, radius * 0.045), 0, TAU);
  ctx.fill();

  ctx.fillStyle = "rgba(246,242,232,0.46)";
  ctx.font = `800 ${Math.max(7, radius * 0.065)}px ui-sans-serif, system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("距离下班", 0, radius * 0.32);
  ctx.fillStyle = "#f6f2e8";
  ctx.font = `900 ${Math.max(13, radius * 0.18)}px SFMono-Regular, Consolas, monospace`;
  ctx.fillText(`${Math.max(0, GAME_DURATION - elapsed).toFixed(1)}s`, 0, radius * 0.49);
  ctx.restore();
}

function hazardPhase(hazard, elapsed) {
  const age = elapsed - hazard.at;
  if (age < 0 || age > hazard.warning + hazard.duration) return null;
  if (age < hazard.warning) return { name: "warning", progress: age / hazard.warning };
  return { name: "active", progress: (age - hazard.warning) / hazard.duration };
}

function drawHazard(ctx, layout, hazard, elapsed) {
  if (hazard.disabled) return;
  const phase = hazardPhase(hazard, elapsed);
  if (!phase) return;
  const start = hazard.angle - hazard.width / 2;
  const end = hazard.angle + hazard.width / 2;
  const pulse = 0.55 + Math.sin(game.idleTime * 14 + hazard.angle * 3) * 0.25;
  ctx.save();
  ctx.translate(layout.cx, layout.cy);
  ctx.lineCap = "round";

  if (phase.name === "warning") {
    ctx.strokeStyle = `rgba(255,91,91,${0.18 + pulse * 0.35})`;
    ctx.lineWidth = Math.max(10, layout.minimum * 0.023);
    ctx.setLineDash([3, 7]);
    ctx.beginPath();
    ctx.arc(0, 0, layout.trackRadius, start, end);
    ctx.stroke();
    ctx.setLineDash([]);

    const labelRadius = layout.trackRadius + Math.max(22, layout.minimum * 0.052);
    const x = Math.cos(hazard.angle) * labelRadius;
    const y = Math.sin(hazard.angle) * labelRadius;
    const fontSize = Math.max(7, layout.minimum * 0.016);
    ctx.font = `800 ${fontSize}px ui-sans-serif, system-ui`;
    const width = ctx.measureText(hazard.label).width + 13;
    ctx.fillStyle = `rgba(255,91,91,${0.68 + pulse * 0.22})`;
    ctx.fillRect(x - width / 2, y - fontSize, width, fontSize + 7);
    ctx.fillStyle = "#180f20";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(hazard.label, x, y - fontSize / 2 + 3);
  } else {
    const fade = phase.progress > 0.78 ? 1 - (phase.progress - 0.78) / 0.22 : 1;
    ctx.strokeStyle = `rgba(255,76,86,${0.34 * fade})`;
    ctx.shadowColor = "#ff4255";
    ctx.shadowBlur = 25;
    ctx.lineWidth = Math.max(24, layout.minimum * 0.062);
    ctx.beginPath();
    ctx.arc(0, 0, layout.trackRadius, start, end);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,110,110,${0.98 * fade})`;
    ctx.shadowBlur = 8;
    ctx.lineWidth = Math.max(11, layout.minimum * 0.026);
    ctx.beginPath();
    ctx.arc(0, 0, layout.trackRadius, start, end);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPickup(ctx, layout, pickup, elapsed) {
  if (pickup.picked) return;
  const age = elapsed - pickup.at;
  if (age < 0 || age > pickup.duration) return;
  const fade = age > pickup.duration - 0.8 ? (pickup.duration - age) / 0.8 : 1;
  const radius = Math.max(7, layout.minimum * 0.018);
  const x = layout.cx + Math.cos(pickup.angle) * layout.trackRadius;
  const y = layout.cy + Math.sin(pickup.angle) * layout.trackRadius;
  const bob = Math.sin(game.idleTime * 6 + pickup.angle) * 1.5;

  ctx.save();
  ctx.translate(x, y + bob);
  ctx.globalAlpha = fade;
  ctx.shadowBlur = 15;
  ctx.shadowColor = pickup.type === "shield" ? "#68e7e2" : "#eaff4f";
  ctx.fillStyle = pickup.type === "shield" ? "#68e7e2" : "#eaff4f";
  if (pickup.type === "shield") {
    ctx.rotate(Math.PI / 4 + game.idleTime * 0.8);
    ctx.fillRect(-radius * 0.72, -radius * 0.72, radius * 1.44, radius * 1.44);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#171126";
    ctx.lineWidth = 2;
    ctx.strokeRect(-radius * 0.38, -radius * 0.38, radius * 0.76, radius * 0.76);
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#171126";
    ctx.font = `900 ${radius * 1.15}px ui-sans-serif, system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("¥", 0, 1);
  }
  ctx.restore();
}

function drawPlayer(ctx, layout, angle = game.playerAngle) {
  for (let index = game.trails.length - 1; index >= 0; index -= 1) {
    const trail = game.trails[index];
    ctx.globalAlpha = Math.max(0, trail.life) * 0.32 * (1 - index / game.trails.length);
    ctx.fillStyle = "#eaff4f";
    ctx.beginPath();
    ctx.arc(trail.x, trail.y, Math.max(1, layout.minimum * 0.006 * trail.life), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const x = layout.cx + Math.cos(angle) * layout.trackRadius;
  const y = layout.cy + Math.sin(angle) * layout.trackRadius;
  const size = Math.max(8, layout.minimum * 0.02);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle + (game.direction > 0 ? Math.PI / 2 : -Math.PI / 2));

  if (game.shield) {
    ctx.strokeStyle = `rgba(104,231,226,${0.55 + Math.sin(game.idleTime * 8) * 0.2})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = "#68e7e2";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.55, 0, TAU);
    ctx.stroke();
  }

  ctx.shadowColor = "#eaff4f";
  ctx.shadowBlur = 22;
  ctx.fillStyle = "#eaff4f";
  ctx.beginPath();
  ctx.moveTo(0, -size * 1.2);
  ctx.lineTo(size * 0.78, size * 0.75);
  ctx.lineTo(0, size * 0.45);
  ctx.lineTo(-size * 0.78, size * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#171126";
  ctx.beginPath();
  ctx.arc(0, -size * 0.2, size * 0.24, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawGhost(ctx, layout) {
  const ghost = game.ghost;
  if (!ghost) return;

  for (let index = game.ghostTrails.length - 1; index >= 0; index -= 1) {
    const trail = game.ghostTrails[index];
    ctx.globalAlpha = Math.max(0, trail.life) * 0.22 * (1 - index / game.ghostTrails.length);
    ctx.fillStyle = "#68e7e2";
    ctx.beginPath();
    ctx.arc(trail.x, trail.y, Math.max(1, layout.minimum * 0.005 * trail.life), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const angle = ghost.deathAngle ?? ghost.angle;
  const x = layout.cx + Math.cos(angle) * layout.trackRadius;
  const y = layout.cy + Math.sin(angle) * layout.trackRadius;
  const size = Math.max(7, layout.minimum * 0.017);

  if (ghost.finished && !ghost.replay.won) {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.58;
    ctx.strokeStyle = "#68e7e2";
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.5, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-size * 0.45, -size * 0.45);
    ctx.lineTo(size * 0.45, size * 0.45);
    ctx.moveTo(size * 0.45, -size * 0.45);
    ctx.lineTo(-size * 0.45, size * 0.45);
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + (ghost.direction > 0 ? Math.PI / 2 : -Math.PI / 2));
    ctx.globalAlpha = 0.76;
    ctx.globalCompositeOperation = "screen";
    ctx.strokeStyle = "#68e7e2";
    ctx.fillStyle = "rgba(104,231,226,0.2)";
    ctx.shadowColor = "#68e7e2";
    ctx.shadowBlur = 15;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -size * 1.15);
    ctx.lineTo(size * 0.75, size * 0.72);
    ctx.lineTo(0, size * 0.42);
    ctx.lineTo(-size * 0.75, size * 0.72);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  const labelRadius = layout.trackRadius - Math.max(21, layout.minimum * 0.05);
  const labelX = layout.cx + Math.cos(angle) * labelRadius;
  const labelY = layout.cy + Math.sin(angle) * labelRadius;
  ctx.save();
  ctx.translate(labelX, labelY);
  ctx.fillStyle = "#68e7e2";
  ctx.beginPath();
  ctx.roundRect(-11, -7, 22, 14, 7);
  ctx.fill();
  ctx.fillStyle = "#171126";
  ctx.font = "900 8px SFMono-Regular, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("TA", 0, 0.5);
  ctx.restore();
}

function drawParticles(ctx) {
  for (const particle of game.particles) {
    ctx.save();
    ctx.globalAlpha = clamp(particle.life, 0, 1);
    ctx.translate(particle.x, particle.y);
    ctx.rotate(particle.rotation);
    ctx.fillStyle = particle.color;
    if (particle.rectangle) {
      ctx.fillRect(-particle.size / 2, -particle.size / 3, particle.size, particle.size * 0.66);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, particle.size / 2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  for (const floater of game.floaters) {
    ctx.save();
    ctx.globalAlpha = clamp(floater.life, 0, 1);
    ctx.fillStyle = floater.color;
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 6;
    ctx.font = "900 12px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.fillText(floater.text, floater.x, floater.y);
    ctx.restore();
  }
}

function drawDirectionHint(ctx, layout) {
  if (game.mode !== "playing" || game.elapsed > 3.8) return;
  const alpha = clamp(1 - game.elapsed / 3.8, 0, 1);
  ctx.save();
  ctx.globalAlpha = alpha * 0.8;
  ctx.fillStyle = "#f6f2e8";
  ctx.font = `800 ${Math.max(8, layout.minimum * 0.017)}px ui-sans-serif, system-ui`;
  ctx.textAlign = "center";
  ctx.fillText("单击任意位置  ↺  立即反向", layout.cx, layout.cy + layout.trackRadius + 55);
  ctx.restore();
}

function render() {
  const layout = getLayout();
  const shakeX = game.shake ? (Math.random() - 0.5) * game.shake : 0;
  const shakeY = game.shake ? (Math.random() - 0.5) * game.shake : 0;
  context.save();
  context.translate(shakeX, shakeY);
  drawBackground(context, layout);

  const visualElapsed = game.mode === "menu" ? 0 : game.elapsed;
  drawTrack(context, layout, visualElapsed);
  drawClock(context, layout, visualElapsed);

  if (game.mode === "menu") {
    const previewHazard = {
      angle: 0.2,
      width: 0.62,
      at: 0,
      warning: 0.1,
      duration: 999,
      label: "临时加会",
      disabled: false,
    };
    drawHazard(context, layout, previewHazard, 0.2);
    game.direction = Math.sin(game.idleTime * 0.7) > -0.98 ? 1 : -1;
    drawPlayer(context, layout, -Math.PI / 2 + game.idleTime * 0.35);
  } else {
    game.hazards.forEach((hazard) => drawHazard(context, layout, hazard, game.elapsed));
    game.pickups.forEach((pickup) => drawPickup(context, layout, pickup, game.elapsed));
    drawGhost(context, layout);
    drawPlayer(context, layout);
    drawDirectionHint(context, layout);
  }

  drawParticles(context);
  context.restore();

  if (game.flash > 0) {
    context.save();
    context.globalAlpha = game.flash * 0.26;
    context.fillStyle = game.flashColor;
    context.fillRect(0, 0, game.width, game.height);
    context.restore();
  }
}

function frame(timestamp) {
  const delta = Math.min(0.04, Math.max(0, (timestamp - game.lastFrame) / 1000));
  game.lastFrame = timestamp;
  game.idleTime += delta;
  if (game.mode === "playing") updateGame(delta);
  updateEffects(delta);
  render();
  requestAnimationFrame(frame);
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 1900);
}

function challengeUrl(score = 0) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("seed", game.seed);
  if (score > 0) url.searchParams.set("target", String(Math.floor(score)));
  const replay = game.result?.replay || (!game.result ? game.ghostReplay : null);
  if (replay) url.searchParams.set("ghost", encodeReplay(replay));
  return url.toString();
}

function shareCopy(score = 0) {
  if (game.result) {
    return `我在《六点夺秒》拿到 ${formatScore(game.result.score)} 分，解锁「${game.result.profile.title}」${game.result.profile.emoji}\n我的真实掉头路线已变成幽灵。你能追上 TA 吗？`;
  }
  if (game.ghostReplay) return "我收到一条《六点夺秒》幽灵路线。一起追上 TA，看看谁先准点下班。";
  if (score > 0) return `我在《六点夺秒》的最佳战绩是 ${formatScore(score)}。最后 45 秒，你能比我更会躲加会吗？`;
  return "《六点夺秒》：单击反向，躲开加会，撑过下班前最后 45 秒。来试试今天的同一张地图。";
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

async function makeResultCard() {
  const result = game.result || {
    score: stats.best || 0,
    elapsed: 0,
    nearMisses: 0,
    coins: 0,
    profile: getResultProfile({ elapsed: 0, won: false, score: stats.best || 0 }),
  };
  const card = document.createElement("canvas");
  card.width = 1080;
  card.height = 1440;
  const ctx = card.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 1080, 1440);
  gradient.addColorStop(0, "#2e1b49");
  gradient.addColorStop(0.58, "#171126");
  gradient.addColorStop(1, "#0b0812");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1440);

  ctx.strokeStyle = "rgba(246,242,232,.055)";
  ctx.lineWidth = 2;
  for (let x = 0; x < 1080; x += 54) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 1440);
    ctx.stroke();
  }
  for (let y = 0; y < 1440; y += 54) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1080, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#eaff4f";
  roundedRect(ctx, 72, 70, 98, 98, 49);
  ctx.fillStyle = "#171126";
  ctx.font = "900 72px Impact, Arial Black, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("6", 121, 145);
  ctx.textAlign = "left";
  ctx.fillStyle = "#f6f2e8";
  ctx.font = "900 38px system-ui, sans-serif";
  ctx.fillText("六点夺秒", 194, 112);
  ctx.fillStyle = "#8f87a2";
  ctx.font = "700 18px ui-monospace, monospace";
  ctx.letterSpacing = "4px";
  ctx.fillText("SIX PM SPRINT / DAILY CHALLENGE", 194, 151);

  ctx.fillStyle = "rgba(246,242,232,.12)";
  ctx.fillRect(72, 206, 936, 2);
  ctx.fillStyle = "#68e7e2";
  ctx.font = "900 22px system-ui, sans-serif";
  ctx.fillText("本次下班鉴定", 72, 278);

  ctx.font = "96px system-ui, sans-serif";
  ctx.fillText(result.profile.emoji, 72, 410);
  ctx.fillStyle = "#f6f2e8";
  ctx.font = "900 88px system-ui, sans-serif";
  ctx.fillText(result.profile.title, 72, 520);
  ctx.fillStyle = "#aaa2b8";
  ctx.font = "500 31px system-ui, sans-serif";
  ctx.fillText(result.profile.line, 72, 581);

  ctx.fillStyle = "rgba(10,7,17,.46)";
  roundedRect(ctx, 72, 650, 936, 420, 20);
  ctx.fillStyle = "#8f87a2";
  ctx.font = "800 20px system-ui, sans-serif";
  ctx.fillText("最终战绩", 118, 716);
  ctx.fillStyle = "#eaff4f";
  ctx.font = "900 170px ui-monospace, SFMono-Regular, monospace";
  ctx.fillText(formatScore(result.score), 104, 895);

  ctx.strokeStyle = "rgba(246,242,232,.12)";
  ctx.beginPath();
  ctx.moveTo(118, 936);
  ctx.lineTo(962, 936);
  ctx.stroke();
  const facts = [
    ["坚持", `${result.elapsed.toFixed(1)} 秒`],
    ["极限掉头", `${result.nearMisses} 次`],
    ["工资币", `${result.coins} 枚`],
  ];
  facts.forEach(([label, value], index) => {
    const x = 118 + index * 282;
    ctx.fillStyle = "#81798f";
    ctx.font = "700 18px system-ui, sans-serif";
    ctx.fillText(label, x, 988);
    ctx.fillStyle = "#f6f2e8";
    ctx.font = "900 28px system-ui, sans-serif";
    ctx.fillText(value, x, 1032);
  });

  ctx.fillStyle = "#ff5b5b";
  ctx.font = "900 26px system-ui, sans-serif";
  ctx.fillText("我的幽灵已留在跑道，你能超过我吗？", 72, 1168);
  ctx.fillStyle = "#f6f2e8";
  ctx.font = "800 34px system-ui, sans-serif";
  ctx.fillText("单击反向 · 躲开加会 · 准点消失", 72, 1222);
  ctx.fillStyle = "#6f677a";
  ctx.font = "700 18px ui-monospace, monospace";
  ctx.fillText(`MAP ${game.seed.toUpperCase()}  /  打开配套分享链接，追逐我的真实路线`, 72, 1328);
  ctx.fillStyle = "#eaff4f";
  ctx.fillRect(72, 1366, 936, 8);

  return new Promise((resolve) => card.toBlob(resolve, "image/png", 0.94));
}

async function shareChallenge() {
  const score = game.result?.score || (game.ghostReplay ? game.target : stats.best) || 0;
  const url = challengeUrl(score);
  const text = shareCopy(score);
  const shareData = { title: "六点夺秒｜下班生存挑战", text, url };

  try {
    if (navigator.share) {
      if (game.result && window.File && navigator.canShare) {
        const blob = await makeResultCard();
        if (blob) {
          const file = new File([blob], `六点夺秒-${formatScore(score)}.png`, { type: "image/png" });
          if (navigator.canShare({ files: [file] })) shareData.files = [file];
        }
      }
      await navigator.share(shareData);
      showToast(game.result ? "幽灵挑战已发出，等同事接招" : "挑战已发出，等同事接招");
    } else {
      await copyText(`${text}\n${url}`);
      showToast(game.result ? "战绩与幽灵路线已复制" : "战绩与挑战链接已复制");
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      try {
        await copyText(`${text}\n${url}`);
        showToast("分享不可用，已复制挑战链接");
      } catch {
        showToast("暂时无法分享，请复制浏览器地址");
      }
    }
  }
}

async function saveResultCard() {
  try {
    const blob = await makeResultCard();
    if (!blob) throw new Error("No blob");
    const link = document.createElement("a");
    link.download = `六点夺秒-${formatScore(game.result?.score || stats.best || 0)}.png`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast("战绩卡已保存");
  } catch {
    showToast("战绩卡生成失败，请稍后再试");
  }
}

elements.stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  reverseDirection();
});

elements.startButton.addEventListener("click", startGame);
elements.againButton.addEventListener("click", startGame);
elements.resumeButton.addEventListener("click", resumeGame);
elements.shareButton.addEventListener("click", shareChallenge);
elements.sideShareButton.addEventListener("click", shareChallenge);
elements.saveCardButton.addEventListener("click", saveResultCard);
elements.soundButton.addEventListener("click", () => {
  sound.setEnabled(!sound.enabled);
  updatePersistentUI();
});

document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" && event.code !== "ArrowLeft" && event.code !== "ArrowRight") return;
  if (["BUTTON", "A", "INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) && event.code === "Space") return;
  event.preventDefault();
  if (game.mode === "playing") reverseDirection();
  else if (game.mode === "menu" || game.mode === "result") startGame();
  else if (game.mode === "paused") resumeGame();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseGame();
});

window.addEventListener("resize", resizeCanvas, { passive: true });
new ResizeObserver(resizeCanvas).observe(elements.stage);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

cloneSchedule();
updatePersistentUI();
resizeCanvas();
setPanel("start");
requestAnimationFrame(frame);
