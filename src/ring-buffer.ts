/**
 * Bounded FIFO buffer with O(1) push and amortised O(1) drop-oldest. The
 * previous implementation used Array.splice(0, n), which is O(n) on every
 * overflow and dominated CPU under high logpoint hit rates.
 *
 * Used by DAPClient to buffer logpoint hits and debugger events without
 * unbounded memory growth on long sessions. FIFO semantics: when the buffer
 * is full, push silently drops the oldest entry to make room for the new one.
 */
export class RingBuffer<T> {
  private items: Array<T | undefined>;
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  /** Append an item; drops the oldest entry if the buffer is already full. */
  push(item: T): void {
    const tail = (this.head + this.size) % this.capacity;

    this.items[tail] = item;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      // Drop the oldest entry by advancing head; the slot just written becomes the newest.
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Materialise the full buffer in insertion order. Equivalent to slice(0, length). */
  toArray(): T[] {
    return this.slice(0, this.size);
  }

  /**
   * Read a contiguous window in logical (insertion) order: [offset, offset+limit).
   *
   * Used by getLogpointHits/getDebuggerEvents so the wire payload does not
   * grow with MAX_BUFFER_SIZE regardless of need. Negative `offset` / `limit`
   * are clamped to zero. `offset >= length` returns []. When `offset + limit`
   * exceeds `length`, the window is truncated to what is available rather
   * than padding -- callers always get a valid slice and never see undefined.
   *
   * Throws an Error if an internal slot is unexpectedly undefined; this can
   * only happen if push() was bypassed (corrupted internal state) and is
   * surfaced loudly instead of leaking undefined into the result array.
   */
  slice(offset: number, limit: number): T[] {
    if (offset < 0) offset = 0;
    if (limit < 0) limit = 0;

    const start = Math.min(offset, this.size);
    const end = Math.min(this.size, start + limit);
    const out: T[] = new Array<T>(end - start);

    for (let i = start; i < end; i++) {
      const item = this.items[(this.head + i) % this.capacity];

      if (item === undefined) {
        throw new Error(`RingBuffer invariant violated: missing item at logical index ${i}`);
      }
      out[i - start] = item;
    }

    return out;
  }

  /** Current number of buffered items (<= capacity). */
  get length(): number {
    return this.size;
  }

  /** Drop all entries and reset the head pointer. Capacity is preserved. */
  clear(): void {
    this.items = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}
