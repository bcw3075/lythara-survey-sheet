# Lythara Survey Sheet

A Foundry VTT v14 module that builds a detailed overland scene from a Survey Sheet: generated land from a seed and painted terrain, places as map notes, and a link for sending changes in and reading them back.

**Status:** early test version.

## Install
In Foundry, go to Add-on Modules, then Install Module, and paste this manifest URL:

`https://raw.githubusercontent.com/bcw3075/lythara-survey-sheet/main/module.json`

More Pin Options is recommended for pin labels and shadows.

## Sheets
Each sheet is a scene named for its region, kept in the **Overland Sheets** folder and off the navigation bar unless the world setting "Show sheets in the navigation bar" is on. Where sheets meet, the module draws a half-mile strip along the shared edge (a region with a Teleport Token behaviour) that carries tokens onto the next sheet at the same place in the world, with a short fade. "Link sheets at their edges" in the Survey Sheet window rebuilds the strips; making or deleting a sheet does it too.

The PF2e party actor's token is the party's position at both scales. On the World Map it is the marker; on a sheet it travels with the characters. Move it (or a member) on a sheet, or cross a gate, and the World Map marker is placed at the same spot in the world. Drag the marker on the World Map onto ground a sheet covers and the party token and members move there in formation, changing sheet if they have to; their players are pulled along. The party token is on every sheet whose ground holds the party's spot (sheets overlap), and on no other; a new sheet gets it if the marker is inside.

## Developing
How the code works and why: [docs/DEVELOPING.md](docs/DEVELOPING.md).
