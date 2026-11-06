# AGENTS.md

Guidance for AI coding agents (Claude Code, Antigravity, Codex and others) working in this repository.

This is the Home Assistant dashboard card (`custom:plastic-slinger-glance-card`, one JavaScript file) for the
self-hosted Plastic Slinger 3D print farm manager. It reads the Active prints sensor and authenticated snapshot proxy of
the [Plastic-Slinger-HA](https://github.com/TopHATTwaffle/Plastic-Slinger-HA) integration. The app, its design docs and
the one to-do list for the app, the integration and this card live in the app repository,
[Plastic-Slinger](https://github.com/TopHATTwaffle/Plastic-Slinger).

## Backlog and docs
- Open work for this card is tracked in the app repository's `docs/BACKLOG.md`, not here. When you add, finish or drop
  work on this card, update that file too (a PR in the app repository), as its `AGENTS.md` asks.
- Keep `README.md` and the options described at the top of `plastic-slinger-glance-card.js` true in the same PR as any
  change.
- Status colors and tile sorting are managed in the app (**Settings → Printer status colors & active prints glance**)
  and arrive in the sensor's `status_colors` and `printers` attributes; change coloring or sorting in the app, never here.

## Releases
- Bump the version in the first line of `plastic-slinger-glance-card.js` and tag the merge commit `vX.Y.Z`; HACS only
  offers an update for a new tag.

## Public repository
This repository is mirrored publicly on GitHub: never write personal names or emails, private hostnames or LAN
addresses, API keys, or real printer/job data into code, docs or commit messages.
