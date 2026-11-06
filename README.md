# Plastic Slinger Glance Card

A Lovelace card for the [Plastic Slinger Home Assistant integration](https://github.com/TopHATTwaffle/Plastic-Slinger-HA):
renders a compact **2-column 16:9 camera glance grid** of active, paused, recently completed, and failed 3D prints with a
built-in **native printer control modal** (Pause, Resume, Cancel, Chamber Light, Auto-Unload, and 2D bed-map Skip Part),
without iframes or Ingress session cookies.

## Features

- **Works locally and remotely (Mobile Companion App / Nabu Casa / Cloudflare):** camera snapshots are fetched via
  `hass.fetchWithAuth('/api/plastic_slinger/snapshot/<id>')` into object URLs, so they load everywhere Home Assistant
  works.
- **Tap a printing or paused tile for native printer controls:** opens a popup modal right inside Home Assistant with:
  - Enlarged 16:9 camera feed (refreshing every 2 seconds while open) with live Nozzle / Bed / Chamber temperature pills and layer progress.
  - **Pause / Resume** and **Cancel** (with inline confirmation so stray taps never interrupt a print).
  - **Chamber Light** toggle button (`💡`) in the modal header when supported.
  - **Skip Part** (`EXCLUDE_OBJECT`) drawer with an interactive top-down **2D SVG bed map** and parts list for Klipper/Moonraker prints.
  - **Auto-Unload** toggle (`Don't unload` → `Unload once` → `Always unload`) for Moonraker printers with an unload macro.
- **Status accent colors & sort order from Plastic Slinger:** automatically uses the **Printing**, **Complete**,
  **Paused**, and **Failed** colors and **Default / Completion Time** sort order configured in Plastic Slinger under
  **Settings → Printer status colors & active prints glance**.
- **Held completed prints & powered-off frames:** completed prints stay on the card until tapped (or `×` is clicked) to
  call `plastic_slinger.dismiss_print`. When a completed printer has been powered off at its smart plug, its last
  captured camera frame stays displayed with a `Last frame · Off` badge and stops re-polling.
- **Visibility-aware:** pauses snapshot polling while the browser tab or companion app is in the background.

## Install

### HACS (recommended)

1. HACS → **⋮** (top right) → **Custom repositories**.
2. Add `https://github.com/TopHATTwaffle/Plastic-Slinger-HA-Card` with category **Dashboard**.
3. Install **Plastic Slinger Glance Card** — HACS registers the frontend resource automatically.

### Manual

Copy `plastic-slinger-glance-card.js` into your Home Assistant `config/www/` folder and add `/local/plastic-slinger-glance-card.js`
as a **JavaScript Module** under **Settings → Dashboards → ⋮ → Resources**.

## Usage

### Minimal

```yaml
type: custom:plastic-slinger-glance-card
```

### All options

```yaml
type: custom:plastic-slinger-glance-card
entity: sensor.plastic_slinger_active_prints
snapshot_interval: 5
columns: 2
show_empty: true
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `entity` | `sensor.plastic_slinger_active_prints` | The Active prints sensor from the `plastic_slinger` integration. |
| `snapshot_interval` | `5` | Seconds between camera snapshot refreshes while the dashboard is visible (`2`–`60`). |
| `columns` | `2` | Grid columns (`1` or `2`). |
| `show_empty` | `true` | When `false`, hides the card completely when no printers are active or held. |
| `tap_url` | *(none)* | Optional path or URL to open instead of the built-in control modal when tapping a printing/paused tile (supports `{printer_id}`). |
