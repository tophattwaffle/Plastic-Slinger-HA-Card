// plastic-slinger-glance-card v1.0.0 — compact 2xX 16:9 active-print camera glance grid.
//
// Reads `sensor.plastic_slinger_active_prints` from the Plastic Slinger Home
// Assistant integration (`plastic_slinger`) and fetches camera snapshots through
// the integration's authenticated `/api/plastic_slinger/snapshot/<id>` endpoint
// via `hass.fetchWithAuth`, so it works natively in browsers and the Home
// Assistant Mobile Companion App over LAN, Nabu Casa, or reverse proxies without
// iframes or Ingress session cookies.
//
// Status accent colors (Printing, Complete, Paused, Failed) and tile sorting
// (Default vs. Completion Time) are configured in the Plastic Slinger app under
// Settings -> Printer status colors & active prints glance, and arrive in the
// sensor's `status_colors` and `printers` attributes automatically.
//
// Config:
//   entity:            sensor entity id (default "sensor.plastic_slinger_active_prints")
//   tap_url:           optional path or URL to open when tapping a printing/paused
//                      tile, e.g. "/printfarm" (supports "{printer_id}" placeholder;
//                      default null)
//   snapshot_interval: seconds between camera snapshot refreshes while visible
//                      (default 5, clamped 2..60)
//   columns:           grid columns, 1 or 2 (default 2)
//   show_empty:        show a compact "All printers idle" card when no tiles are
//                      active or held (default true; false collapses the card)

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DEFAULT_COLORS = {
  printing: "#8b4ce8",
  complete: "#1ca87a",
  paused: "#f37920",
  failed: "#e3342a",
};

class PlasticSlingerGlanceCard extends HTMLElement {
  constructor() {
    super();
    this._blobUrls = new Map();
    this._heldFetched = new Set();
    this._dismissedIds = new Set();
    this._timer = null;
    this._fetching = new Set();
    this._onVisChange = () => this._syncTimer();
  }

  setConfig(config) {
    const interval = Number(config?.snapshot_interval ?? 5);
    const cols = Number(config?.columns ?? 2);
    this._config = {
      entity: "sensor.plastic_slinger_active_prints",
      tap_url: null,
      show_empty: true,
      ...config,
      snapshot_interval: Number.isFinite(interval) ? Math.max(2, Math.min(60, interval)) : 5,
      columns: cols === 1 ? 1 : 2,
    };
    this._signature = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const stateObj = hass.states?.[this._config.entity];
    const sig = stateObj
      ? `${stateObj.state}|${stateObj.last_updated}|${JSON.stringify(stateObj.attributes?.printers ?? [])}|${JSON.stringify(stateObj.attributes?.status_colors ?? {})}`
      : "missing";
    if (sig !== this._signature) {
      this._signature = sig;
      // Clear optimistic dismissals for IDs no longer in the backend list
      const currentIds = new Set((stateObj?.attributes?.printers || []).map((p) => Number(p.id)));
      for (const id of [...this._dismissedIds]) {
        if (!currentIds.has(id)) this._dismissedIds.delete(id);
      }
      this._render();
      this._refreshSnapshots(false);
    }
  }

  getCardSize() {
    const printers = this._visiblePrinters();
    if (!printers.length) return this._config?.show_empty === false ? 0 : 1;
    return Math.ceil(printers.length / (this._config?.columns || 2)) * 2;
  }

  getGridOptions() {
    return { columns: 12, rows: "auto" };
  }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    document.addEventListener("visibilitychange", this._onVisChange);
    this._syncTimer();
    if (this._hass && this._config) {
      this._render();
      this._refreshSnapshots(true);
    }
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisChange);
    this._stopTimer();
    for (const url of this._blobUrls.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    this._blobUrls.clear();
    this._heldFetched.clear();
  }

  _syncTimer() {
    this._stopTimer();
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const ms = (this._config?.snapshot_interval || 5) * 1000;
    this._timer = setInterval(() => this._refreshSnapshots(true), ms);
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _visiblePrinters() {
    const stateObj = this._hass?.states?.[this._config?.entity];
    const raw = Array.isArray(stateObj?.attributes?.printers) ? stateObj.attributes.printers : [];
    return raw.filter((p) => p && !this._dismissedIds.has(Number(p.id)));
  }

  _statusColors() {
    const stateObj = this._hass?.states?.[this._config?.entity];
    const cc = stateObj?.attributes?.status_colors || {};
    return {
      printing: cc.printing || DEFAULT_COLORS.printing,
      complete: cc.complete || DEFAULT_COLORS.complete,
      paused: cc.paused || DEFAULT_COLORS.paused,
      failed: cc.failed || DEFAULT_COLORS.failed,
    };
  }

  _cameraTransform(p) {
    const parts = [];
    const rot = Number(p.camera_rotation || 0);
    if (rot === 90 || rot === 180 || rot === 270) parts.push(`rotate(${rot}deg)`);
    if (p.camera_flip_h) parts.push("scaleX(-1)");
    if (p.camera_flip_v) parts.push("scaleY(-1)");
    return parts.length ? parts.join(" ") : "none";
  }

  async _refreshSnapshots(isTick) {
    if (!this._hass || !this.shadowRoot) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

    const printers = this._visiblePrinters();
    const activeIds = new Set(printers.map((p) => Number(p.id)));

    // Clean up blob URLs for printers no longer shown
    for (const [id, url] of this._blobUrls.entries()) {
      if (!activeIds.has(id)) {
        try {
          URL.revokeObjectURL(url);
        } catch {}
        this._blobUrls.delete(id);
        this._heldFetched.delete(id);
      }
    }

    for (const p of printers) {
      const id = Number(p.id);
      if (!p.is_powered_off) {
        this._heldFetched.delete(id);
      }
      // If printer is powered off and we already fetched its held frame, keep showing it without re-polling
      if (p.is_powered_off && this._heldFetched.has(id) && this._blobUrls.has(id)) {
        continue;
      }
      if (!isTick && this._blobUrls.has(id)) {
        continue;
      }
      this._fetchOneSnapshot(id, Boolean(p.is_powered_off));
    }
  }

  async _fetchOneSnapshot(printerId, isPoweredOff) {
    if (this._fetching.has(printerId) || !this._hass) return;
    this._fetching.add(printerId);
    try {
      const resp = await this._hass.fetchWithAuth(
        `/api/plastic_slinger/snapshot/${printerId}?t=${Date.now()}`
      );
      if (!resp || !resp.ok) return;
      const blob = await resp.blob();
      if (!blob || blob.size === 0) return;

      const newUrl = URL.createObjectURL(blob);
      const oldUrl = this._blobUrls.get(printerId);
      this._blobUrls.set(printerId, newUrl);
      if (isPoweredOff) this._heldFetched.add(printerId);
      if (oldUrl) {
        try {
          URL.revokeObjectURL(oldUrl);
        } catch {}
      }

      if (this.shadowRoot) {
        const img = this.shadowRoot.querySelector(`img[data-printer-id="${printerId}"]`);
        if (img) {
          img.src = newUrl;
          img.classList.add("loaded");
        }
      }
    } catch {
      // Keep previous frame on transient error
    } finally {
      this._fetching.delete(printerId);
    }
  }

  async _dismissPrinter(printerId) {
    const id = Number(printerId);
    this._dismissedIds.add(id);
    this._render();
    try {
      await this._hass.callService("plastic_slinger", "dismiss_print", { printer_id: id });
    } catch {
      this._dismissedIds.delete(id);
      this._render();
    }
  }

  _openTapUrl(printerId) {
    const raw = this._config?.tap_url;
    if (!raw || typeof raw !== "string") return;
    const url = raw.replace(/\{printer_id\}/g, String(printerId));
    if (url.startsWith("/")) {
      history.pushState(null, "", url);
      window.dispatchEvent(new CustomEvent("location-changed", { composed: true }));
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const stateObj = this._hass?.states?.[this._config.entity];
    const colors = this._statusColors();
    const printers = this._visiblePrinters();
    const cols = this._config.columns || 2;

    if (stateObj && printers.length === 0 && this._config.show_empty === false) {
      this.shadowRoot.innerHTML = `<style>:host { display: none; }</style>`;
      return;
    }

    let bodyHtml = "";
    if (!stateObj) {
      bodyHtml = `
        <div class="empty">
          <span class="empty-title">Plastic Slinger</span>
          <span class="empty-sub">Waiting for <code>${esc(this._config.entity)}</code>…</span>
        </div>`;
    } else if (stateObj.state === "unavailable") {
      bodyHtml = `
        <div class="empty">
          <span class="empty-title">Plastic Slinger unreachable</span>
          <span class="empty-sub">Active prints will reappear automatically when the service responds.</span>
        </div>`;
    } else if (printers.length === 0) {
      bodyHtml = `
        <div class="empty">
          <span class="empty-title">All printers idle</span>
          <span class="empty-sub">Active, recently completed, and failed prints appear here automatically.</span>
        </div>`;
    } else {
      bodyHtml = `
        <div class="grid cols-${cols}">
          ${printers.map((p) => this._renderTile(p)).join("")}
        </div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          --glance-printing: ${esc(colors.printing)};
          --glance-complete: ${esc(colors.complete)};
          --glance-paused: ${esc(colors.paused)};
          --glance-failed: ${esc(colors.failed)};
          --ps-bg: #18181b;
          --ps-surface: #202024;
          --ps-elevated: #28282d;
          --ps-border: #34343b;
          --ps-text: #f4f4f6;
          --ps-muted: #9ca3af;
          font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
        }
        ha-card {
          background: transparent;
          border: none;
          box-shadow: none;
          padding: 0;
          color: var(--ps-text);
        }
        .empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 3px;
          padding: 14px 16px;
          border-radius: 10px;
          background: var(--ps-surface);
          border: 1px solid var(--ps-border);
          text-align: center;
        }
        .empty-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--ps-text);
        }
        .empty-sub {
          font-size: 11.5px;
          color: var(--ps-muted);
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .grid.cols-1 {
          grid-template-columns: minmax(0, 1fr);
        }
        .tile {
          position: relative;
          display: flex;
          flex-direction: column;
          border-radius: 10px;
          overflow: hidden;
          background: var(--ps-surface);
          border: 1.5px solid color-mix(in srgb, var(--tile-accent) 70%, var(--ps-border));
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
          user-select: none;
          -webkit-tap-highlight-color: transparent;
          transition: transform 0.12s ease, border-color 0.15s ease;
        }
        .tile.clickable {
          cursor: pointer;
        }
        .tile.clickable:active {
          transform: scale(0.988);
        }
        .tile.is-printing { --tile-accent: var(--glance-printing); }
        .tile.is-complete { --tile-accent: var(--glance-complete); }
        .tile.is-paused   { --tile-accent: var(--glance-paused); }
        .tile.is-failed   { --tile-accent: var(--glance-failed); }

        .head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 6px 8px;
          background: color-mix(in srgb, var(--tile-accent) 16%, var(--ps-elevated));
          border-bottom: 1px solid color-mix(in srgb, var(--tile-accent) 32%, var(--ps-border));
          min-width: 0;
        }
        .title-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          flex: 1;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex: none;
          background: var(--tile-accent);
          box-shadow: 0 0 6px var(--tile-accent);
        }
        .name {
          font-size: 12.5px;
          font-weight: 700;
          color: var(--ps-text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .head-right {
          display: flex;
          align-items: center;
          gap: 5px;
          flex: none;
        }
        .status {
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.04em;
          padding: 2px 6px;
          border-radius: 999px;
          color: #fff;
          background: color-mix(in srgb, var(--tile-accent) 82%, #000);
          border: 1px solid color-mix(in srgb, var(--tile-accent) 60%, #fff);
          line-height: 1.2;
        }
        .dismiss {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          margin: -2px -2px -2px 0;
          padding: 0;
          border-radius: 5px;
          border: 1px solid rgba(255, 255, 255, 0.22);
          background: rgba(0, 0, 0, 0.35);
          color: var(--ps-text);
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
          cursor: pointer;
        }
        .dismiss:hover {
          background: rgba(255, 255, 255, 0.16);
        }

        .cam {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          background-color: #121215;
          background-image:
            linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
          background-size: 16px 16px;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cam-placeholder {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.28);
          pointer-events: none;
        }
        .cam-img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          opacity: 0;
          transition: opacity 0.15s ease;
        }
        .cam-img.loaded {
          opacity: 1;
        }
        .cam-tag {
          position: absolute;
          bottom: 6px;
          right: 6px;
          padding: 2px 7px;
          border-radius: 6px;
          font-size: 10px;
          font-weight: 600;
          color: #e5e7eb;
          background: rgba(15, 15, 18, 0.82);
          border: 1px solid rgba(255, 255, 255, 0.16);
          backdrop-filter: blur(4px);
        }

        .foot {
          position: relative;
          height: 24px;
          background: var(--ps-bg);
          border-top: 1px solid var(--ps-border);
          overflow: hidden;
          display: flex;
          align-items: center;
        }
        .fill {
          position: absolute;
          inset: 0 auto 0 0;
          width: var(--progress, 0%);
          background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--tile-accent) 42%, transparent),
            color-mix(in srgb, var(--tile-accent) 68%, transparent)
          );
          border-right: 1.5px solid var(--tile-accent);
          transition: width 0.3s ease;
        }
        .foot-text {
          position: relative;
          z-index: 1;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 0 8px;
          font-size: 11px;
          line-height: 1;
        }
        .pct {
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          color: var(--ps-text);
        }
        .sub {
          font-weight: 600;
          color: #d1d5db;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      </style>
      <ha-card>${bodyHtml}</ha-card>`;

    this._bindEvents();
  }

  _renderTile(p) {
    const id = Number(p.id);
    const status = String(p.status || "printing").toLowerCase();
    const statusClass =
      status === "complete"
        ? "is-complete"
        : status === "paused"
          ? "is-paused"
          : status === "failed"
            ? "is-failed"
            : "is-printing";
    const prog = Math.max(0, Math.min(100, Number(p.progress_percent ?? 0)));
    const blobUrl = this._blobUrls.get(id) || "";
    const transform = this._cameraTransform(p);
    const canDismiss = Boolean(p.can_dismiss);
    const clickable = status === "complete" || Boolean(this._config?.tap_url);
    const title =
      status === "complete"
        ? `${p.name} · ${p.status_label || "COMPLETE"} · Tap to clear`
        : `${p.name} · ${p.status_label || ""}${p.file_name ? ` · ${p.file_name}` : ""}`;

    return `
      <div class="tile ${statusClass} ${clickable ? "clickable" : ""}"
           data-tile-id="${id}"
           data-tile-status="${esc(status)}"
           title="${esc(title)}">
        <div class="head">
          <div class="title-wrap">
            <span class="dot" aria-hidden="true"></span>
            <span class="name">${esc(p.name)}</span>
          </div>
          <div class="head-right">
            <span class="status">${esc(p.status_label || status.toUpperCase())}</span>
            ${
              canDismiss
                ? `<button type="button" class="dismiss" data-dismiss-id="${id}" title="Clear from glance" aria-label="Clear ${esc(p.name)}">×</button>`
                : ""
            }
          </div>
        </div>
        <div class="cam">
          <span class="cam-placeholder">${esc(p.machine_type || p.name)}</span>
          <img data-printer-id="${id}"
               class="cam-img ${blobUrl ? "loaded" : ""}"
               ${blobUrl ? `src="${esc(blobUrl)}"` : ""}
               alt="${esc(p.name)} camera"
               style="transform: ${esc(transform)}" />
          ${p.is_powered_off ? `<span class="cam-tag">Last frame · Off</span>` : ""}
        </div>
        <div class="foot" role="progressbar" aria-valuenow="${prog}" aria-valuemin="0" aria-valuemax="100">
          <div class="fill" style="--progress: ${prog}%"></div>
          <div class="foot-text">
            <span class="pct">${prog}%</span>
            <span class="sub">${esc(p.sub_text || "")}</span>
          </div>
        </div>
      </div>`;
  }

  _bindEvents() {
    if (!this.shadowRoot) return;
    for (const btn of this.shadowRoot.querySelectorAll("button[data-dismiss-id]")) {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._dismissPrinter(btn.dataset.dismissId);
      });
    }
    for (const tile of this.shadowRoot.querySelectorAll(".tile[data-tile-id]")) {
      tile.addEventListener("click", () => {
        const id = tile.dataset.tileId;
        const status = tile.dataset.tileStatus;
        if (status === "complete") {
          this._dismissPrinter(id);
        } else if (this._config?.tap_url) {
          this._openTapUrl(id);
        }
      });
    }
  }
}

customElements.define("plastic-slinger-glance-card", PlasticSlingerGlanceCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "plastic-slinger-glance-card",
  name: "Plastic Slinger Glance",
  description: "Compact 2-column 16:9 camera grid of active, paused, completed, and failed 3D prints.",
});
