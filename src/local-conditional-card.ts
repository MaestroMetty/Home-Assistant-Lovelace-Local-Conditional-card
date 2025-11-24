/* eslint-disable @typescript-eslint/no-explicit-any */
import { html, LitElement, PropertyValues, TemplateResult, CSSResultGroup, css } from "lit";
import { customElement, property, state } from "lit/decorators";
import { HomeAssistant, LovelaceCard, LovelaceCardConfig, LovelaceCardEditor } from "custom-card-helpers";
import type { LocalConditionalCardConfig, LovelaceCardFixed, LovelaceDomEvent } from "./types";
import { CARD_VERSION, SHOW, EVENT_LOVELACE_DOM, EVENT_LOVELACE_DOM_DETAIL, HIDE, DEFAULT_ID, TOGGLE } from "./const";

// Register card picker entry (kept)
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: "local-conditional-card",
  name: "Local Conditional Card",
  description: "A conditional card that works only for current view",
});

@customElement("local-conditional-card")
export class LocalConditionalCard extends LitElement {
  // Optional CSS to handle show/hide with classes (avoids style writes)
  static styles: CSSResultGroup = css`
    :host { display: block; }
    .hidden { display: none; }
  `;

  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import("./editor");
    return document.createElement("local-conditional-card-editor");
  }

  public static getStubConfig(): Record<string, unknown> {
    return {
      id: DEFAULT_ID,
      default: SHOW,
      card: {},
    };
  }

  @property({ attribute: false }) public _hass!: HomeAssistant;
  @property({ type: Boolean }) public preview = false;

  // Reactive state
  @state() private config!: LocalConditionalCardConfig;
  @state() private show = true; // persisted user-visible boolean
  @state() private visible = false; // computed visibility used by template

  // Lazy-loaded helpers and caches
  private cardHelpers: any | null = null;
  private cardCache = new Map<string, LovelaceCard>();
  private card!: LovelaceCard; // the currently rendered child card element

  // Event debounce so many events don't recompute repeatedly
  private _pendingEvent = false;
  private _lastEvent: Event | null = null;

  // Persist connect/disconnect
  public connectedWhileHidden = true;

  constructor() {
    super();
    this._handleLovelaceDomEvent = this._handleLovelaceDomEvent.bind(this);
    this._processQueuedLovelaceEvent = this._processQueuedLovelaceEvent.bind(this);
  }

  // ---------- Configuration ----------

  public async setConfig(config: LocalConditionalCardConfig): Promise<void> {
    if (!config) {
      throw new Error("Missing configuration");
    }
    this.config = config;
    // Default show value (overridden by persisted state below asynchronously)
    this.show = config.default === "show";

    // If card missing, throw
    if (!config.card) {
      throw new Error("No card configured");
    }

    // Create child card eagerly but non-blocking: create in microtask to avoid blocking HA boot
    queueMicrotask(async () => {
      await this._ensureHelpers();
      await this.createCard(config.card);
      // after card exists, compute visibility (visibility depends on preview and persisted state)
      this._computeAndSetVisible();
    });

    // Read persisted state asynchronously (non-blocking)
    if (config.persist_state) {
      queueMicrotask(() => {
        try {
          const lastSaved = localStorage.getItem(this._getStorageKey(config));
          if (lastSaved != null) {
            const parsed = lastSaved === "true";
            if (parsed !== this.show) {
              this.show = parsed;
              // ensure Lit re-evaluates visible value
              this._computeAndSetVisible();
            }
          }
        } catch (err) {
          // ignore localStorage errors (privacy mode, etc.)
        }
      });
    }
  }

  // ---------- hass getter/setter ----------

  public get hass(): HomeAssistant {
    return this._hass;
  }

  public set hass(hass: HomeAssistant) {
    if (!this.config || !hass) return;
    this._hass = hass;
    if (this.card) {
      (this.card as any).hass = hass;
    }
  }

  // Hidden property kept for backwards compatibility
  public get hidden(): boolean {
    return !this.visible;
  }

  // ---------- Render / visibility ----------

  protected render(): TemplateResult {
    // Only minimal template logic: use computed this.visible and a css class
    const hiddenClass = this.visible ? "" : "hidden";
    // Keep the child element in the DOM always (created once) to avoid heavy mount/unmount cost.
    return html`<div class=${hiddenClass}>${this.card}</div>`;
  }

  // When reactive properties change, recompute visibility if needed
  protected updated(changed: PropertyValues): void {
    if (changed.has("show") || changed.has("preview") || changed.has("config")) {
      this._computeAndSetVisible();
    }
  }

  private _computeAndSetVisible(): void {
    const prev = this.visible;
    this.visible = this._computeVisibility();
    if (prev !== this.visible) {
      // If persisted state is enabled, persist the new state asynchronously
      if (this.config?.persist_state) {
        queueMicrotask(() => {
          try {
            localStorage.setItem(this._getStorageKey(), `${this.show}`);
          } catch {
            /* ignore */
          }
        });
      }
      // notify parent about visibility change (bubbles)
      this.dispatchEvent(new Event("card-visibility-changed", { bubbles: true, cancelable: true }));
    }
  }

  private _computeVisibility(): boolean {
    // Keep same logic as original but cheap to compute
    // Show if preview (and not explicitly hidden in preview), if this.show is true,
    // or if the instantiated card is an error card (so editor can show in editor mode).
    return (
      (this.preview && !(this.config?.hide_in_preview ?? false)) ||
      this.show ||
      (this.card && (this.card.localName === "hui-error-card" || (this.card as any).localName === "hui-error-card"))
    );
  }

  // ---------- Lifecycle ----------

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener(EVENT_LOVELACE_DOM, this._handleLovelaceDomEvent);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener(EVENT_LOVELACE_DOM, this._handleLovelaceDomEvent);
  }

  // ---------- Card helpers & creation with caching ----------

  private async _ensureHelpers(): Promise<void> {
    if (this.cardHelpers) return;
    // Lazy load helpers (non-blocking for initial setConfig because we invoked createCard in microtask)
    try {
      this.cardHelpers = await (window as any).loadCardHelpers?.();
    } catch {
      this.cardHelpers = null;
    }
  }

  public async getCardSize(): Promise<number> {
    // If not visible, size 0. If card supports getCardSize, call it; otherwise default to 1.
    if (!this._computeVisibility()) return 0;
    if (!this.card) return 1;
    if ("getCardSize" in this.card && typeof (this.card as any).getCardSize === "function") {
      try {
        // call safely
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return await (this.card as any).getCardSize();
      } catch {
        return 1;
      }
    }
    return 1;
  }

  public async createCard(config: LovelaceCardConfig): Promise<void> {
    // create and cache the card element; lightweight: returns quickly if cached
    this.card = await this._createCard(config);
    // ensure hass is propagated
    if (this._hass) {
      (this.card as any).hass = this._hass;
    }
    // recompute visibility now that card exists
    this._computeAndSetVisible();
  }

  private _cardConfigKey(cfg: LovelaceCardConfig): string {
    // Use a stable key for caching. JSON stringify is OK for most HA configs.
    // If configs contain functions or circular refs, fallback to a simple type-based key.
    try {
      return JSON.stringify(cfg);
    } catch {
      return (cfg as any).type ?? String(cfg);
    }
  }

  private async _createCard(cardConfig: LovelaceCardConfig): Promise<LovelaceCard> {
    await this._ensureHelpers();
    const key = this._cardConfigKey(cardConfig);
    if (this.cardCache.has(key)) {
      return this.cardCache.get(key)!;
    }

    // Create new card element using helpers (if available), otherwise fall back to naive element
    let el: LovelaceCard;
    if (this.cardHelpers?.createCardElement) {
      el = this.cardHelpers.createCardElement(cardConfig);
    } else {
      // Fallback: create a basic element so the card doesn't blow up
      el = document.createElement("div") as unknown as LovelaceCard;
      (el as any).localName = "div";
      (el as any).setConfig = () => {};
    }

    // Listen for rebuild events and rebuild only that cached card
    el.addEventListener("ll-rebuild", (ev: Event) => {
      ev.stopPropagation();
      // rebuild asynchronously to avoid sync thrash
      queueMicrotask(async () => {
        const newEl = await this._createCard(cardConfig);
        if (el.parentElement) {
          el.parentElement.replaceChild(newEl, el);
        }
        // Update cache & instance references
        this.cardCache.set(key, newEl);
        this.card = newEl;
        if (this._hass) (this.card as any).hass = this._hass;
        this._computeAndSetVisible();
      });
    });

    // ensure hass bound
    if (this._hass) el.hass = this._hass;

    // Cache and return the created element
    this.cardCache.set(key, el);
    return el;
  }

  // ---------- Event handling (debounced) ----------

  private _handleLovelaceDomEvent(e: Event): void {
    // Save the last event and schedule processing on the next RAF to avoid floods
    this._lastEvent = e;
    if (this._pendingEvent) return;
    this._pendingEvent = true;
    requestAnimationFrame(this._processQueuedLovelaceEvent);
  }

  private _processQueuedLovelaceEvent(): void {
    this._pendingEvent = false;
    const e = this._lastEvent;
    this._lastEvent = null;
    if (!e) return;

    const lovelaceEvent = e as LovelaceDomEvent;
    try {
      if (
        EVENT_LOVELACE_DOM_DETAIL in lovelaceEvent.detail &&
        "ids" in lovelaceEvent.detail[EVENT_LOVELACE_DOM_DETAIL] &&
        "action" in lovelaceEvent.detail[EVENT_LOVELACE_DOM_DETAIL] &&
        Array.isArray(lovelaceEvent.detail[EVENT_LOVELACE_DOM_DETAIL]["ids"])
      ) {
        const ids = lovelaceEvent.detail[EVENT_LOVELACE_DOM_DETAIL]["ids"] as Array<string | Record<string, any>>;
        let action = lovelaceEvent.detail[EVENT_LOVELACE_DOM_DETAIL]["action"] as string;

        if (action === "set") {
          const found = ids.find((id) => typeof id === "object" && this.config && this.config.id in (id as any));
          if (found && typeof found === "object") {
            action = (found as any)[this.config.id];
          }
        } else {
          action = ids.includes(this.config?.id) ? action : "none";
        }

        switch (action) {
          case SHOW:
            this.show = true;
            break;
          case HIDE:
            this.show = false;
            break;
          case TOGGLE:
            this.show = !this.show;
            break;
          default:
            // no-op
            break;
        }

        // Update visible and persist state asynchronously
        this._computeAndSetVisible();
      }
    } catch {
      // swallow event processing errors; do not break dashboard
    }
  }

  // ---------- Utilities ----------

  private _getStorageKey(config?: LocalConditionalCardConfig): string {
    return `local_conditional_card_state_${(config ?? this.config).id}`;
  }
}
