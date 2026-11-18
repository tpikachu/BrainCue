/**
 * Orders the settings snapshots that reach one view (M7.2a review, AI-01).
 *
 * A view hears settings three ways: a read it asked for, the reply to a write
 * it made, and main's push (`settings:changed`). Main pushes to every window
 * after every write, key change and route move, and a window receives its IPC
 * messages in the order main sent them. Replies, though, can land after
 * something newer: a held read used to put the old model back on the Cue Card
 * chip, and Cue Card settings then saved that old model back.
 *
 * The rule: a push always applies; a reply applies only if nothing newer
 * reached the view since it was requested — no push, no other applied reply,
 * no edit by the user. Dropping a reply never loses a change: whatever
 * superseded it is at least as new, and main pushes every change it makes.
 */
export interface SettingsFeed<T> {
  /** Main's push: the newest state there is. */
  push: (s: T) => void;
  /** The user just edited a field here: replies asked for earlier are stale. */
  edited: () => void;
  /** Apply `p`'s result unless something newer arrived meanwhile; resolves
   *  to the snapshot either way (or rejects as `p` does). */
  request: (p: Promise<T>) => Promise<T>;
}

export function createSettingsFeed<T>(apply: (s: T) => void): SettingsFeed<T> {
  let seq = 0;
  return {
    push: (s) => {
      seq++;
      apply(s);
    },
    edited: () => {
      seq++;
    },
    request: async (p) => {
      const at = seq;
      const s = await p;
      if (at === seq) {
        seq++;
        apply(s);
      }
      return s;
    },
  };
}
