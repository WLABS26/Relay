# Relay marks (stand-ins)

`Relay_Design_System.zip` was not supplied with this build, so the custom Relay wordmark and
the silver R tile from the kit's `marks/` directory are **missing**. Everything below is a
geometric stand-in drawn for development only:

- `relay-r-tile.svg`: silver (#C4C5C3) rounded tile with an Ink (#141414) "R".
- `relay-wordmark.svg`: the tile plus "Relay" set in the system sans.

These files are reference copies. The app renders the marks inline and uses a favicon, so
replacing them means updating three places before any external use:

1. `RTile` and `Wordmark` in `packages/ui/src/components/primitives.tsx` (inline SVG).
2. `apps/web/public/icon.svg` (favicon).
3. The two SVG files in this directory.
