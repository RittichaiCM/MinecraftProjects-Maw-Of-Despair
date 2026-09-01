import { BlockPermutation, ItemStack, system, world } from "@minecraft/server";

const ADDON_NAME = "Maw of Despair";
const ADDON_VERSION = "0.2.0-dev";
const MAW_TYPE = "mawofdespair:demon_maw";
const STATE_KEY = "mawofdespair:encounter_state";
const NEXT_NATURAL_SPAWN_KEY = "mawofdespair:next_natural_spawn";

const ARENA_RADIUS = 9;
const TRIGGER_RADIUS = 6.5;
const PULL_RADIUS = 8.25;
const PIT_RADIUS = 7.35;
const WARNING_MS = 3000;
const STOMACH_LAYOUT_VERSION = 5;
const TICK_INTERVAL = 4;
const BITE_RADIUS = 1.85;
const LIVING_BITE_RADIUS = 2.65;
const BITE_DAMAGE = 12;
const MAW_RESTORE_DELAY_MS = 5000;
const ACTIVE_SOUND_INTERVAL_TICKS = 60;
const BITE_EAT_INTERVAL_TICKS = 10;
const BITE_GROWL_INTERVAL_TICKS = 60;
const PULL_STRENGTH_MIN = 0.9;
const PULL_STRENGTH_MAX = 1.75;
const PULL_LOW_HEALTH_MAX_MULTIPLIER = 2;
const PULL_SHIFT_MIN_TICKS = 12;
const PULL_SHIFT_MAX_TICKS = 32;
const NATURAL_SPAWN_MIN_MS = 10 * 60 * 1000;
const NATURAL_SPAWN_MAX_MS = 20 * 60 * 1000;
const NATURAL_RETRY_MIN_MS = 60 * 1000;
const NATURAL_RETRY_MAX_MS = 2 * 60 * 1000;
const NATURAL_SPAWN_MIN_DISTANCE = 40;
const NATURAL_SPAWN_MAX_DISTANCE = 64;
const NATURAL_SPAWN_ATTEMPTS = 20;
const NATURAL_WORLD_SPAWN_EXCLUSION = 96;

const NATURAL_EARTH_BLOCKS = new Set([
  "minecraft:grass_block",
  "minecraft:dirt",
  "minecraft:coarse_dirt",
  "minecraft:rooted_dirt",
  "minecraft:podzol",
  "minecraft:mycelium",
  "minecraft:moss_block"
]);

const NATURAL_ROCKY_BLOCKS = new Set([
  "minecraft:stone",
  "minecraft:gravel",
  "minecraft:calcite",
  "minecraft:tuff"
]);

const STOMACH_LOOT = [
  { typeId: "minecraft:iron_ingot", chance: 0.70, min: 2, max: 7 },
  { typeId: "minecraft:gold_ingot", chance: 0.55, min: 2, max: 6 },
  { typeId: "minecraft:emerald", chance: 0.35, min: 1, max: 5 },
  { typeId: "minecraft:arrow", chance: 0.65, min: 5, max: 16 },
  { typeId: "minecraft:cooked_beef", chance: 0.50, min: 2, max: 6 },
  { typeId: "minecraft:torch", chance: 0.55, min: 4, max: 12 },
  { typeId: "minecraft:ender_pearl", chance: 0.25, min: 1, max: 2 },
  { typeId: "minecraft:bone", chance: 0.45, min: 1, max: 4 },
  { typeId: "minecraft:leather", chance: 0.35, min: 1, max: 3 },
  { typeId: "minecraft:string", chance: 0.40, min: 2, max: 6 },
  { typeId: "minecraft:compass", chance: 0.18, min: 1, max: 1 },
  { typeId: "minecraft:name_tag", chance: 0.15, min: 1, max: 1 },
  { typeId: "minecraft:saddle", chance: 0.12, min: 1, max: 1 },
  { typeId: "minecraft:bow", chance: 0.18, min: 1, max: 1 },
  { typeId: "minecraft:iron_sword", chance: 0.12, min: 1, max: 1 },
  { typeId: "minecraft:diamond", chance: 0.08, min: 1, max: 2 },
  { typeId: "minecraft:golden_apple", chance: 0.05, min: 1, max: 1 },
  { typeId: "minecraft:enchanted_golden_apple", chance: 0.01, min: 1, max: 1 }
];

const stateRuntime = {
  state: undefined,
  lastCollapseStage: 0,
  lastBiteTick: new Map(),
  mawMissingSinceMs: 0,
  activeAudioInitialized: false,
  lastActiveSoundTick: -10000,
  mawOpen: false,
  mawStateInitialized: false,
  biteAudioActive: false,
  lastBiteEatTick: -10000,
  lastBiteGrowlTick: -10000,
  lastShieldHintTick: new Map(),
  playerInPit: false,
  pullStrengthMultiplier: 1,
  nextPullStrengthTick: 0,
  nextNaturalSpawnAtMs: 0
};

function log(message) {
  console.warn(`[${ADDON_NAME}] ${message}`);
}

function reportError(context, error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.warn(`[${ADDON_NAME}] ${context} failed: ${message}`);
}

function saveState() {
  if (!stateRuntime.state) {
    world.setDynamicProperty(STATE_KEY, undefined);
    return;
  }
  world.setDynamicProperty(STATE_KEY, JSON.stringify(stateRuntime.state));
}

function loadState() {
  const raw = world.getDynamicProperty(STATE_KEY);
  if (typeof raw !== "string") {
    stateRuntime.state = undefined;
    return;
  }

  try {
    stateRuntime.state = JSON.parse(raw);
  } catch (error) {
    reportError("reading saved encounter state", error);
    stateRuntime.state = undefined;
  }
}

function getDimension(dimensionId) {
  try {
    return world.getDimension(dimensionId);
  } catch (error) {
    reportError(`opening dimension ${dimensionId}`, error);
    return undefined;
  }
}

function isEligiblePlayer(player) {
  try {
    const mode = String(player.getGameMode?.() ?? "survival").toLowerCase();
    return !mode.includes("creative") && !mode.includes("spectator");
  } catch {
    return true;
  }
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function sendTitle(player, title, subtitle = "") {
  try {
    player.onScreenDisplay.setTitle(title, {
      subtitle,
      fadeInDuration: 5,
      stayDuration: 35,
      fadeOutDuration: 10
    });
  } catch {
    player.sendMessage(`${title}${subtitle ? ` - ${subtitle}` : ""}`);
  }
}

function playSound(dimension, soundId, location, volume = 1, pitch = 1) {
  try {
    dimension.playSound(soundId, location, { volume, pitch });
  } catch (error) {
    reportError(`playing sound ${soundId}`, error);
  }
}

function floorDepth(radius) {
  if (radius <= 2.25) return 5;
  if (radius <= 4.25) return 3;
  if (radius <= 6.25) return 2;
  if (radius <= 7.5) return 1;
  return 0;
}

function forEachArenaColumn(center, callback) {
  for (let dx = -ARENA_RADIUS; dx <= ARENA_RADIUS; dx++) {
    for (let dz = -ARENA_RADIUS; dz <= ARENA_RADIUS; dz++) {
      const radius = Math.hypot(dx, dz);
      if (radius <= ARENA_RADIUS + 0.15) {
        callback(center.x + dx, center.z + dz, radius);
      }
    }
  }
}

function removeExistingMaws(dimension, center) {
  for (const entity of dimension.getEntities({
    type: MAW_TYPE,
    location: { x: center.x + 0.5, y: center.y - 3, z: center.z + 0.5 },
    maxDistance: 24
  })) {
    try {
      entity.remove();
    } catch (error) {
      reportError("removing an old maw", error);
    }
  }
}

function buildArena(
  dimension,
  center,
  surfaceBlock = "minecraft:red_sand",
  solidBlock = "minecraft:red_sandstone",
  coverBlock = solidBlock
) {
  forEachArenaColumn(center, (x, z, radius) => {
    const depth = floorDepth(radius);
    const targetY = center.y - depth;

    for (let y = center.y - 6; y < targetY; y++) {
      dimension.setBlockType({ x, y, z }, solidBlock);
    }
    dimension.setBlockType({ x, y: targetY, z }, surfaceBlock);

    for (let y = targetY + 1; y < center.y; y++) {
      dimension.setBlockType({ x, y, z }, "minecraft:air");
    }

    const cover = depth > 0 ? coverBlock : surfaceBlock;
    dimension.setBlockType({ x, y: center.y, z }, cover);
  });
}

function setCollapseRadius(dimension, center, maxRadius) {
  forEachArenaColumn(center, (x, z, radius) => {
    if (radius <= maxRadius && floorDepth(radius) > 0) {
      dimension.setBlockType({ x, y: center.y, z }, "minecraft:air");
    }
  });
}

function spawnMaw(dimension, center) {
  const maw = dimension.spawnEntity(MAW_TYPE, {
    x: center.x + 0.5,
    y: center.y - 4.75,
    z: center.z + 0.5
  });
  maw.nameTag = "Demon Maw";
  return maw;
}

function findMaw(dimension, center) {
  return dimension.getEntities({
    type: MAW_TYPE,
    location: { x: center.x + 0.5, y: center.y - 3.5, z: center.z + 0.5 },
    maxDistance: 8
  })[0];
}

function resetDormantRuntime() {
  stateRuntime.lastCollapseStage = 0;
  stateRuntime.mawMissingSinceMs = 0;
  stateRuntime.activeAudioInitialized = false;
  stateRuntime.lastActiveSoundTick = -10000;
  stateRuntime.mawOpen = false;
  stateRuntime.mawStateInitialized = false;
  stateRuntime.playerInPit = false;
  stateRuntime.biteAudioActive = false;
  stateRuntime.lastBiteEatTick = -10000;
  stateRuntime.lastBiteGrowlTick = -10000;
  stateRuntime.pullStrengthMultiplier = 1;
  stateRuntime.nextPullStrengthTick = 0;
}

function createEncounter(dimension, center, options = {}) {
  const surfaceBlock = options.surfaceBlock ?? "minecraft:red_sand";
  const solidBlock = options.solidBlock ?? "minecraft:red_sandstone";
  const coverBlock = options.coverBlock ?? solidBlock;

  buildArena(dimension, center, surfaceBlock, solidBlock, coverBlock);
  spawnMaw(dimension, center);
  stateRuntime.state = {
    dimensionId: dimension.id,
    center,
    phase: "dormant",
    phaseStartedAtMs: Date.now(),
    stomachPrepared: false,
    natural: options.natural === true,
    surfaceBlock,
    solidBlock,
    coverBlock
  };
  resetDormantRuntime();
  stateRuntime.nextNaturalSpawnAtMs = 0;
  world.setDynamicProperty(NEXT_NATURAL_SPAWN_KEY, undefined);
  saveState();
}

function scheduleNextNaturalSpawn(minimumDelayMs, maximumDelayMs) {
  const delay = randomInteger(minimumDelayMs, maximumDelayMs);
  stateRuntime.nextNaturalSpawnAtMs = Date.now() + delay;
  world.setDynamicProperty(NEXT_NATURAL_SPAWN_KEY, stateRuntime.nextNaturalSpawnAtMs);
}

function loadNaturalSpawnSchedule() {
  if (stateRuntime.state) {
    stateRuntime.nextNaturalSpawnAtMs = 0;
    return;
  }

  const savedTime = world.getDynamicProperty(NEXT_NATURAL_SPAWN_KEY);
  if (typeof savedTime === "number" && Number.isFinite(savedTime)) {
    stateRuntime.nextNaturalSpawnAtMs = savedTime;
    return;
  }

  scheduleNextNaturalSpawn(NATURAL_SPAWN_MIN_MS, NATURAL_SPAWN_MAX_MS);
}

function naturalArenaPalette(surfaceBlock) {
  if (surfaceBlock === "minecraft:sand") {
    return {
      surfaceBlock,
      solidBlock: "minecraft:sandstone",
      coverBlock: "minecraft:sandstone"
    };
  }
  if (surfaceBlock === "minecraft:red_sand") {
    return {
      surfaceBlock,
      solidBlock: "minecraft:red_sandstone",
      coverBlock: "minecraft:red_sandstone"
    };
  }

  if (NATURAL_EARTH_BLOCKS.has(surfaceBlock)) {
    return { surfaceBlock, solidBlock: "minecraft:dirt", coverBlock: surfaceBlock };
  }

  if (surfaceBlock === "minecraft:mud" || surfaceBlock === "minecraft:packed_mud") {
    return { surfaceBlock, solidBlock: "minecraft:packed_mud", coverBlock: surfaceBlock };
  }

  if (NATURAL_ROCKY_BLOCKS.has(surfaceBlock)) {
    return { surfaceBlock, solidBlock: "minecraft:stone", coverBlock: surfaceBlock };
  }

  const isNaturalTerracotta = surfaceBlock === "minecraft:terracotta"
    || (surfaceBlock.endsWith("_terracotta") && !surfaceBlock.includes("glazed"));
  if (isNaturalTerracotta) {
    return { surfaceBlock, solidBlock: "minecraft:terracotta", coverBlock: surfaceBlock };
  }

  return undefined;
}

function naturalSurfaceAt(dimension, x, z) {
  const top = dimension.getTopmostBlock({ x, z });
  if (!top) return undefined;

  if (top.typeId === "minecraft:snow_layer" || top.typeId === "minecraft:snow") {
    const ground = dimension.getBlock({ x, y: top.y - 1, z });
    return ground && naturalArenaPalette(ground.typeId)
      ? { block: ground, snowCovered: true }
      : undefined;
  }

  return naturalArenaPalette(top.typeId)
    ? { block: top, snowCovered: false }
    : undefined;
}

function validateNaturalSpawnCandidate(player, x, z) {
  const dimension = player.dimension;
  const chunkProbe = { x, y: Math.floor(player.location.y), z };
  if (!dimension.isChunkLoaded(chunkProbe)) return undefined;

  const centerSurface = naturalSurfaceAt(dimension, x, z);
  if (!centerSurface) return undefined;
  const centerTop = centerSurface.block;
  const centerPalette = naturalArenaPalette(centerTop.typeId);
  if (!centerPalette) return undefined;

  const worldSpawn = world.getDefaultSpawnLocation();
  if (horizontalDistance({ x, z }, worldSpawn) < NATURAL_WORLD_SPAWN_EXCLUSION) {
    return undefined;
  }

  const nearbyPlayers = dimension.getPlayers({
    location: { x: x + 0.5, y: centerTop.y + 1, z: z + 0.5 },
    maxDistance: ARENA_RADIUS + 12
  });
  if (nearbyPlayers.length > 0) return undefined;

  const sampleOffsets = [
    [0, 0], [8, 0], [-8, 0], [0, 8], [0, -8],
    [6, 6], [6, -6], [-6, 6], [-6, -6]
  ];
  let minimumY = centerTop.y;
  let maximumY = centerTop.y;

  for (const [offsetX, offsetZ] of sampleOffsets) {
    const sampleX = x + offsetX;
    const sampleZ = z + offsetZ;
    if (!dimension.isChunkLoaded({ x: sampleX, y: centerTop.y, z: sampleZ })) return undefined;

    const sampleSurface = naturalSurfaceAt(dimension, sampleX, sampleZ);
    if (!sampleSurface) return undefined;
    const top = sampleSurface.block;
    minimumY = Math.min(minimumY, top.y);
    maximumY = Math.max(maximumY, top.y);
  }

  if (maximumY - minimumY > 2) return undefined;

  return {
    center: { x, y: maximumY, z },
    ...centerPalette
  };
}

function findNaturalSpawnCandidate(player, attempts = NATURAL_SPAWN_ATTEMPTS) {
  if (player.dimension.id !== "minecraft:overworld") return undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = NATURAL_SPAWN_MIN_DISTANCE
      + Math.random() * (NATURAL_SPAWN_MAX_DISTANCE - NATURAL_SPAWN_MIN_DISTANCE);
    const x = Math.floor(player.location.x + Math.cos(angle) * distance);
    const z = Math.floor(player.location.z + Math.sin(angle) * distance);

    try {
      const candidate = validateNaturalSpawnCandidate(player, x, z);
      if (candidate) return candidate;
    } catch {
      // Candidate chunks can unload while they are being inspected; try another point.
    }
  }

  return undefined;
}

function tryNaturalSpawnNear(player) {
  if (stateRuntime.state) return undefined;
  const candidate = findNaturalSpawnCandidate(player);
  if (!candidate) return undefined;

  createEncounter(player.dimension, candidate.center, {
    natural: true,
    surfaceBlock: candidate.surfaceBlock,
    solidBlock: candidate.solidBlock,
    coverBlock: candidate.coverBlock
  });
  log(`Natural encounter spawned in ${player.dimension.id} at ${candidate.center.x} ${candidate.center.y} ${candidate.center.z}.`);
  return candidate;
}

function updateNaturalSpawning() {
  if (stateRuntime.state) return;
  if (!stateRuntime.nextNaturalSpawnAtMs) {
    scheduleNextNaturalSpawn(NATURAL_SPAWN_MIN_MS, NATURAL_SPAWN_MAX_MS);
    return;
  }
  if (Date.now() < stateRuntime.nextNaturalSpawnAtMs) return;

  const players = world.getPlayers().filter(
    (player) => player.dimension.id === "minecraft:overworld" && isEligiblePlayer(player)
  );
  if (players.length === 0) {
    scheduleNextNaturalSpawn(NATURAL_RETRY_MIN_MS, NATURAL_RETRY_MAX_MS);
    return;
  }

  const player = players[randomInteger(0, players.length - 1)];
  try {
    if (!tryNaturalSpawnNear(player)) {
      scheduleNextNaturalSpawn(NATURAL_RETRY_MIN_MS, NATURAL_RETRY_MAX_MS);
      log("Natural spawn postponed: no loaded, mostly flat natural land surface was found.");
    }
  } catch (error) {
    reportError("creating a natural encounter", error);
    scheduleNextNaturalSpawn(NATURAL_RETRY_MIN_MS, NATURAL_RETRY_MAX_MS);
  }
}

function placeEncounter(player) {
  const dimension = player.dimension;
  const center = {
    x: Math.floor(player.location.x),
    y: Math.floor(player.location.y) - 1,
    z: Math.floor(player.location.z)
  };

  try {
    if (stateRuntime.state) {
      const oldDimension = getDimension(stateRuntime.state.dimensionId);
      if (oldDimension) {
        removeExistingMaws(oldDimension, stateRuntime.state.center);
      }
    }

    createEncounter(dimension, center);

    player.teleport(
      { x: center.x + 0.5, y: center.y + 1, z: center.z + ARENA_RADIUS - 0.5 },
      { dimension, rotation: { x: 15, y: 180 } }
    );
    player.sendMessage("§aDemon Maw test arena created.");
    player.sendMessage("§7Walk toward the center to begin the encounter.");
    player.sendMessage("§8Developer note: placement intentionally overwrites a 19×7×19 test area.");
    log(`Encounter placed at ${dimension.id} ${center.x} ${center.y} ${center.z}.`);
  } catch (error) {
    reportError("placing encounter", error);
    player.sendMessage(`§cCould not place Demon Maw: ${error}`);
  }
}

function resetEncounter(player) {
  const state = stateRuntime.state;
  if (!state) {
    player.sendMessage("§eNo Demon Maw encounter exists. Use /scriptevent mawofdespair:place");
    return;
  }

  const dimension = getDimension(state.dimensionId);
  if (!dimension) return;

  try {
    removeExistingMaws(dimension, state.center);
    buildArena(
      dimension,
      state.center,
      state.surfaceBlock,
      state.solidBlock,
      state.coverBlock
    );
    spawnMaw(dimension, state.center);
    state.phase = "dormant";
    state.phaseStartedAtMs = Date.now();
    state.stomachPrepared = false;
    delete state.stomachLayoutVersion;
    resetDormantRuntime();
    saveState();
    player.sendMessage("§aDemon Maw encounter reset.");
  } catch (error) {
    reportError("resetting encounter", error);
    player.sendMessage(`§cReset failed: ${error}`);
  }
}

function clearEncounter(player) {
  const state = stateRuntime.state;
  if (!state) {
    player.sendMessage("§eNo Demon Maw encounter exists.");
    return;
  }

  const dimension = getDimension(state.dimensionId);
  try {
    if (dimension) removeExistingMaws(dimension, state.center);
    stateRuntime.state = undefined;
    resetDormantRuntime();
    saveState();
    scheduleNextNaturalSpawn(NATURAL_SPAWN_MIN_MS, NATURAL_SPAWN_MAX_MS);
    player.sendMessage("§aDemon Maw encounter state cleared.");
    player.sendMessage("§8Developer note: modified terrain and any existing stomach room were not restored.");
  } catch (error) {
    reportError("clearing encounter state", error);
    player.sendMessage(`§cClear failed: ${error}`);
  }
}

function awakenMaw(dimension, state) {
  const maw = findMaw(dimension, state.center);
  try {
    maw?.triggerEvent("mawofdespair:awaken");
  } catch (error) {
    reportError("awakening maw", error);
  }
}

function startWarning(dimension, state) {
  state.phase = "warning";
  state.phaseStartedAtMs = Date.now();
  stateRuntime.lastCollapseStage = 0;
  stateRuntime.activeAudioInitialized = false;
  stateRuntime.lastActiveSoundTick = -10000;
  stateRuntime.mawOpen = false;
  stateRuntime.mawStateInitialized = false;
  stateRuntime.playerInPit = false;
  stateRuntime.biteAudioActive = false;
  stateRuntime.lastBiteEatTick = -10000;
  stateRuntime.lastBiteGrowlTick = -10000;
  stateRuntime.pullStrengthMultiplier = 1;
  stateRuntime.nextPullStrengthTick = 0;
  awakenMaw(dimension, state);
  saveState();

  playSound(dimension, "ambient.cave", state.center, 1.8, 0.55);
  for (const player of dimension.getPlayers({ location: state.center, maxDistance: 14 })) {
    sendTitle(player, "§4THE GROUND IS MOVING", "§cRun—or kill what waits below");
  }
}

function updateWarning(dimension, state) {
  const elapsed = Date.now() - state.phaseStartedAtMs;
  let stage = 0;
  if (elapsed >= 600) stage = 1;
  if (elapsed >= 1500) stage = 2;
  if (elapsed >= 2400) stage = 3;

  if (stage > stateRuntime.lastCollapseStage) {
    const radii = [0, 2.6, 5.0, 7.35];
    setCollapseRadius(dimension, state.center, radii[stage]);
    playSound(dimension, "dig.sand", state.center, 1.5, 0.7 + stage * 0.08);
    stateRuntime.lastCollapseStage = stage;
  }

  if (elapsed < WARNING_MS) return;

  setCollapseRadius(dimension, state.center, 7.35);
  state.phase = "active";
  state.phaseStartedAtMs = Date.now();
  saveState();
  playSound(dimension, "mob.enderdragon.growl", state.center, 1.35, 0.7);
  stateRuntime.activeAudioInitialized = true;
  stateRuntime.lastActiveSoundTick = system.currentTick;
  for (const player of dimension.getPlayers({ location: state.center, maxDistance: 14 })) {
    sendTitle(player, "§4DEMON MAW", "§7Defeat it before the pit consumes you");
  }
}

function pullPlayers(dimension, state) {
  const target = {
    x: state.center.x + 0.5,
    y: state.center.y - 4.2,
    z: state.center.z + 0.5
  };
  const activeSeconds = (Date.now() - state.phaseStartedAtMs) / 1000;
  const ramp = Math.min(activeSeconds / 16, 1);
  const healthMultiplier = getMawHealthPullMultiplier(dimension, state);

  for (const player of dimension.getPlayers({ location: state.center, maxDistance: PULL_RADIUS + 5 })) {
    if (!isEligiblePlayer(player)) continue;

    const horizontal = horizontalDistance(player.location, target);
    const vertical = Math.abs(player.location.y - target.y);
    if (horizontal > PULL_RADIUS || vertical > 10) continue;

    const dx = target.x - player.location.x;
    const dz = target.z - player.location.z;
    const baseStrength = 0.028 + ramp * 0.032 + (1 - horizontal / PULL_RADIUS) * 0.025;
    const combinedMultiplier = stateRuntime.pullStrengthMultiplier * healthMultiplier;
    const strength = baseStrength * combinedMultiplier;

    try {
      player.applyImpulse({
        x: horizontal > 0.01 ? (dx / horizontal) * strength : 0,
        y: (player.location.y > state.center.y - 1 ? -0.022 : -0.008)
          * Math.min(combinedMultiplier, 1.6),
        z: horizontal > 0.01 ? (dz / horizontal) * strength : 0
      });
    } catch (error) {
      reportError("applying pit pull", error);
    }

    // The old trigger sat below the top of the maw's collision box, so players
    // could stand on the creature without ever reaching the damage volume.
    if (horizontal <= BITE_RADIUS && player.location.y <= state.center.y - 1.2) {
      bitePlayer(player, target);
    }
  }
}

function getMawHealthPullMultiplier(dimension, state) {
  const maw = findMaw(dimension, state.center);
  const health = maw?.getComponent("minecraft:health");
  if (!health || health.effectiveMax <= 0) return 1;

  const healthRatio = Math.max(0, Math.min(1, health.currentValue / health.effectiveMax));
  return 1 + (1 - healthRatio) * (PULL_LOW_HEALTH_MAX_MULTIPLIER - 1);
}

function updateRandomPullStrength() {
  if (system.currentTick < stateRuntime.nextPullStrengthTick) return;

  stateRuntime.pullStrengthMultiplier = PULL_STRENGTH_MIN
    + Math.random() * (PULL_STRENGTH_MAX - PULL_STRENGTH_MIN);
  stateRuntime.nextPullStrengthTick = system.currentTick
    + randomInteger(PULL_SHIFT_MIN_TICKS, PULL_SHIFT_MAX_TICKS);
}

function pullTnt(dimension, state) {
  const target = {
    x: state.center.x + 0.5,
    y: state.center.y - 4.2,
    z: state.center.z + 0.5
  };
  const activeSeconds = (Date.now() - state.phaseStartedAtMs) / 1000;
  const ramp = Math.min(activeSeconds / 16, 1);

  for (const tnt of dimension.getEntities({
    type: "minecraft:tnt",
    location: state.center,
    maxDistance: PULL_RADIUS + 5
  })) {
    const horizontal = horizontalDistance(tnt.location, target);
    const vertical = Math.abs(tnt.location.y - target.y);
    if (horizontal > PULL_RADIUS || vertical > 10) continue;

    const dx = target.x - tnt.location.x;
    const dz = target.z - tnt.location.z;
    const strength = 0.06 + ramp * 0.055 + (1 - horizontal / PULL_RADIUS) * 0.04;

    try {
      tnt.applyImpulse({
        x: horizontal > 0.01 ? (dx / horizontal) * strength : 0,
        y: tnt.location.y > target.y ? -0.035 : 0,
        z: horizontal > 0.01 ? (dz / horizontal) * strength : 0
      });
    } catch (error) {
      reportError("applying pit pull to TNT", error);
    }
  }
}

function pullLivingEntities(dimension, state) {
  const target = {
    x: state.center.x + 0.5,
    y: state.center.y - 4.2,
    z: state.center.z + 0.5
  };
  const activeSeconds = (Date.now() - state.phaseStartedAtMs) / 1000;
  const ramp = Math.min(activeSeconds / 16, 1);

  const entities = dimension.getEntities({
    location: state.center,
    maxDistance: PULL_RADIUS + 5
  }).filter(isPullableLivingEntity);

  for (const entity of entities) {
    try {
      const horizontal = horizontalDistance(entity.location, target);
      const vertical = Math.abs(entity.location.y - target.y);
      if (horizontal > PULL_RADIUS || vertical > 10) continue;

      const dx = target.x - entity.location.x;
      const dz = target.z - entity.location.z;
      const strength = 0.04 + ramp * 0.04 + (1 - horizontal / PULL_RADIUS) * 0.03;

      entity.applyImpulse({
        x: horizontal > 0.01 ? (dx / horizontal) * strength : 0,
        y: entity.location.y > state.center.y - 1 ? -0.02 : -0.006,
        z: horizontal > 0.01 ? (dz / horizontal) * strength : 0
      });
    } catch (error) {
      reportError("applying pit pull to a living entity", error);
    }
  }

  damageLivingEntitiesInMouth(dimension, state, target, entities);
}

function isPlayerInsidePit(player, state) {
  return isEligiblePlayer(player) && isLocationInsidePit(player.location, state);
}

function isLocationInsidePit(location, state) {
  const pitCenter = { x: state.center.x + 0.5, z: state.center.z + 0.5 };
  const horizontal = Math.hypot(location.x - pitCenter.x, location.z - pitCenter.z);
  const minimumY = state.center.y - 6.5;
  const maximumY = state.center.y + 2.5;
  return horizontal <= PIT_RADIUS
    && location.y >= minimumY
    && location.y <= maximumY;
}

function isPullableLivingEntity(entity) {
  if (entity.typeId === MAW_TYPE
    || entity.typeId === "minecraft:player"
    || entity.typeId === "minecraft:armor_stand") return false;

  try {
    const health = entity.getComponent("minecraft:health");
    return health !== undefined && health.currentValue > 0;
  } catch {
    return false;
  }
}

function setMawOpen(dimension, state, shouldOpen) {
  if (stateRuntime.mawStateInitialized && stateRuntime.mawOpen === shouldOpen) return;

  const maw = findMaw(dimension, state.center);
  if (!maw) return;

  try {
    maw.triggerEvent(shouldOpen ? "mawofdespair:open" : "mawofdespair:close");
    stateRuntime.mawOpen = shouldOpen;
    stateRuntime.mawStateInitialized = true;
  } catch (error) {
    reportError(`setting maw ${shouldOpen ? "open" : "closed"}`, error);
  }
}

function updateMawVulnerability(dimension, state) {
  const playerInPit = dimension.getPlayers({ location: state.center, maxDistance: 12 })
    .some((player) => isPlayerInsidePit(player, state));
  const livingEntityInPit = dimension.getEntities({ location: state.center, maxDistance: 12 })
    .some((entity) => isPullableLivingEntity(entity) && isLocationInsidePit(entity.location, state));

  stateRuntime.playerInPit = playerInPit;
  setMawOpen(dimension, state, playerInPit || livingEntityInPit);
}

function bitePlayer(player, target) {
  const previousTick = stateRuntime.lastBiteTick.get(player.id) ?? -100;
  if (system.currentTick - previousTick < 20) return;
  stateRuntime.lastBiteTick.set(player.id, system.currentTick);

  try {
    player.applyDamage(BITE_DAMAGE);
    playSound(player.dimension, "mob.ravager.bite", target, 1.5, 0.65);
    sendTitle(player, "§4CONSUMED", "§7The maw claimed another adventurer");
  } catch (error) {
    reportError("biting player", error);
  }
}

function biteLivingEntity(entity) {
  const previousTick = stateRuntime.lastBiteTick.get(entity.id) ?? -100;
  if (system.currentTick - previousTick < 20) return false;
  stateRuntime.lastBiteTick.set(entity.id, system.currentTick);

  try {
    return entity.applyDamage(BITE_DAMAGE);
  } catch (error) {
    reportError("biting a living entity", error);
    return false;
  }
}

function damageLivingEntitiesInMouth(dimension, state, target, entities) {
  let damagedCount = 0;

  for (const entity of entities) {
    try {
      const horizontal = horizontalDistance(entity.location, target);
      const insideMouth = horizontal <= LIVING_BITE_RADIUS
        && entity.location.y <= state.center.y - 0.5
        && entity.location.y >= state.center.y - 6.5;
      if (insideMouth && biteLivingEntity(entity)) damagedCount++;
    } catch (error) {
      reportError("checking the living bite volume", error);
    }
  }

  if (damagedCount > 0) {
    playSound(dimension, "mob.ravager.bite", target, 1.25, 0.72);
  }
}

function stomachLocation(state) {
  return {
    // Keep the room directly beneath the encounter so the throat can connect
    // to it without teleportation or a separate dimension.
    x: state.center.x,
    y: Math.max(-40, Math.min(180, state.center.y - 48)),
    z: state.center.z
  };
}

function runCommand(dimension, command, context) {
  try {
    return dimension.runCommand(command);
  } catch (error) {
    reportError(`${context}: ${command}`, error);
    return undefined;
  }
}

function randomInteger(minimum, maximum) {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

function shuffledSlots(size) {
  const slots = Array.from({ length: size }, (_, index) => index);
  for (let index = slots.length - 1; index > 0; index--) {
    const swapIndex = randomInteger(0, index);
    [slots[index], slots[swapIndex]] = [slots[swapIndex], slots[index]];
  }
  return slots;
}

function fillStomachBarrel(dimension, location) {
  const block = dimension.getBlock(location);
  if (block?.typeId !== "minecraft:barrel") {
    throw new Error(`Expected a barrel at ${location.x} ${location.y} ${location.z}.`);
  }

  const inventory = block.getComponent("minecraft:inventory");
  const container = inventory?.container;
  if (!container) {
    throw new Error(`Barrel inventory was unavailable at ${location.x} ${location.y} ${location.z}.`);
  }

  container.clearAll();
  const rolledItems = STOMACH_LOOT
    .filter((entry) => Math.random() < entry.chance)
    .map((entry) => new ItemStack(entry.typeId, randomInteger(entry.min, entry.max)));
  if (rolledItems.length === 0) {
    rolledItems.push(new ItemStack("minecraft:iron_ingot", randomInteger(2, 7)));
  }
  const slots = shuffledSlots(container.size);

  for (let index = 0; index < rolledItems.length && index < slots.length; index++) {
    container.setItem(slots[index], rolledItems[index]);
  }

  return rolledItems.length;
}

function buildStomach(dimension, state) {
  const room = stomachLocation(state);
  const x = Math.floor(room.x);
  const y = Math.floor(room.y);
  const z = Math.floor(room.z);

  const commands = [
    `fill ${x - 8} ${y} ${z - 10} ${x + 8} ${y + 8} ${z + 10} minecraft:nether_wart_block`,
    `fill ${x - 7} ${y + 1} ${z - 9} ${x + 7} ${y + 7} ${z + 9} minecraft:air`,
    `fill ${x - 7} ${y} ${z - 9} ${x + 7} ${y} ${z + 9} minecraft:crimson_hyphae`,
    `setblock ${x - 5} ${y + 7} ${z - 6} minecraft:shroomlight`,
    `setblock ${x + 5} ${y + 7} ${z - 6} minecraft:shroomlight`,
    `setblock ${x - 5} ${y + 7} ${z + 6} minecraft:shroomlight`,
    `setblock ${x + 5} ${y + 7} ${z + 6} minecraft:shroomlight`,
    `setblock ${x - 4} ${y + 1} ${z + 2} minecraft:barrel`,
    `setblock ${x + 4} ${y + 1} ${z + 2} minecraft:barrel`,
    `setblock ${x} ${y + 1} ${z + 7} minecraft:barrel`
  ];

  for (const command of commands) {
    const result = runCommand(dimension, command, "building stomach");
    if (result === undefined) {
      throw new Error("The stomach room could not be generated in a loaded chunk.");
    }
  }

  // Validate an interior volume before connecting the physical access shaft.
  const floor = dimension.getBlock({ x, y, z: z - 6 });
  const feet = dimension.getBlock({ x, y: y + 1, z: z - 6 });
  const head = dimension.getBlock({ x, y: y + 2, z: z - 6 });
  if (floor?.typeId !== "minecraft:crimson_hyphae"
    || feet?.typeId !== "minecraft:air"
    || head?.typeId !== "minecraft:air") {
    throw new Error("Stomach interior validation failed; access construction was cancelled.");
  }

  const barrels = [
    { x: x - 4, y: y + 1, z: z + 2 },
    { x: x + 4, y: y + 1, z: z + 2 },
    { x, y: y + 1, z: z + 7 }
  ];
  const totalStacks = barrels.reduce(
    (total, location) => total + fillStomachBarrel(dimension, location),
    0
  );
  log(`Filled ${barrels.length} stomach barrels with ${totalStacks} item stacks.`);
}

function buildStomachAccess(dimension, state) {
  const room = stomachLocation(state);
  const x = Math.floor(room.x);
  const y = Math.floor(room.y);
  const z = Math.floor(room.z);
  const shaftBottomY = y + 1;
  const shaftTopY = state.center.y - 4;

  if (shaftTopY <= y + 8) {
    throw new Error("The arena is too low to build a stomach beneath the Maw.");
  }

  const commands = [
    `fill ${x - 2} ${y + 7} ${z - 2} ${x + 2} ${shaftTopY} ${z + 2} minecraft:nether_wart_block`,
    `fill ${x - 1} ${y + 7} ${z - 1} ${x + 1} ${shaftTopY} ${z + 1} minecraft:air`,
    `fill ${x} ${shaftBottomY} ${z + 2} ${x} ${shaftTopY} ${z + 2} minecraft:nether_wart_block`
  ];

  for (const command of commands) {
    const result = runCommand(dimension, command, "building stomach access");
    if (result === undefined) {
      throw new Error("The physical stomach access could not be generated.");
    }
  }

  const ladder = BlockPermutation.resolve("minecraft:ladder", { facing_direction: 2 });
  for (let ladderY = shaftBottomY; ladderY <= shaftTopY; ladderY++) {
    dimension.getBlock({ x, y: ladderY, z: z + 1 })?.setPermutation(ladder);
  }

  const bottomLadder = dimension.getBlock({ x, y: shaftBottomY, z: z + 1 });
  const topLadder = dimension.getBlock({ x, y: shaftTopY, z: z + 1 });
  if (bottomLadder?.typeId !== "minecraft:ladder" || topLadder?.typeId !== "minecraft:ladder") {
    throw new Error("The stomach ladder failed validation.");
  }
}

function prepareStomach(dimension, state) {
  if (state.stomachPrepared && state.stomachLayoutVersion === STOMACH_LAYOUT_VERSION) return;
  buildStomach(dimension, state);
  buildStomachAccess(dimension, state);
  state.stomachPrepared = true;
  state.stomachLayoutVersion = STOMACH_LAYOUT_VERSION;
  saveState();
}

function maintainActiveMaw(dimension, state) {
  const maw = findMaw(dimension, state.center);
  if (maw) {
    stateRuntime.mawMissingSinceMs = 0;
    return;
  }

  // Entities can be absent from queries briefly while their chunk is loading
  // after a world rejoin. Do not interpret that transient state as a death.
  if (!stateRuntime.mawMissingSinceMs) {
    stateRuntime.mawMissingSinceMs = Date.now();
    return;
  }

  if (Date.now() - stateRuntime.mawMissingSinceMs < MAW_RESTORE_DELAY_MS) return;

  try {
    const restoredMaw = spawnMaw(dimension, state.center);
    restoredMaw.triggerEvent("mawofdespair:awaken");
    stateRuntime.mawMissingSinceMs = 0;
    stateRuntime.mawStateInitialized = false;
    log("Restored an active Demon Maw after its chunk finished loading.");
  } catch (error) {
    stateRuntime.mawMissingSinceMs = Date.now();
    reportError("restoring active maw", error);
  }
}

function updateActiveAudio(dimension, state) {
  const nearbyPlayers = dimension.getPlayers({ location: state.center, maxDistance: 18 })
    .filter(isEligiblePlayer);
  if (nearbyPlayers.length === 0) return;

  // Runtime audio state is intentionally not persisted. On a fresh world load,
  // replay the growl once so an already-active encounter does not feel silent.
  if (!stateRuntime.activeAudioInitialized) {
    playSound(dimension, "mob.enderdragon.growl", state.center, 1.35, 0.7);
    stateRuntime.activeAudioInitialized = true;
    stateRuntime.lastActiveSoundTick = system.currentTick;
    return;
  }

  if (system.currentTick - stateRuntime.lastActiveSoundTick < ACTIVE_SOUND_INTERVAL_TICKS) return;
  playSound(dimension, "mob.warden.heartbeat", state.center, 1.1, 0.78);
  stateRuntime.lastActiveSoundTick = system.currentTick;
}

function updateBiteAudio(dimension, state) {
  if (!stateRuntime.mawOpen) {
    stateRuntime.biteAudioActive = false;
    return;
  }

  const mouth = {
    x: state.center.x + 0.5,
    y: state.center.y - 4.2,
    z: state.center.z + 0.5
  };

  if (!stateRuntime.biteAudioActive) {
    if (system.currentTick - stateRuntime.lastActiveSoundTick >= 20) {
      playSound(dimension, "mob.enderdragon.growl", mouth, 0.65, 0.6);
    }
    playSound(dimension, "random.eat", mouth, 1.35, 0.65);
    stateRuntime.biteAudioActive = true;
    stateRuntime.lastBiteEatTick = system.currentTick;
    stateRuntime.lastBiteGrowlTick = system.currentTick;
    return;
  }

  if (system.currentTick - stateRuntime.lastBiteEatTick >= BITE_EAT_INTERVAL_TICKS) {
    playSound(dimension, "random.eat", mouth, 1.35, 0.62 + Math.random() * 0.12);
    stateRuntime.lastBiteEatTick = system.currentTick;
  }

  if (system.currentTick - stateRuntime.lastBiteGrowlTick >= BITE_GROWL_INTERVAL_TICKS) {
    playSound(dimension, "mob.enderdragon.growl", mouth, 0.55, 0.58 + Math.random() * 0.08);
    stateRuntime.lastBiteGrowlTick = system.currentTick;
  }
}

function updateEncounter() {
  const state = stateRuntime.state;
  if (!state) {
    updateNaturalSpawning();
    return;
  }
  const dimension = getDimension(state.dimensionId);
  if (!dimension) return;

  try {
    if (state.phase === "dormant") {
      const triggerPoint = { x: state.center.x + 0.5, y: state.center.y + 1, z: state.center.z + 0.5 };
      const shouldTrigger = dimension.getPlayers({ location: triggerPoint, maxDistance: TRIGGER_RADIUS })
        .some((player) => isEligiblePlayer(player) && Math.abs(player.location.y - triggerPoint.y) < 4);
      if (shouldTrigger) startWarning(dimension, state);
    } else if (state.phase === "warning") {
      updateWarning(dimension, state);
    } else if (state.phase === "active") {
      maintainActiveMaw(dimension, state);
      updateMawVulnerability(dimension, state);
      updateBiteAudio(dimension, state);
      updateRandomPullStrength();
      pullPlayers(dimension, state);
      pullLivingEntities(dimension, state);
      pullTnt(dimension, state);
      updateActiveAudio(dimension, state);
    } else if (state.phase === "defeated") {
      prepareStomach(dimension, state);
    }
  } catch (error) {
    reportError("encounter tick", error);
  }
}

function handleMawDefeated(state, dimension) {
  if (state.phase === "defeated") return;
  stateRuntime.mawMissingSinceMs = 0;
  stateRuntime.activeAudioInitialized = false;
  stateRuntime.lastActiveSoundTick = -10000;
  stateRuntime.mawOpen = false;
  stateRuntime.mawStateInitialized = false;
  stateRuntime.playerInPit = false;
  stateRuntime.biteAudioActive = false;
  stateRuntime.lastBiteEatTick = -10000;
  stateRuntime.lastBiteGrowlTick = -10000;
  stateRuntime.pullStrengthMultiplier = 1;
  stateRuntime.nextPullStrengthTick = 0;
  state.phase = "defeated";
  state.phaseStartedAtMs = Date.now();
  state.stomachPrepared = false;
  delete state.stomachLayoutVersion;
  saveState();
  playSound(dimension, "mob.enderdragon.death", state.center, 1.1, 0.85);

  try {
    prepareStomach(dimension, state);
  } catch (error) {
    reportError("opening the physical stomach route", error);
  }

  for (const player of dimension.getPlayers({ location: state.center, maxDistance: 18 })) {
    sendTitle(player, "§aTHE PULL HAS STOPPED", "§6Climb down through its throat and claim the hoard");
    player.sendMessage("§eA physical passage has opened beneath the dead maw. The ladder also leads back out.");
  }
}

function handleScriptEvent(event) {
  if (!event.id.startsWith("mawofdespair:")) return;
  const player = event.sourceEntity;
  if (!player || player.typeId !== "minecraft:player") {
    log(`${event.id} requires a player source.`);
    return;
  }

  system.run(() => {
    switch (event.id) {
      case "mawofdespair:place":
        placeEncounter(player);
        break;
      case "mawofdespair:reset":
        resetEncounter(player);
        break;
      case "mawofdespair:clear":
        clearEncounter(player);
        break;
      case "mawofdespair:spawn": {
        if (stateRuntime.state) {
          player.sendMessage("§eA Demon Maw encounter already exists in this world.");
          break;
        }
        try {
          const candidate = tryNaturalSpawnNear(player);
          if (candidate) {
            player.sendMessage(`§aNatural Demon Maw spawned at ${candidate.center.x} ${candidate.center.y} ${candidate.center.z}.`);
            player.sendMessage("§7It was placed without teleporting you. Approach the coordinates to trigger it.");
          } else {
            player.sendMessage("§eNo suitable loaded location was found. Stand in a mostly flat natural area, at least 96 blocks from world spawn.");
          }
        } catch (error) {
          reportError("forcing a natural encounter", error);
          player.sendMessage(`§cNatural spawn failed: ${error}`);
        }
        break;
      }
      case "mawofdespair:trigger":
        if (stateRuntime.state?.phase === "dormant") {
          const dimension = getDimension(stateRuntime.state.dimensionId);
          if (dimension) startWarning(dimension, stateRuntime.state);
        } else {
          player.sendMessage("§eThe encounter is not dormant.");
        }
        break;
      case "mawofdespair:status":
        if (stateRuntime.state) {
          player.sendMessage(`§7Demon Maw ${ADDON_VERSION}: phase=§f${stateRuntime.state.phase}§7, location=§f${stateRuntime.state.center.x} ${stateRuntime.state.center.y} ${stateRuntime.state.center.z}§7, source=§f${stateRuntime.state.natural ? "natural" : "developer"}`);
        } else {
          const remainingSeconds = Math.max(
            0,
            Math.ceil((stateRuntime.nextNaturalSpawnAtMs - Date.now()) / 1000)
          );
          player.sendMessage(`§7Demon Maw ${ADDON_VERSION}: no encounter placed; next natural attempt in §f${remainingSeconds}s§7.`);
        }
        break;
      default:
        player.sendMessage("§7Commands: mawofdespair:place, spawn, reset, clear, trigger, status");
    }
  });
}

system.afterEvents.scriptEventReceive.subscribe(handleScriptEvent);

world.afterEvents.playerSpawn.subscribe((event) => {
  const playerId = event.player.id;
  stateRuntime.lastBiteTick.delete(playerId);
  stateRuntime.lastShieldHintTick.delete(playerId);

  system.runTimeout(() => {
    const state = stateRuntime.state;
    if (state?.phase !== "active") return;

    // Respawning replaces or reinitializes the player runtime entity. Force the
    // active encounter to recalculate its visual, damage, and audio state from
    // fresh player queries rather than carrying values from the dead instance.
    stateRuntime.playerInPit = false;
    stateRuntime.mawStateInitialized = false;
    stateRuntime.biteAudioActive = false;
    stateRuntime.activeAudioInitialized = false;
    stateRuntime.mawMissingSinceMs = 0;

    const dimension = getDimension(state.dimensionId);
    const maw = dimension ? findMaw(dimension, state.center) : undefined;
    try {
      maw?.triggerEvent("mawofdespair:awaken");
    } catch (error) {
      reportError("resynchronizing the maw after a player spawn", error);
    }
  }, 10);
});

world.beforeEvents.entityHurt.subscribe((event) => {
  if (event.hurtEntity.typeId !== MAW_TYPE) return;

  const state = stateRuntime.state;
  const isVulnerable = state?.phase === "active"
    && stateRuntime.mawStateInitialized
    && stateRuntime.playerInPit;
  if (isVulnerable) return;

  event.cancel = true;
  const attacker = event.damageSource.damagingEntity;
  if (attacker?.typeId !== "minecraft:player") return;

  const previousHintTick = stateRuntime.lastShieldHintTick.get(attacker.id) ?? -100;
  if (system.currentTick - previousHintTick < 40) return;
  stateRuntime.lastShieldHintTick.set(attacker.id, system.currentTick);

  const attackerId = attacker.id;
  system.run(() => {
    const player = world.getPlayers().find((candidate) => candidate.id === attackerId);
    if (!player) return;
    player.onScreenDisplay.setActionBar("§cThe sealed maw cannot be harmed. §7Enter the pit to force it open.");
  });
}, { entityFilter: { type: MAW_TYPE } });

world.beforeEvents.explosion.subscribe((event) => {
  const state = stateRuntime.state;
  const source = event.source;
  if (!state || source?.typeId !== "minecraft:tnt" || event.dimension.id !== state.dimensionId) return;

  const room = stomachLocation(state);
  const horizontal = horizontalDistance(source.location, {
    x: state.center.x + 0.5,
    z: state.center.z + 0.5
  });
  const insideEncounterHeight = source.location.y >= room.y - 3
    && source.location.y <= state.center.y + 12;

  if (horizontal <= ARENA_RADIUS + 4 && insideEncounterHeight) {
    // Removing impacted blocks preserves the blast and entity damage while
    // protecting the arena, throat, and stomach from terrain destruction.
    event.setImpactedBlocks([]);
  }
});

world.afterEvents.entityDie.subscribe((event) => {
  stateRuntime.lastBiteTick.delete(event.deadEntity.id);
  if (event.deadEntity.typeId !== MAW_TYPE || !stateRuntime.state) return;
  system.run(() => {
    const state = stateRuntime.state;
    const dimension = getDimension(state.dimensionId);
    if (dimension) handleMawDefeated(state, dimension);
  });
});

system.run(() => {
  loadState();
  loadNaturalSpawnSchedule();
  log(`Stable Script API loaded. Version ${ADDON_VERSION}.`);
});

system.runInterval(updateEncounter, TICK_INTERVAL);
