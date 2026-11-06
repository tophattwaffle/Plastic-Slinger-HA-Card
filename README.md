# Plastic Slinger Glance Card

A Home Assistant dashboard card (`custom:plastic-slinger-glance-card`) that shows active, paused, recently completed, and
failed 3D printers in a compact 2-column 16:9 camera grid. It reads the Active prints sensor (`sensor.plastic_slinger_active_prints`)
and authenticated camera snapshot proxy of the [Plastic Slinger integration](https://github.com/TopHATTwaffle/Plastic-Slinger-HA).

Because the card renders natively in the Lovelace DOM and fetches camera snapshots through Home Assistant's own
authenticated API (`hass.fetchWithAuth`), it works seamlessly in the Home Assistant Companion App over 5G+ / public
internet without iframes or Ingress session cookies.

All options are described at the top of `plastic-slinger-glance-card.js`.

## Install

**HACS:** add `https://github.com/TopHATTwaffle/Plastic-Slinger-HA-Card` in HACS → ⋮ → Custom repositories (category
*Dashboard*) and install **Plastic Slinger Glance Card** (HACS registers the dashboard resource automatically).

**Manually:** copy `plastic-slinger-glance-card.js` to Home Assistant's `config/www/` folder and add it as a dashboard
resource (`/local/plastic-slinger-glance-card.js?v=1.0.0`, type *JavaScript module*). Bump `?v=` on updates so browsers
load the new file.

## Use

```yaml
type: custom:plastic-slinger-glance-card
entity: sensor.plastic_slinger_active_prints
tap_url: /printfarm
grid_options:
  columns: full
```

### Options

| Option | Default | Description |
| :--- | :--- | :--- |
| `entity` | `sensor.plastic_slinger_active_prints` | The Active prints sensor from the Plastic Slinger integration. |
| `tap_url` | *(none)* | Optional path or URL to open when tapping an active/paused tile (e.g. `/printfarm` for your sidebar Ingress panel). Supports `{printer_id}` substitution. |
| `snapshot_interval` | `5` | Seconds between camera snapshot refreshes while the dashboard tab is visible (`2`–`60`). Pauses automatically when hidden or backgrounded. |
| `columns` | `2` | Number of grid columns (`1` or `2`). |
| `show_empty` | `true` | Show a compact *"All printers idle"* card when nothing is printing or waiting to be cleared (`false` collapses the card). |

### Status colors & sorting

Status accent colors (**Printing** defaulting to purple `#8b4ce8`, **Complete** `#1ca87a`, **Paused** `#f37920`, and
**Failed** `#e3342a`) and the tile sort order (**Default** vs. **Completion Time**) are configured in the Plastic Slinger
app under **Settings → Printer status colors & active prints glance** and pushed through the sensor's attributes
automatically.

### Completed prints & held camera frames

- **Hold until cleared:** Completed prints remain on the glance grid indefinitely until you tap the completed tile (or
  its `×` button) to clear it, or the printer's status changes (e.g. a new print starts).
- **Powered-off last frame:** When a completed printer powers off at its smart plug after cooling down, Plastic Slinger
  serves the last captured camera snapshot (`Last frame · Off`) so you can still see the finished part on the bed.
