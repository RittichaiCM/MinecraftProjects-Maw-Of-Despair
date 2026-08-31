# Demon Maw vertical-slice test

Use a disposable flat area. Placement intentionally overwrites a circular
19-by-7-block test volume around the player.

## Setup

1. Enable `Maw of Despair BP` and its required `Maw of Despair RP` in a test world.
2. Enable cheats. The implementation uses stable Script API 2.8.0.
3. Stand at the intended arena center and run:

   `/scriptevent mawofdespair:place`

4. The script moves the player to the rim. Walk toward the center.

## Expected loop

1. A three-second warning appears.
2. Three rings of the surface disappear and reveal a stepped pit.
3. The pull ramps up while the stationary Demon Maw remains alive.
4. Kill the 80-HP maw; the pull must stop immediately.
5. Descend into the center to enter the stomach.
6. Three barrels receive randomized loot.
7. The action bar counts down from 120 seconds.
8. At zero, every player inside returns to the arena and the generated stomach
   room is removed.

## Developer commands

- `/scriptevent mawofdespair:place` - create a new arena at the player.
- `/scriptevent mawofdespair:reset` - rebuild and reset the saved arena.
- `/scriptevent mawofdespair:trigger` - skip proximity activation.
- `/scriptevent mawofdespair:enter` - enter after defeating the maw.
- `/scriptevent mawofdespair:exit` - prototype manual stomach exit.
- `/scriptevent mawofdespair:status` - show saved phase and coordinates.

## Content Log checks

- Both packs load with no manifest dependency error.
- Script prints `Stable Script API loaded. Version 0.2.0-dev.`
- `mawofdespair:demon_maw` has a visible placeholder model and boss bar.
- No errors mention `setBlockType`, `applyImpulse`, dynamic properties, or loot.
- Each barrel contains loot; if empty, inspect the `/loot insert` syntax first.
- Reload once while dormant, active, defeated, and inside the stomach.

The current zombie-textured geometry is deliberately a placeholder. Replace the
geometry, texture, and animation files without changing the behavior identifier.
