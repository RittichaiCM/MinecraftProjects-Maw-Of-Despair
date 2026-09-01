# Demon Maw vertical-slice test

Use a disposable flat area. Placement intentionally overwrites a circular
19-by-7-block test volume around the player.

## Setup

1. Enable `Maw of Despair BP` and its required `Maw of Despair RP` in a test world.
2. Enable cheats. The implementation uses stable Script API 2.8.0.
3. Stand at the intended arena center and run:

   `/scriptevent mawofdespair:place`

4. The script moves the player to the rim. Walk toward the center.

## Natural spawn

1. With no saved encounter, the world schedules one natural spawn attempt after 10-20 minutes.
2. Natural spawning can use any Overworld land biome when it finds a loaded, mostly flat natural surface.
3. Supported terrain includes grass/earth, sand, red sand, mud, stone, gravel, calcite, tuff, terracotta, and snow-covered supported ground. Water, lava, ice, tree canopies, and common constructed surfaces such as planks or bricks are rejected.
4. The center must be at least 96 blocks from world spawn and 40-64 blocks from the selected Survival player.
5. Only one encounter can exist in the world. A naturally placed dormant Maw remains until discovered.
6. To test the same placement checks immediately without teleporting, stand in a suitable biome and run:

   `/scriptevent mawofdespair:spawn`

7. Use `/scriptevent mawofdespair:status` to distinguish `source=natural` from `source=developer` and inspect the next-attempt timer.
8. In an existing disposable test world, run `/scriptevent mawofdespair:clear` before `spawn`. It clears state and the Maw entity but deliberately does not restore previously modified terrain.

## Expected loop

1. A three-second warning appears.
2. Three rings of the surface disappear and reveal a stepped pit.
3. The pull ramps up while the stationary Demon Maw remains alive.
4. Primed TNT is pulled into the pit but does not destroy encounter blocks.
5. Kill the 80-HP maw; the pull must stop immediately.
6. A physical throat opens below the dead maw.
7. Use its ladder to climb down into the stomach approximately 48 blocks below.
8. Three barrels receive randomized loot.
9. During the active fight, suction strength changes in irregular pulses and becomes progressively stronger as the Maw loses health.
10. Use the same ladder to climb back to the arena; there is no teleport or timer.
11. Die during the active encounter, respawn, and return to the arena. Suction, bite damage, animation state, and active audio resume without resetting the Maw's health.
12. Spawn several sheep, pigs, and chickens together. Every living entity inside the widened mouth volume takes bite damage independently once per second; one entity cannot block damage to the others.

## Developer commands

- `/scriptevent mawofdespair:place` - create a new arena at the player.
- `/scriptevent mawofdespair:spawn` - force a natural-placement attempt near the player.
- `/scriptevent mawofdespair:reset` - rebuild and reset the saved arena.
- `/scriptevent mawofdespair:clear` - clear the saved test encounter without restoring terrain.
- `/scriptevent mawofdespair:trigger` - skip proximity activation.
- `/scriptevent mawofdespair:status` - show saved phase and coordinates.
- Status reports the player's block location/current biome plus the existing Maw's saved location, biome, phase, and source.

## Content Log checks

- Both packs load with no manifest dependency error.
- Normal gameplay does not print development status messages to the Content Log.
- Genuine script failures still include a `[Maw of Despair]` error entry in the Content Log.
- `mawofdespair:demon_maw` has a visible placeholder model and boss bar.
- No errors mention `setBlockType`, `applyImpulse`, dynamic properties, or loot.
- Each barrel receives an independent randomized loot roll through the Stable Script API; Beta APIs are not required.
- Reload once while dormant, active, defeated, and physically inside the stomach.

The current zombie-textured geometry is deliberately a placeholder. Replace the
geometry, texture, and animation files without changing the behavior identifier.
