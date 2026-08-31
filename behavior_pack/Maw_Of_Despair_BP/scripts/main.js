import { system, world } from "@minecraft/server";

const ADDON_NAME = "Maw of Despair";
const ADDON_VERSION = "0.2.0-dev";
const MAW_TYPE = "mawofdespair:demon_maw";
const STATE_KEY = "mawofdespair:encounter_state";
const RETURN_KEY = "mawofdespair:stomach_return";
const INSIDE_KEY = "mawofdespair:inside_stomach";

const ARENA_RADIUS = 9;
const TRIGGER_RADIUS = 6.5;
const PULL_RADIUS = 8.25;
const WARNING_MS = 3000;
const STOMACH_DURATION_MS = 120000;
const TICK_INTERVAL = 4;

const stateRuntime = {
  state: undefined,
  lastCollapseStage: 0,
  lastBiteTick: new Map(),
  portalCooldown: new Map()
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

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
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

function buildArena(dimension, center) {
  forEachArenaColumn(center, (x, z, radius) => {
    const depth = floorDepth(radius);
    const targetY = center.y - depth;

    for (let y = center.y - 6; y < targetY; y++) {
      dimension.setBlockType({ x, y, z }, "minecraft:red_sandstone");
    }
    dimension.setBlockType({ x, y: targetY, z }, "minecraft:red_sand");

    for (let y = targetY + 1; y < center.y; y++) {
      dimension.setBlockType({ x, y, z }, "minecraft:air");
    }

    const cover = depth > 0 ? "minecraft:red_sandstone" : "minecraft:red_sand";
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
      if (oldDimension) removeExistingMaws(oldDimension, stateRuntime.state.center);
    }

    buildArena(dimension, center);
    spawnMaw(dimension, center);
    stateRuntime.state = {
      dimensionId: dimension.id,
      center,
      phase: "dormant",
      phaseStartedAtMs: Date.now(),
      stomachPrepared: false,
      stomachEndsAtMs: 0
    };
    stateRuntime.lastCollapseStage = 0;
    saveState();

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
    buildArena(dimension, state.center);
    spawnMaw(dimension, state.center);
    state.phase = "dormant";
    state.phaseStartedAtMs = Date.now();
    state.stomachPrepared = false;
    state.stomachEndsAtMs = 0;
    delete state.warned_30;
    delete state.warned_10;
    stateRuntime.lastCollapseStage = 0;
    saveState();
    player.sendMessage("§aDemon Maw encounter reset.");
  } catch (error) {
    reportError("resetting encounter", error);
    player.sendMessage(`§cReset failed: ${error}`);
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

  for (const player of dimension.getPlayers({ location: state.center, maxDistance: PULL_RADIUS + 5 })) {
    if (!isEligiblePlayer(player) || player.getDynamicProperty(INSIDE_KEY) === true) continue;

    const horizontal = horizontalDistance(player.location, target);
    const vertical = Math.abs(player.location.y - target.y);
    if (horizontal > PULL_RADIUS || vertical > 10 || horizontal < 0.01) continue;

    const dx = target.x - player.location.x;
    const dz = target.z - player.location.z;
    const strength = 0.028 + ramp * 0.032 + (1 - horizontal / PULL_RADIUS) * 0.025;

    try {
      player.applyImpulse({
        x: (dx / horizontal) * strength,
        y: player.location.y > state.center.y - 1 ? -0.018 : -0.006,
        z: (dz / horizontal) * strength
      });
    } catch (error) {
      reportError("applying pit pull", error);
    }

    if (horizontal <= 1.25 && player.location.y <= state.center.y - 2.8) {
      bitePlayer(player, target);
    }
  }
}

function bitePlayer(player, target) {
  const previousTick = stateRuntime.lastBiteTick.get(player.id) ?? -100;
  if (system.currentTick - previousTick < 20) return;
  stateRuntime.lastBiteTick.set(player.id, system.currentTick);

  try {
    player.applyDamage(40);
    playSound(player.dimension, "mob.ravager.bite", target, 1.5, 0.65);
    sendTitle(player, "§4CONSUMED", "§7The maw claimed another adventurer");
  } catch (error) {
    reportError("biting player", error);
  }
}

function stomachLocation(state) {
  return {
    x: state.center.x + 48,
    y: Math.max(-40, Math.min(180, state.center.y - 48)),
    z: state.center.z + 48
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

  for (const command of commands) runCommand(dimension, command, "building stomach");

  const lootTable = '"loot_tables/chests/demon_maw_treasure.json"';
  runCommand(dimension, `loot insert ${x - 4} ${y + 1} ${z + 2} loot ${lootTable}`, "filling stomach treasure");
  runCommand(dimension, `loot insert ${x + 4} ${y + 1} ${z + 2} loot ${lootTable}`, "filling stomach treasure");
  runCommand(dimension, `loot insert ${x} ${y + 1} ${z + 7} loot ${lootTable}`, "filling stomach treasure");

  state.stomachPrepared = true;
  saveState();
}

function enterStomach(player, state) {
  const cooldown = stateRuntime.portalCooldown.get(player.id) ?? 0;
  if (system.currentTick < cooldown) return;
  stateRuntime.portalCooldown.set(player.id, system.currentTick + 40);

  const dimension = getDimension(state.dimensionId);
  if (!dimension) return;

  try {
    if (!state.stomachPrepared) buildStomach(dimension, state);

    const returnData = {
      dimensionId: state.dimensionId,
      location: {
        x: state.center.x + 0.5,
        y: state.center.y + 1,
        z: state.center.z + ARENA_RADIUS - 1
      },
      rotation: { x: 0, y: 180 }
    };
    player.setDynamicProperty(RETURN_KEY, JSON.stringify(returnData));
    player.setDynamicProperty(INSIDE_KEY, true);

    if (!state.stomachEndsAtMs || state.stomachEndsAtMs <= Date.now()) {
      state.stomachEndsAtMs = Date.now() + STOMACH_DURATION_MS;
      saveState();
    }

    const room = stomachLocation(state);
    player.teleport(
      { x: room.x + 0.5, y: room.y + 1, z: room.z - 7.5 },
      { dimension, rotation: { x: 0, y: 0 } }
    );
    sendTitle(player, "§4INSIDE THE BEAST", "§6Take what it could not digest—and escape in time");
    player.sendMessage("§eThe stomach will dissolve in two minutes.");
    player.sendMessage("§7Use §f/scriptevent mawofdespair:exit §7for the current prototype exit.");
    playSound(dimension, "portal.travel", room, 0.7, 0.55);
  } catch (error) {
    reportError("entering stomach", error);
    player.sendMessage(`§cCould not enter the stomach: ${error}`);
  }
}

function returnFromStomach(player, reason = "You escaped the dissolving stomach.") {
  const raw = player.getDynamicProperty(RETURN_KEY);
  let returned = false;

  if (typeof raw === "string") {
    try {
      const data = JSON.parse(raw);
      const dimension = getDimension(data.dimensionId);
      if (dimension) {
        player.teleport(data.location, { dimension, rotation: data.rotation });
        returned = true;
      }
    } catch (error) {
      reportError("returning player from stomach", error);
    }
  }

  if (!returned && stateRuntime.state) {
    const state = stateRuntime.state;
    const dimension = getDimension(state.dimensionId);
    if (dimension) {
      player.teleport(
        { x: state.center.x + 0.5, y: state.center.y + 2, z: state.center.z + ARENA_RADIUS },
        { dimension }
      );
    }
  }

  player.setDynamicProperty(INSIDE_KEY, false);
  player.setDynamicProperty(RETURN_KEY, undefined);
  player.sendMessage(`§a${reason}`);
}

function updateDefeatedPortal(dimension, state) {
  const throat = {
    x: state.center.x + 0.5,
    y: state.center.y - 4.2,
    z: state.center.z + 0.5
  };

  for (const player of dimension.getPlayers({ location: throat, maxDistance: 2.0 })) {
    if (!isEligiblePlayer(player) || player.getDynamicProperty(INSIDE_KEY) === true) continue;
    if (distanceSquared(player.location, throat) <= 3.6) enterStomach(player, state);
  }
}

function updateStomachTimer(state) {
  if (!state.stomachEndsAtMs) return;

  const remainingMs = state.stomachEndsAtMs - Date.now();
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const dimension = getDimension(state.dimensionId);
  if (!dimension) return;
  const room = stomachLocation(state);

  if (remainingMs <= 0) {
    for (const player of world.getPlayers()) {
      if (player.getDynamicProperty(INSIDE_KEY) !== true) continue;
      sendTitle(player, "§4THE STOMACH DISSOLVES", "§7The remains cast you back outside");
      returnFromStomach(player);
    }

    const x = Math.floor(room.x);
    const y = Math.floor(room.y);
    const z = Math.floor(room.z);
    runCommand(
      dimension,
      `fill ${x - 8} ${y} ${z - 10} ${x + 8} ${y + 8} ${z + 10} minecraft:air`,
      "dissolving stomach"
    );
    state.phase = "spent";
    state.stomachPrepared = false;
    state.stomachEndsAtMs = 0;
    saveState();
    return;
  }

  for (const player of dimension.getPlayers({ location: room, maxDistance: 18 })) {
    if (player.getDynamicProperty(INSIDE_KEY) !== true) continue;

    try {
      player.onScreenDisplay.setActionBar(`§6Stomach stability: §f${remainingSeconds}s`);
    } catch {
      // Cosmetic only.
    }

    if (remainingSeconds === 30 || remainingSeconds === 10) {
      const marker = `warned_${remainingSeconds}`;
      if (state[marker] !== true) {
        state[marker] = true;
        player.sendMessage(`§cThe stomach dissolves in ${remainingSeconds} seconds!`);
        playSound(dimension, "mob.warden.heartbeat", room, 1.2, 0.8);
        saveState();
      }
    }
  }
}

function updateEncounter() {
  const state = stateRuntime.state;
  if (!state) return;
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
      pullPlayers(dimension, state);
      if (!findMaw(dimension, state.center)) handleMawDefeated(state, dimension);
    } else if (state.phase === "defeated") {
      updateDefeatedPortal(dimension, state);
    }

    updateStomachTimer(state);
  } catch (error) {
    reportError("encounter tick", error);
  }
}

function handleMawDefeated(state, dimension) {
  if (state.phase === "defeated") return;
  state.phase = "defeated";
  state.phaseStartedAtMs = Date.now();
  saveState();
  playSound(dimension, "mob.enderdragon.death", state.center, 1.1, 0.85);

  for (const player of dimension.getPlayers({ location: state.center, maxDistance: 18 })) {
    sendTitle(player, "§aTHE PULL HAS STOPPED", "§6Descend through the throat and claim its hoard");
    player.sendMessage("§eThe dead maw's throat now leads into its stomach.");
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
      case "mawofdespair:trigger":
        if (stateRuntime.state?.phase === "dormant") {
          const dimension = getDimension(stateRuntime.state.dimensionId);
          if (dimension) startWarning(dimension, stateRuntime.state);
        } else {
          player.sendMessage("§eThe encounter is not dormant.");
        }
        break;
      case "mawofdespair:enter":
        if (stateRuntime.state?.phase === "defeated") enterStomach(player, stateRuntime.state);
        else player.sendMessage("§eDefeat the Demon Maw before entering its stomach.");
        break;
      case "mawofdespair:exit":
        if (player.getDynamicProperty(INSIDE_KEY) === true) returnFromStomach(player, "You escaped the stomach.");
        else player.sendMessage("§7You are not inside the Demon Maw.");
        break;
      case "mawofdespair:status":
        player.sendMessage(stateRuntime.state
          ? `§7Demon Maw ${ADDON_VERSION}: phase=§f${stateRuntime.state.phase}§7, location=§f${stateRuntime.state.center.x} ${stateRuntime.state.center.y} ${stateRuntime.state.center.z}`
          : `§7Demon Maw ${ADDON_VERSION}: no encounter placed.`);
        break;
      default:
        player.sendMessage("§7Commands: mawofdespair:place, reset, trigger, enter, exit, status");
    }
  });
}

system.afterEvents.scriptEventReceive.subscribe(handleScriptEvent);

world.afterEvents.entityDie.subscribe((event) => {
  if (event.deadEntity.typeId !== MAW_TYPE || !stateRuntime.state) return;
  system.run(() => {
    const state = stateRuntime.state;
    const dimension = getDimension(state.dimensionId);
    if (dimension) handleMawDefeated(state, dimension);
  });
});

world.afterEvents.playerSpawn.subscribe((event) => {
  system.run(() => {
    if (event.player.getDynamicProperty(INSIDE_KEY) === true) {
      const state = stateRuntime.state;
      if (!event.initialSpawn || !state || !state.stomachEndsAtMs || state.stomachEndsAtMs <= Date.now()) {
        returnFromStomach(event.player, "The safety system returned you from the dissolved stomach.");
      }
    }
  });
});

system.run(() => {
  loadState();
  log(`Stable Script API loaded. Version ${ADDON_VERSION}.`);
});

system.runInterval(updateEncounter, TICK_INTERVAL);
