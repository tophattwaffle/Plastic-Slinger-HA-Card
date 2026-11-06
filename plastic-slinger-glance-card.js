// plastic-slinger-glance-card v1.1.0 — compact 2xX 16:9 active-print camera glance grid
// with native popup printer control modal (Pause, Resume, Cancel, Chamber Light,
// Auto-Unload, and 2D bed-map Skip Part).
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
//   tap_url:           optional path or URL to open instead of the built-in control modal
//                      when tapping a printing/paused tile (default null -> opens modal)
//   snapshot_interval: seconds between camera snapshot refreshes while visible
//                      (default 5, clamped 2..60; modal refreshes active printer every 2s)
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

const NEXT_UNLOAD_MODE = {
  off: "once",
  once: "always",
  always: "off",
};

class PlasticSlingerGlanceCard extends HTMLElement {
  constructor() {
    super();
    this._blobUrls = new Map();
    this._heldFetched = new Set();
    this._dismissedIds = new Set();
    this._optimistic = new Map();
    this._timer = null;
    this._modalTimer = null;
    this._fetching = new Set();
    this._modalPrinterId = null;
    this._modalConfirm = null;
    this._modalSkipOpen = false;
    this._modalSkipSelected = new Set();
    this._modalBusy = false;
    this._modalNotice = null;
    this._onVisChange = () => {
      this._syncTimer();
      this._syncModalTimer();
    };
    this._onKeyDown = (ev) => {
      if (ev.key === "Escape" && this._modalPrinterId != null) {
        this._closeModal();
      }
    };
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
      const currentIds = new Set((stateObj?.attributes?.printers || []).map((p) => Number(p.id)));
      for (const id of [...this._dismissedIds]) {
        if (!currentIds.has(id)) this._dismissedIds.delete(id);
      }
      // Clear optimistic overrides once fresh state arrives
      this._optimistic.clear();
      if (this._modalPrinterId != null && !currentIds.has(this._modalPrinterId)) {
        this._closeModal(false);
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
    document.addEventListener("keydown", this._onKeyDown);
    this._syncTimer();
    this._syncModalTimer();
    if (this._hass && this._config) {
      this._render();
      this._refreshSnapshots(true);
    }
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisChange);
    document.removeEventListener("keydown", this._onKeyDown);
    this._stopTimer();
    this._stopModalTimer();
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

  _syncModalTimer() {
    this._stopModalTimer();
    if (this._modalPrinterId == null) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    this._modalTimer = setInterval(() => {
      if (this._modalPrinterId != null) {
        const p = this._visiblePrinters().find((x) => Number(x.id) === this._modalPrinterId);
        if (p && !p.is_powered_off) {
          this._fetchOneSnapshot(this._modalPrinterId, false);
        }
      }
    }, 2000);
  }

  _stopModalTimer() {
    if (this._modalTimer) {
      clearInterval(this._modalTimer);
      this._modalTimer = null;
    }
  }

  _visiblePrinters() {
    const stateObj = this._hass?.states?.[this._config?.entity];
    const raw = Array.isArray(stateObj?.attributes?.printers) ? stateObj.attributes.printers : [];
    return raw
      .filter((p) => p && !this._dismissedIds.has(Number(p.id)))
      .map((p) => {
        const ov = this._optimistic.get(Number(p.id));
        return ov ? { ...p, ...ov } : p;
      });
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
        for (const img of this.shadowRoot.querySelectorAll(`img[data-printer-id="${printerId}"]`)) {
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
    if (this._modalPrinterId === id) this._closeModal(false);
    this._render();
    try {
      await this._hass.callService("plastic_slinger", "dismiss_print", { printer_id: id });
    } catch {
      this._dismissedIds.delete(id);
      this._render();
    }
  }

  _openModal(printerId) {
    const id = Number(printerId);
    this._modalPrinterId = id;
    this._modalConfirm = null;
    this._modalSkipOpen = false;
    this._modalSkipSelected = new Set();
    this._modalBusy = false;
    this._modalNotice = null;
    this._syncModalTimer();
    this._render();
    this._fetchOneSnapshot(id, false);
  }

  _closeModal(shouldRender = true) {
    this._modalPrinterId = null;
    this._modalConfirm = null;
    this._modalSkipOpen = false;
    this._modalSkipSelected.clear();
    this._modalBusy = false;
    this._modalNotice = null;
    this._stopModalTimer();
    if (shouldRender) this._render();
  }

  _setOptimistic(printerId, patch) {
    const id = Number(printerId);
    const prev = this._optimistic.get(id) || {};
    this._optimistic.set(id, { ...prev, ...patch });
  }

  async _callControlService(service, data, optimisticPatch = null, successNotice = null) {
    if (!this._hass || this._modalBusy) return;
    const id = Number(data.printer_id);
    this._modalBusy = true;
    this._modalConfirm = null;
    this._modalNotice = null;
    if (optimisticPatch) {
      this._setOptimistic(id, optimisticPatch);
    }
    this._render();
    try {
      await this._hass.callService("plastic_slinger", service, data);
      if (successNotice) {
        this._modalNotice = { kind: "ok", text: successNotice };
      }
    } catch (err) {
      this._optimistic.delete(id);
      this._modalNotice = {
        kind: "err",
        text: err?.message || `Command ${service} failed.`,
      };
    } finally {
      this._modalBusy = false;
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

  _formatEta(remainingSeconds) {
    const sec = Number(remainingSeconds);
    if (!Number.isFinite(sec) || sec <= 0) return "";
    const eta = new Date(Date.now() + sec * 1000);
    return eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

    const modalPrinter =
      this._modalPrinterId != null
        ? printers.find((p) => Number(p.id) === this._modalPrinterId) || null
        : null;
    const modalHtml = modalPrinter ? this._renderModal(modalPrinter) : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          --glance-printing: ${esc(colors.printing)};
          --glance-complete: ${esc(colors.complete)};
          --glance-paused: ${esc(colors.paused)};
          --glance-failed: ${esc(colors.failed)};
          --ps-teal: #14967f;
          --ps-teal-bright: #2dd4bf;
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
        .tile.is-printing, .modal-card.is-printing { --tile-accent: var(--glance-printing); }
        .tile.is-complete, .modal-card.is-complete { --tile-accent: var(--glance-complete); }
        .tile.is-paused,   .modal-card.is-paused   { --tile-accent: var(--glance-paused); }
        .tile.is-failed,   .modal-card.is-failed   { --tile-accent: var(--glance-failed); }

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

        /* Native Printer Control Modal */
        .modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(9, 9, 12, 0.82);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 14px;
          box-sizing: border-box;
        }
        .modal-card {
          width: 100%;
          max-width: 580px;
          max-height: calc(100vh - 28px);
          overflow-y: auto;
          background: var(--ps-surface);
          border: 1.5px solid color-mix(in srgb, var(--tile-accent) 75%, var(--ps-border));
          border-radius: 14px;
          box-shadow: 0 18px 48px rgba(0, 0, 0, 0.72);
          display: flex;
          flex-direction: column;
          color: var(--ps-text);
        }
        .modal-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          background: color-mix(in srgb, var(--tile-accent) 18%, var(--ps-elevated));
          border-bottom: 1px solid color-mix(in srgb, var(--tile-accent) 35%, var(--ps-border));
        }
        .modal-title-group {
          display: flex;
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
          min-width: 0;
        }
        .modal-name {
          font-size: 15px;
          font-weight: 800;
          color: var(--ps-text);
        }
        .modal-badge {
          font-size: 10.5px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.14);
          color: #d1d5db;
        }
        .modal-head-btns {
          display: flex;
          align-items: center;
          gap: 6px;
          flex: none;
        }
        .icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: 1px solid var(--ps-border);
          background: var(--ps-bg);
          color: var(--ps-text);
          font-size: 15px;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .icon-btn:hover {
          background: var(--ps-elevated);
        }
        .icon-btn.light-on {
          background: rgba(245, 158, 11, 0.22);
          border-color: #f59e0b;
          color: #fde68a;
          box-shadow: 0 0 10px rgba(245, 158, 11, 0.35);
        }
        .temp-overlay {
          position: absolute;
          top: 8px;
          left: 8px;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          z-index: 2;
          pointer-events: none;
        }
        .temp-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 8px;
          border-radius: 7px;
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          background: rgba(15, 15, 18, 0.84);
          border: 1px solid rgba(255, 255, 255, 0.16);
          color: var(--ps-text);
          backdrop-filter: blur(4px);
        }
        .temp-pill.heating {
          border-color: rgba(249, 115, 22, 0.65);
        }
        .temp-label {
          color: var(--ps-muted);
          font-weight: 600;
        }
        .layer-pill {
          position: absolute;
          top: 8px;
          right: 8px;
          padding: 3px 8px;
          border-radius: 7px;
          font-size: 11px;
          font-weight: 700;
          background: rgba(15, 15, 18, 0.84);
          border: 1px solid rgba(255, 255, 255, 0.16);
          color: #e5e7eb;
          z-index: 2;
        }
        .modal-progress {
          position: relative;
          min-height: 32px;
          background: var(--ps-bg);
          border-top: 1px solid var(--ps-border);
          border-bottom: 1px solid var(--ps-border);
          overflow: hidden;
          display: flex;
          align-items: center;
        }
        .modal-progress-text {
          position: relative;
          z-index: 1;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 6px 12px;
          font-size: 12px;
        }
        .modal-file {
          font-weight: 600;
          color: var(--ps-text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
          flex: 1;
        }
        .modal-eta {
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: #e5e7eb;
          flex: none;
        }
        .modal-deck {
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: var(--ps-surface);
        }
        .action-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
          gap: 8px;
        }
        .pill-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 36px;
          padding: 0 12px;
          border-radius: 8px;
          border: 1px solid var(--ps-border);
          background: var(--ps-elevated);
          color: var(--ps-text);
          font-size: 12.5px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .pill-btn:hover:not(:disabled) {
          background: #323238;
        }
        .pill-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .pill-btn.warn {
          background: rgba(243, 121, 32, 0.16);
          border-color: rgba(243, 121, 32, 0.55);
          color: #fdba74;
        }
        .pill-btn.ok {
          background: rgba(28, 168, 122, 0.18);
          border-color: rgba(28, 168, 122, 0.6);
          color: #6ee7b7;
        }
        .pill-btn.danger {
          background: rgba(227, 52, 42, 0.16);
          border-color: rgba(227, 52, 42, 0.55);
          color: #fca5a5;
        }
        .pill-btn.active-once {
          background: rgba(20, 150, 127, 0.22);
          border-color: var(--ps-teal-bright);
          color: var(--ps-teal-bright);
        }
        .pill-btn.active-always {
          background: rgba(139, 76, 232, 0.22);
          border-color: #a855f7;
          color: #d8b4fe;
        }
        .confirm-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 8px;
          padding: 9px 11px;
          border-radius: 9px;
          background: rgba(227, 52, 42, 0.12);
          border: 1px solid rgba(227, 52, 42, 0.45);
          font-size: 12.5px;
        }
        .confirm-bar.warn {
          background: rgba(243, 121, 32, 0.12);
          border-color: rgba(243, 121, 32, 0.45);
        }
        .confirm-btns {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .notice-bar {
          padding: 7px 10px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
        }
        .notice-bar.ok {
          background: rgba(28, 168, 122, 0.15);
          border: 1px solid rgba(28, 168, 122, 0.5);
          color: #6ee7b7;
        }
        .notice-bar.err {
          background: rgba(227, 52, 42, 0.15);
          border: 1px solid rgba(227, 52, 42, 0.5);
          color: #fca5a5;
        }

        /* Skip Part Drawer (2D SVG Bed Map + Parts List) */
        .skip-drawer {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 10px;
          border-radius: 10px;
          background: var(--ps-bg);
          border: 1px solid var(--ps-border);
        }
        .skip-grid {
          display: grid;
          grid-template-columns: 180px 1fr;
          gap: 10px;
          align-items: stretch;
        }
        @media (max-width: 480px) {
          .skip-grid {
            grid-template-columns: 1fr;
          }
        }
        .skip-map {
          width: 100%;
          aspect-ratio: 1 / 1;
          background: #121215;
          border: 1px solid var(--ps-border);
          border-radius: 8px;
        }
        .skip-bed {
          fill: #18181c;
          stroke: #34343b;
          stroke-width: 1.5;
        }
        .skip-part {
          fill: rgba(45, 212, 191, 0.25);
          stroke: #2dd4bf;
          stroke-width: 1.5;
          cursor: pointer;
          transition: fill 0.12s ease;
        }
        .skip-part.is-current {
          fill: rgba(139, 76, 232, 0.38);
          stroke: #a855f7;
        }
        .skip-part.is-selected {
          fill: rgba(227, 52, 42, 0.45);
          stroke: #f87171;
        }
        .skip-part.is-excluded {
          fill: rgba(107, 114, 128, 0.18);
          stroke: #4b5563;
          cursor: default;
        }
        .skip-list {
          display: flex;
          flex-direction: column;
          gap: 5px;
          max-height: 180px;
          overflow-y: auto;
        }
        .skip-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 6px 9px;
          border-radius: 7px;
          border: 1px solid var(--ps-border);
          background: var(--ps-surface);
          color: var(--ps-text);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
        }
        .skip-item.is-selected {
          border-color: #f87171;
          background: rgba(227, 52, 42, 0.16);
        }
        .skip-item.is-excluded {
          opacity: 0.48;
          text-decoration: line-through;
          cursor: default;
        }
        .skip-tag {
          font-size: 10px;
          font-weight: 700;
          padding: 1px 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.1);
          color: #d1d5db;
          flex: none;
        }
        .skip-tag.now {
          background: rgba(45, 212, 191, 0.2);
          color: #2dd4bf;
        }
      </style>
      <ha-card>${bodyHtml}</ha-card>
      ${modalHtml}`;

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
    const isControllable = status === "printing" || status === "paused";
    const clickable = status === "complete" || isControllable || Boolean(this._config?.tap_url);
    const title =
      status === "complete"
        ? `${p.name} · ${p.status_label || "COMPLETE"} · Tap to clear`
        : isControllable
          ? `${p.name} · ${p.status_label || ""} · Tap for printer controls`
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

  _renderModal(p) {
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
    const etaStr = this._formatEta(p.remaining_seconds);
    const rightProgressText = `${prog}% · ${p.sub_text || ""}${etaStr ? ` · ETA ${etaStr}` : ""}`;

    const nozzleHeating = Number(p.nozzle_target || 0) > 0;
    const bedHeating = Number(p.bed_target || 0) > 0;
    const tempPills = [];
    if (p.nozzle_temp != null) {
      const t = nozzleHeating ? ` / ${Math.round(p.nozzle_target)}°C` : "°C";
      tempPills.push(
        `<span class="temp-pill ${nozzleHeating ? "heating" : ""}"><span class="temp-label">Nozzle</span> ${Number(p.nozzle_temp).toFixed(1)}${t}</span>`
      );
    }
    if (p.bed_temp != null) {
      const t = bedHeating ? ` / ${Math.round(p.bed_target)}°C` : "°C";
      tempPills.push(
        `<span class="temp-pill ${bedHeating ? "heating" : ""}"><span class="temp-label">Bed</span> ${Number(p.bed_temp).toFixed(1)}${t}</span>`
      );
    }
    if (p.chamber_temp != null && Number(p.chamber_temp) > 0) {
      tempPills.push(
        `<span class="temp-pill"><span class="temp-label">Chamber</span> ${Number(p.chamber_temp).toFixed(1)}°C</span>`
      );
    }

    const layerHtml =
      p.current_layer != null && p.total_layers != null && p.total_layers > 0
        ? `<span class="layer-pill">Layer ${p.current_layer} / ${p.total_layers}</span>`
        : "";

    const unloadMode = String(p.auto_unload_mode || "off").toLowerCase();
    const unloadLabel =
      unloadMode === "once"
        ? "Unload once"
        : unloadMode === "always"
          ? "Always unload"
          : "Don't unload";
    const unloadClass =
      unloadMode === "once"
        ? "active-once"
        : unloadMode === "always"
          ? "active-always"
          : "";

    const canSkip = Boolean(p.can_skip_parts) && Array.isArray(p.print_objects) && p.print_objects.length > 0;

    let confirmHtml = "";
    if (this._modalConfirm === "pause") {
      confirmHtml = `
        <div class="confirm-bar warn">
          <span>Pause print on <b>${esc(p.name)}</b>?</span>
          <div class="confirm-btns">
            <button type="button" class="pill-btn warn" data-modal-action="confirm-pause" ${this._modalBusy ? "disabled" : ""}>Pause Print</button>
            <button type="button" class="pill-btn" data-modal-action="cancel-confirm">Back</button>
          </div>
        </div>`;
    } else if (this._modalConfirm === "cancel") {
      confirmHtml = `
        <div class="confirm-bar">
          <span>Cancel the active print on <b>${esc(p.name)}</b>?</span>
          <div class="confirm-btns">
            <button type="button" class="pill-btn danger" data-modal-action="confirm-cancel" ${this._modalBusy ? "disabled" : ""}>Cancel Print</button>
            <button type="button" class="pill-btn" data-modal-action="cancel-confirm">Keep Printing</button>
          </div>
        </div>`;
    }

    const noticeHtml = this._modalNotice
      ? `<div class="notice-bar ${esc(this._modalNotice.kind)}">${esc(this._modalNotice.text)}</div>`
      : "";

    const skipDrawerHtml = canSkip && this._modalSkipOpen ? this._renderSkipDrawer(p) : "";

    return `
      <div class="modal-backdrop" data-modal-backdrop="1">
        <div class="modal-card ${statusClass}" role="dialog" aria-modal="true" aria-label="${esc(p.name)} controls">
          <div class="modal-head">
            <div class="modal-title-group">
              <span class="dot" aria-hidden="true"></span>
              <span class="modal-name">${esc(p.name)}</span>
              ${p.machine_type ? `<span class="modal-badge">${esc(p.machine_type)}</span>` : ""}
              ${p.nozzle_variant ? `<span class="modal-badge">${esc(p.nozzle_variant)}mm</span>` : ""}
              <span class="status">${esc(p.status_label || status.toUpperCase())}</span>
            </div>
            <div class="modal-head-btns">
              ${
                p.has_chamber_light
                  ? `<button type="button" class="icon-btn ${p.chamber_light_on ? "light-on" : ""}" data-modal-action="toggle-light" title="${p.chamber_light_on ? "Turn chamber light off" : "Turn chamber light on"}" aria-label="Toggle chamber light" ${this._modalBusy ? "disabled" : ""}>💡</button>`
                  : ""
              }
              <button type="button" class="icon-btn" data-modal-action="close" title="Close" aria-label="Close">×</button>
            </div>
          </div>

          <div class="cam">
            <span class="cam-placeholder">${esc(p.machine_type || p.name)}</span>
            <img data-printer-id="${id}"
                 class="cam-img ${blobUrl ? "loaded" : ""}"
                 ${blobUrl ? `src="${esc(blobUrl)}"` : ""}
                 alt="${esc(p.name)} live camera"
                 style="transform: ${esc(transform)}" />
            ${tempPills.length ? `<div class="temp-overlay">${tempPills.join("")}</div>` : ""}
            ${layerHtml}
          </div>

          <div class="modal-progress">
            <div class="fill" style="--progress: ${prog}%"></div>
            <div class="modal-progress-text">
              <span class="modal-file" title="${esc(p.file_name || "")}">${esc(p.file_name || p.status_label || "")}</span>
              <span class="modal-eta">${esc(rightProgressText)}</span>
            </div>
          </div>

          <div class="modal-deck">
            ${noticeHtml}
            ${confirmHtml}
            <div class="action-row">
              ${
                status === "printing"
                  ? `<button type="button" class="pill-btn warn" data-modal-action="prompt-pause" ${this._modalBusy ? "disabled" : ""}>⏸ Pause</button>`
                  : status === "paused"
                    ? `<button type="button" class="pill-btn ok" data-modal-action="resume" ${this._modalBusy ? "disabled" : ""}>▶ Resume</button>`
                    : ""
              }
              ${
                status === "printing" || status === "paused"
                  ? `<button type="button" class="pill-btn danger" data-modal-action="prompt-cancel" ${this._modalBusy ? "disabled" : ""}>⏹ Cancel</button>`
                  : ""
              }
              ${
                canSkip
                  ? `<button type="button" class="pill-btn ${this._modalSkipOpen ? "active-once" : ""}" data-modal-action="toggle-skip" ${this._modalBusy ? "disabled" : ""}>⊘ Skip part</button>`
                  : ""
              }
              ${
                p.can_auto_unload
                  ? `<button type="button" class="pill-btn ${unloadClass}" data-modal-action="cycle-unload" title="Cycle auto-unload after print (Off -> Once -> Always)" ${this._modalBusy ? "disabled" : ""}>⏏ ${esc(unloadLabel)}</button>`
                  : ""
              }
            </div>
            ${skipDrawerHtml}
          </div>
        </div>
      </div>`;
  }

  _renderSkipDrawer(p) {
    const objects = Array.isArray(p.print_objects) ? p.print_objects : [];
    const bounds = Array.isArray(p.bed_bounds) && p.bed_bounds.length === 4 ? p.bed_bounds : [0, 0, 235, 235];
    const [minX, minY, maxX, maxY] = bounds.map(Number);
    const width = Math.max(10, maxX - minX);
    const height = Math.max(10, maxY - minY);
    const radius = Math.max(width, height) * 0.03;
    const svgY = (y) => maxY - Number(y);

    // Keep only non-excluded parts in selection
    for (const name of [...this._modalSkipSelected]) {
      const obj = objects.find((o) => o.name === name);
      if (!obj || obj.is_excluded) this._modalSkipSelected.delete(name);
    }

    const shapesHtml = objects
      .map((obj) => {
        const isSel = this._modalSkipSelected.has(obj.name);
        const cls = [
          "skip-part",
          obj.is_current ? "is-current" : "",
          obj.is_excluded ? "is-excluded" : "",
          isSel ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (Array.isArray(obj.polygon) && obj.polygon.length >= 3) {
          const pts = obj.polygon.map((pt) => `${Number(pt[0]).toFixed(1)},${svgY(pt[1]).toFixed(1)}`).join(" ");
          return `<polygon class="${cls}" points="${pts}" data-skip-part="${esc(obj.name)}"><title>${esc(obj.name)}</title></polygon>`;
        }
        if (Array.isArray(obj.center) && obj.center.length >= 2) {
          return `<circle class="${cls}" cx="${Number(obj.center[0]).toFixed(1)}" cy="${svgY(obj.center[1]).toFixed(1)}" r="${radius.toFixed(1)}" data-skip-part="${esc(obj.name)}"><title>${esc(obj.name)}</title></circle>`;
        }
        return "";
      })
      .join("");

    const listHtml = objects
      .map((obj) => {
        const isSel = this._modalSkipSelected.has(obj.name);
        const cls = [
          "skip-item",
          isSel ? "is-selected" : "",
          obj.is_excluded ? "is-excluded" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const badge = obj.is_excluded
          ? `<span class="skip-tag">Skipped</span>`
          : obj.is_current
            ? `<span class="skip-tag now">Printing now</span>`
            : "";
        return `
          <button type="button" class="${cls}" data-skip-part="${esc(obj.name)}" ${obj.is_excluded ? "disabled" : ""}>
            <span>${esc(obj.name)}</span>
            ${badge}
          </button>`;
      })
      .join("");

    const selCount = this._modalSkipSelected.size;
    const selLabel = selCount === 1 ? "1 part" : `${selCount} parts`;

    let skipFooterHtml = "";
    if (this._modalConfirm === "skip" && selCount > 0) {
      skipFooterHtml = `
        <div class="confirm-bar">
          <span>Skip <b>${esc([...this._modalSkipSelected].join(", "))}</b>? This cannot be undone.</span>
          <div class="confirm-btns">
            <button type="button" class="pill-btn danger" data-modal-action="confirm-skip" ${this._modalBusy ? "disabled" : ""}>Skip ${selLabel}</button>
            <button type="button" class="pill-btn" data-modal-action="cancel-confirm">Back</button>
          </div>
        </div>`;
    } else {
      skipFooterHtml = `
        <div class="confirm-btns" style="justify-content: flex-end;">
          ${selCount > 0 ? `<button type="button" class="pill-btn" data-modal-action="clear-skip">Clear</button>` : ""}
          <button type="button" class="pill-btn danger" data-modal-action="prompt-skip" ${selCount === 0 || this._modalBusy ? "disabled" : ""}>
            ${selCount > 1 ? `Skip ${selCount} parts` : "Skip part"}
          </button>
        </div>`;
    }

    return `
      <div class="skip-drawer">
        <div class="skip-grid">
          <svg class="skip-map" viewBox="${minX} 0 ${width} ${height}" role="img" aria-label="Print bed part map">
            <rect class="skip-bed" x="${minX}" y="0" width="${width}" height="${height}" />
            ${shapesHtml}
          </svg>
          <div class="skip-list">
            ${listHtml}
          </div>
        </div>
        ${skipFooterHtml}
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
        } else if (status === "printing" || status === "paused") {
          this._openModal(id);
        }
      });
    }

    const backdrop = this.shadowRoot.querySelector(".modal-backdrop[data-modal-backdrop]");
    if (backdrop) {
      backdrop.addEventListener("click", (ev) => {
        if (ev.target === backdrop) {
          this._closeModal();
        }
      });
    }

    for (const el of this.shadowRoot.querySelectorAll("[data-modal-action]")) {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._handleModalAction(el.dataset.modalAction);
      });
    }

    for (const partEl of this.shadowRoot.querySelectorAll("[data-skip-part]")) {
      partEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const name = partEl.dataset.skipPart;
        if (!name || this._modalBusy) return;
        const p = this._visiblePrinters().find((x) => Number(x.id) === this._modalPrinterId);
        const obj = (p?.print_objects || []).find((o) => o.name === name);
        if (!obj || obj.is_excluded) return;
        if (this._modalSkipSelected.has(name)) {
          this._modalSkipSelected.delete(name);
        } else {
          this._modalSkipSelected.add(name);
        }
        this._modalConfirm = null;
        this._render();
      });
    }
  }

  _handleModalAction(action) {
    const id = this._modalPrinterId;
    if (id == null) return;
    const p = this._visiblePrinters().find((x) => Number(x.id) === id);
    if (!p) return;

    switch (action) {
      case "close":
        this._closeModal();
        break;
      case "prompt-pause":
        this._modalConfirm = "pause";
        this._modalNotice = null;
        this._render();
        break;
      case "prompt-cancel":
        this._modalConfirm = "cancel";
        this._modalNotice = null;
        this._render();
        break;
      case "prompt-skip":
        if (this._modalSkipSelected.size > 0) {
          this._modalConfirm = "skip";
          this._modalNotice = null;
          this._render();
        }
        break;
      case "cancel-confirm":
        this._modalConfirm = null;
        this._render();
        break;
      case "confirm-pause":
        this._callControlService(
          "pause_print",
          { printer_id: id },
          { status: "paused", status_label: "PAUSED" },
          "Print paused."
        );
        break;
      case "resume":
        this._callControlService(
          "resume_print",
          { printer_id: id },
          { status: "printing", status_label: "PRINTING" },
          "Print resumed."
        );
        break;
      case "confirm-cancel":
        this._callControlService("cancel_print", { printer_id: id }, null, "Print cancelled.");
        this._closeModal();
        break;
      case "toggle-light": {
        const nextOn = !p.chamber_light_on;
        this._callControlService(
          "set_light",
          { printer_id: id, on: nextOn },
          { chamber_light_on: nextOn },
          nextOn ? "Chamber light turned on." : "Chamber light turned off."
        );
        break;
      }
      case "cycle-unload": {
        const cur = String(p.auto_unload_mode || "off").toLowerCase();
        const nextMode = NEXT_UNLOAD_MODE[cur] || "off";
        this._callControlService(
          "set_auto_unload",
          { printer_id: id, mode: nextMode },
          { auto_unload_mode: nextMode },
          nextMode === "once"
            ? "Will unload filament after this print."
            : nextMode === "always"
              ? "Will unload filament after every print."
              : "Auto-unload turned off."
        );
        break;
      }
      case "toggle-skip":
        this._modalSkipOpen = !this._modalSkipOpen;
        this._modalConfirm = null;
        if (this._modalSkipOpen && this._modalSkipSelected.size === 0) {
          const cur = (p.print_objects || []).find((o) => o.is_current && !o.is_excluded);
          if (cur) this._modalSkipSelected.add(cur.name);
        }
        this._render();
        break;
      case "clear-skip":
        this._modalSkipSelected.clear();
        this._modalConfirm = null;
        this._render();
        break;
      case "confirm-skip": {
        const names = [...this._modalSkipSelected];
        if (!names.length) return;
        const updatedObjects = (p.print_objects || []).map((o) =>
          names.includes(o.name) ? { ...o, is_excluded: true, is_current: false } : o
        );
        this._modalSkipSelected.clear();
        this._callControlService(
          "skip_parts",
          { printer_id: id, names },
          { print_objects: updatedObjects },
          `Skipped ${names.join(", ")}.`
        );
        break;
      }
    }
  }
}

if (!customElements.get("plastic-slinger-glance-card")) {
  customElements.define("plastic-slinger-glance-card", PlasticSlingerGlanceCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "plastic-slinger-glance-card")) {
  window.customCards.push({
    type: "plastic-slinger-glance-card",
    name: "Plastic Slinger Glance Card",
    description:
      "Compact 2xX 16:9 active-print camera glance grid with native printer control modal, status colors, and click-to-dismiss.",
    preview: true,
  });
}
