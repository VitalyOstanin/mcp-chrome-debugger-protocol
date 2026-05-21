import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('returns items in insertion order via toArray', () => {
    const rb = new RingBuffer<number>(4);

    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    expect(rb.length).toBe(3);
  });

  it('drops the oldest entry when capacity is exceeded', () => {
    const rb = new RingBuffer<number>(3);

    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    rb.push(5);
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]);
  });

  it('slice returns the requested logical window', () => {
    const rb = new RingBuffer<number>(5);

    [10, 20, 30, 40, 50].forEach(n => { rb.push(n); });
    expect(rb.slice(0, 2)).toEqual([10, 20]);
    expect(rb.slice(1, 3)).toEqual([20, 30, 40]);
    expect(rb.slice(3, 2)).toEqual([40, 50]);
  });

  it('slice truncates when offset + limit exceeds length', () => {
    const rb = new RingBuffer<number>(5);

    [1, 2, 3].forEach(n => { rb.push(n); });
    expect(rb.slice(1, 10)).toEqual([2, 3]);
    expect(rb.slice(0, 100)).toEqual([1, 2, 3]);
  });

  it('slice returns empty when offset >= length', () => {
    const rb = new RingBuffer<number>(3);

    rb.push(1);
    rb.push(2);
    expect(rb.slice(2, 5)).toEqual([]);
    expect(rb.slice(100, 1)).toEqual([]);
  });

  it('slice clamps negative offset and limit to zero', () => {
    const rb = new RingBuffer<number>(3);

    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.slice(-5, 2)).toEqual([1, 2]);
    expect(rb.slice(0, -1)).toEqual([]);
    expect(rb.slice(-1, -1)).toEqual([]);
  });

  it('slice still works correctly after wrap-around eviction', () => {
    const rb = new RingBuffer<number>(3);

    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    rb.push(5);
    // Logical order: [3, 4, 5], head advanced past 1 and 2
    expect(rb.slice(0, 2)).toEqual([3, 4]);
    expect(rb.slice(1, 2)).toEqual([4, 5]);
    expect(rb.slice(2, 5)).toEqual([5]);
  });

  it('clear empties the buffer and resets length', () => {
    const rb = new RingBuffer<number>(3);

    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.toArray()).toEqual([]);
    rb.push(99);
    expect(rb.toArray()).toEqual([99]);
  });

  it('toArray returns empty for a fresh buffer', () => {
    const rb = new RingBuffer<string>(2);

    expect(rb.length).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });
});
