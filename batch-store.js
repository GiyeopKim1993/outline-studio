'use strict';

/*
 * BatchStore — owns the batch queue and its per-item results.
 *
 * The bug this fixes: results were saved by reading the mutable global
 * `batchIndex`. While `processBatch` was running, clicking another tab changed
 * `batchIndex`, so a finished item was written into the wrong slot.
 *
 * Contract:
 *   - Every write names its slot explicitly. There is no implicit "current slot".
 *   - The active slot is presentation state only; writes never consult it.
 *   - Readers get defensive copies, so no caller can mutate a stored result.
 */

class BatchStore {
  /** @param {number} size number of slots */
  constructor(size = 0) {
    this._size = Math.max(0, size | 0);
    this._results = new Array(this._size).fill(undefined);
    this._active = 0;
    this._writes = 0;
  }

  get size() { return this._size; }
  get active() { return this._active; }
  /** Total accepted writes. Used to prove a cancelled run stopped working. */
  get writes() { return this._writes; }

  /** Presentation only: which tab is highlighted. Never affects storage. */
  setActive(index) {
    if (!this.inRange(index)) return false;
    this._active = index;
    return true;
  }

  inRange(index) {
    return Number.isInteger(index) && index >= 0 && index < this._size;
  }

  /** Resize for a new batch run, discarding previous results. */
  reset(size) {
    this._size = Math.max(0, size | 0);
    this._results = new Array(this._size).fill(undefined);
    this._active = 0;
    return this;
  }

  /** Store a finished result for an explicit slot. Returns true when accepted. */
  put(index, value) {
    if (!this.inRange(index)) return false;
    this._results[index] = clone(value);
    this._writes++;
    return true;
  }

  /** Defensive copy, or undefined when the slot has no result yet. */
  get(index) {
    if (!this.inRange(index)) return undefined;
    return clone(this._results[index]);
  }

  has(index) {
    return this.inRange(index) && this._results[index] !== undefined;
  }

  clear(index) {
    if (!this.inRange(index)) return false;
    this._results[index] = undefined;
    return true;
  }

  completedCount() {
    let n = 0;
    for (let i = 0; i < this._size; i++) if (this._results[i] !== undefined) n++;
    return n;
  }
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) return value.slice();
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === 'object') {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (_) { /* fall through */ }
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

if (typeof module !== 'undefined') module.exports = { BatchStore };
if (typeof window !== 'undefined') window.OutlineBatchStore = { BatchStore };
