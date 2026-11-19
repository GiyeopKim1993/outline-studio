'use strict';

/*
 * RenderState — the single owner of "what is currently on screen".
 *
 * The bug this fixes: the editor used to assign
 *   state.mask = ...; state.whitePaths = ...;   (spread across an `await`)
 * so a tab switch could publish item A's mask next to item B's white paths.
 *
 * Contract:
 *   - A commit builds the whole snapshot first, then publishes it in one step.
 *   - Commits are versioned; a commit that was superseded while awaiting its
 *     own async work is discarded instead of publishing stale data.
 *   - Readers always see one complete, self-consistent snapshot.
 */

class RenderState {
  /**
   * @param {(snapshot: object) => void} publish called once per accepted commit
   */
  constructor(publish) {
    this._publish = typeof publish === 'function' ? publish : () => {};
    this._snapshot = null;
    this._version = 0;
    this._accepted = 0;
    this._rejects = 0;
    this._queue = Promise.resolve();
  }

  get snapshot() { return this._snapshot; }
  get version() { return this._version; }
  get staleRejects() { return this._rejects; }

  /**
   * Build a snapshot asynchronously and publish it atomically.
   * `build` must be a pure function returning a complete snapshot object.
   * Returns the published snapshot, or null when the commit went stale.
   */
  commit(build) {
    const ticket = ++this._version;
    const run = async () => {
      const snapshot = await build();
      if (ticket !== this._version) {
        // A newer commit started while we were awaiting; never publish stale data.
        this._rejects++;
        return null;
      }
      this._snapshot = snapshot;
      this._accepted++;
      this._publish(snapshot);
      return snapshot;
    };
    // Serialise so two commits can never interleave their publish calls.
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  /** Publish a snapshot that is already fully built (synchronous path). */
  set(snapshot) {
    const ticket = ++this._version;
    this._snapshot = snapshot;
    this._accepted++;
    this._publish(snapshot, ticket);
    return snapshot;
  }

  clear() {
    ++this._version;
    this._snapshot = null;
    this._publish(null);
  }
}

if (typeof module !== 'undefined') module.exports = { RenderState };
if (typeof window !== 'undefined') window.OutlineRenderState = { RenderState };
