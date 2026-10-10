export type BookmarkViewMode = "grid" | "list";

interface BookmarkVirtualizerOptions<T> {
  scrollElement: HTMLElement;
  hostElement: HTMLElement;
  items: readonly T[];
  view: BookmarkViewMode;
  renderItem: (item: T) => string;
  onRendered: () => void;
}

const OVERSCAN_PIXELS = 700;
const DEFAULT_GRID_ROW_HEIGHT = 390;
const DEFAULT_LIST_ROW_HEIGHT = 140;

export class BookmarkVirtualizer<T> {
  readonly hostElement: HTMLElement;

  private readonly scrollElement: HTMLElement;
  private readonly items: readonly T[];
  private readonly view: BookmarkViewMode;
  private readonly renderItem: (item: T) => string;
  private readonly onRendered: () => void;
  private readonly rowHeights = new Map<number, number>();
  private readonly resizeObserver: ResizeObserver;
  private columns = 1;
  private rowStarts: number[] = [];
  private totalHeight = 0;
  private renderedStart = -1;
  private renderedEnd = -1;
  private animationFrame: number | undefined;
  private measurementFrame: number | undefined;
  private destroyed = false;

  private readonly handleViewportChange = (): void => {
    this.scheduleUpdate();
  };

  private readonly handleResize = (): void => {
    this.rowHeights.clear();
    this.renderedStart = -1;
    this.renderedEnd = -1;
    this.scheduleUpdate();
  };

  constructor(options: BookmarkVirtualizerOptions<T>) {
    this.scrollElement = options.scrollElement;
    this.hostElement = options.hostElement;
    this.items = options.items;
    this.view = options.view;
    this.renderItem = options.renderItem;
    this.onRendered = options.onRendered;
    this.resizeObserver = new ResizeObserver(this.handleResize);

    this.scrollElement.addEventListener("scroll", this.handleViewportChange, { passive: true });
    window.addEventListener("resize", this.handleResize, { passive: true });
    this.resizeObserver.observe(this.scrollElement);
    this.update();
  }

  destroy(): void {
    this.destroyed = true;
    this.scrollElement.removeEventListener("scroll", this.handleViewportChange);
    window.removeEventListener("resize", this.handleResize);
    this.resizeObserver.disconnect();
    if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
    if (this.measurementFrame !== undefined) cancelAnimationFrame(this.measurementFrame);
  }

  refresh(): void {
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.destroyed || this.animationFrame !== undefined) return;
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = undefined;
      this.update();
    });
  }

  private update(): void {
    if (this.destroyed || !this.hostElement.isConnected) return;
    const nextColumns = this.columnCount();
    if (nextColumns !== this.columns) {
      this.columns = nextColumns;
      this.rowHeights.clear();
      this.renderedStart = -1;
      this.renderedEnd = -1;
    }

    this.rebuildRowStarts();
    const rowCount = this.rowStarts.length;
    if (!rowCount) {
      this.hostElement.replaceChildren();
      return;
    }

    const scrollRect = this.scrollElement.getBoundingClientRect();
    const hostRect = this.hostElement.getBoundingClientRect();
    const viewportStart = scrollRect.top - hostRect.top;
    const viewportEnd = scrollRect.bottom - hostRect.top;
    const firstRow = this.rowAtOffset(Math.max(0, viewportStart - OVERSCAN_PIXELS));
    const lastRow = this.rowAtOffset(Math.min(this.totalHeight, viewportEnd + OVERSCAN_PIXELS));
    const start = Math.max(0, firstRow);
    const end = Math.min(rowCount, lastRow + 1);

    if (start !== this.renderedStart || end !== this.renderedEnd) {
      this.renderWindow(start, end);
    } else {
      this.updateSpacers(start, end);
    }
  }

  private columnCount(): number {
    if (this.view === "list") return 1;
    const styles = getComputedStyle(this.hostElement);
    const minimumWidth = Number.parseFloat(styles.getPropertyValue("--bookmark-grid-min")) || 275;
    const gap = this.rowGap();
    return Math.max(1, Math.floor((this.hostElement.clientWidth + gap) / (minimumWidth + gap)));
  }

  private rowGap(): number {
    return Number.parseFloat(getComputedStyle(this.hostElement).getPropertyValue("--bookmark-row-gap")) || 0;
  }

  private estimatedRowHeight(): number {
    return this.view === "grid" ? DEFAULT_GRID_ROW_HEIGHT : DEFAULT_LIST_ROW_HEIGHT;
  }

  private rebuildRowStarts(): void {
    const rowCount = Math.ceil(this.items.length / this.columns);
    const gap = this.rowGap();
    const estimate = this.estimatedRowHeight();
    this.rowStarts = new Array<number>(rowCount);
    let offset = 0;
    for (let row = 0; row < rowCount; row += 1) {
      this.rowStarts[row] = offset;
      offset += this.rowHeights.get(row) ?? estimate;
      if (row < rowCount - 1) offset += gap;
    }
    this.totalHeight = offset;
  }

  private rowAtOffset(offset: number): number {
    let low = 0;
    let high = this.rowStarts.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (this.rowStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private renderWindow(start: number, end: number): void {
    const firstItem = start * this.columns;
    const lastItem = Math.min(this.items.length, end * this.columns);
    const cards = this.items.slice(firstItem, lastItem).map(this.renderItem).join("");
    const template = document.createElement("template");
    template.innerHTML = `<div class="bookmark-virtual-spacer" data-virtual-spacer="top" aria-hidden="true"></div><div class="bookmark-${this.view} bookmark-virtual-window">${cards}</div><div class="bookmark-virtual-spacer" data-virtual-spacer="bottom" aria-hidden="true"></div>`;

    const nextCards = Array.from(template.content.querySelectorAll<HTMLElement>(".bookmark-card[data-id]"));
    const nextIds = new Set(nextCards.map((card) => card.dataset.id).filter((id): id is string => Boolean(id)));
    const reusableCards = new Map<string, HTMLElement>();
    const recycledCards: HTMLElement[] = [];
    this.hostElement.querySelectorAll<HTMLElement>(".bookmark-card[data-id]").forEach((card) => {
      const id = card.dataset.id;
      if (id && nextIds.has(id)) reusableCards.set(id, card);
      else recycledCards.push(card);
    });
    nextCards.forEach((card) => {
      const id = card.dataset.id;
      const existing = id ? reusableCards.get(id) : undefined;
      if (existing) {
        card.replaceWith(existing);
        return;
      }
      const recycled = recycledCards.pop();
      if (!recycled) return;
      for (const attribute of Array.from(recycled.attributes)) recycled.removeAttribute(attribute.name);
      for (const attribute of Array.from(card.attributes)) recycled.setAttribute(attribute.name, attribute.value);
      recycled.innerHTML = card.innerHTML;
      card.replaceWith(recycled);
    });

    this.hostElement.replaceChildren(template.content);
    this.renderedStart = start;
    this.renderedEnd = end;
    this.updateSpacers(start, end);
    this.onRendered();
    if (this.measurementFrame !== undefined) cancelAnimationFrame(this.measurementFrame);
    this.measurementFrame = requestAnimationFrame(() => {
      this.measurementFrame = undefined;
      this.measureRows(start);
    });
  }

  private updateSpacers(start: number, end: number): void {
    const gap = this.rowGap();
    const topHeight = this.rowStarts[start] ?? 0;
    const bottomHeight = end < this.rowStarts.length
      ? Math.max(0, this.totalHeight - (this.rowStarts[end] - gap))
      : 0;
    const top = this.hostElement.querySelector<HTMLElement>("[data-virtual-spacer=\"top\"]");
    const bottom = this.hostElement.querySelector<HTMLElement>("[data-virtual-spacer=\"bottom\"]");
    if (top) top.style.height = `${topHeight}px`;
    if (bottom) bottom.style.height = `${bottomHeight}px`;
  }

  private measureRows(start: number): void {
    if (this.destroyed || !this.hostElement.isConnected) return;
    const measured = new Map<number, number>();
    this.hostElement.querySelectorAll<HTMLElement>(".bookmark-virtual-window > .bookmark-card").forEach((card, index) => {
      const row = start + Math.floor(index / this.columns);
      measured.set(row, Math.max(measured.get(row) ?? 0, card.getBoundingClientRect().height));
    });

    let changed = false;
    measured.forEach((height, row) => {
      if (height > 0 && Math.abs((this.rowHeights.get(row) ?? 0) - height) > 0.5) {
        this.rowHeights.set(row, height);
        changed = true;
      }
    });
    if (changed) this.scheduleUpdate();
  }
}
