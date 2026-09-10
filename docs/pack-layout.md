# Pack layout

Only edit these source directories:

- `behavior_pack/Maw_Of_Despair_BP`
- `resource_pack/Maw_Of_Despair_RP`

Minecraft reads the same directories through junctions in its `development_behavior_packs` and `development_resource_packs` folders.

## Planned Behavior Pack folders

- `entities/` — entity server definitions
- `spawn_rules/` — natural-spawn rules
- `loot_tables/entities/` — entity drops
- `items/` and `recipes/` — progression items
- `scripts/` — stable Script API systems only

## Planned Resource Pack folders

- `entity/` — client entity definitions
- `models/entity/` — geometries
- `textures/entity/` and `textures/items/` — original artwork
- `animations/` and `animation_controllers/` — state-driven animation
- `render_controllers/` — rendering rules
- `texts/` — English and Thai localization
