# Bandait Design System v3.0 (Grafito)

## Philosophy
Grafito (2026-10-30): readable, never glaring. Very dark grey instead of pure black, softened white and desaturated accents, minimum cognitive load. Built for dark stages, tired eyes and sweaty hands. It replaces v2.0 "OLED Noir & Neon", whose pure cyan and lime on pure black (16:1 to 19:1) caused halation.

## Tokens
See `tokens.json` for the canonical source of truth. Both QSS (Leader) and CSS (Follower) consume these values.

## Mode Rules
- **Stage Mode**: bg-primary only. No cards, no chrome. Full immersion.
- **Library/Leader Mode**: bg-surface and bg-elevated permitted for hierarchy.
- **Emergency**: Slide-to-Stop only. No tap targets for critical actions.

## Typography
- UI: Inter (weights 400, 500, 700)
- Numbers / BPM / Timecodes: JetBrains Mono Bold (weights 400, 700)

## Accessibility
- Network health uses color + shape for daltonism.
- All text meets WCAG AA or better against bg-primary; no pair goes above ~14:1.
- Text on an accent fill uses `on-accent` (accents are light).
