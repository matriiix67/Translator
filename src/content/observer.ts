type RootCallback = (roots: HTMLElement[]) => void;

export class RootMutationObserver {
  private observer: MutationObserver | null = null;

  private readonly queue = new Set<HTMLElement>();

  private timer: number | null = null;

  constructor(
    private readonly onRoots: RootCallback,
    private readonly debounceMs = 180
  ) {}

  start(): void {
    if (this.observer) {
      return;
    }

    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
          }
          this.queue.add(node as HTMLElement);
        }
      }
      this.flushDebounced();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue.clear();
  }

  private flushDebounced(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      const roots = Array.from(this.queue);
      this.queue.clear();
      this.onRoots(roots);
    }, this.debounceMs);
  }
}
