# Relay Design System kit (missing)

The spec expects `Relay_Design_System.zip` (Relay Design System v1.1, Neutral Edition)
unzipped here, with its guide, tokens and `marks/` directory. **It was not provided**, so,
as the spec instructs, this build uses the specified colour values and flags the missing
vector assets.

What exists instead:

- **Tokens:** `packages/ui/src/styles/relay-tokens.css` defines the neutral palette (Ink
  #141414, Porcelain, Graphite, silver #C4C5C3 and semantic roles) for light and dark themes,
  plus spacing, radius, type scale and motion tokens. Components only use semantic tokens.
- **Marks:** geometric stand-ins; see `packages/ui/src/marks/README.md` for the three places
  to replace when the kit arrives.
- **Typography:** the system sans stack (`--font-sans`), because no brand font files were supplied.

When the kit arrives: unzip it here, reconcile `relay-tokens.css` with the kit's token values
(keeping the semantic names), replace the marks, and check both themes against WCAG AA contrast.
