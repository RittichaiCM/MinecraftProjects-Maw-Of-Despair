# Maw of Despair

An original Minecraft Bedrock survival-horror encounter Add-on by Rule12Game.

The ground collapses into a stepped sand pit and pulls adventurers toward a
subterranean maw. Killing the creature stops the pull and opens its throat as a
route into a temporary treasure-filled stomach.

## Development workflow

Edit the source packs in this repository. Minecraft reads the same folders
through junctions in `development_behavior_packs` and
`development_resource_packs`.

Current milestone: playable scripted vertical slice using a placeholder model.

See `behavior_pack/Maw_Of_Despair_BP/DEVELOPMENT_TEST.md` for the in-game test
flow and developer commands.

## Build a release

Run the following command from the repository root:

```powershell
npm run build
```

The script validates that the package and both manifest versions match, removes
development-only files, packages the behavior and resource packs, and writes a
single upload-ready `.mcaddon` file to `dist/`.
