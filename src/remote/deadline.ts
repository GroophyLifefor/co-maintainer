/** A limit every wait of a remote review races, not only the top of its
 * loop: a sync that stalls or a slow tool batch must not outlive it. */
export type Deadline = {
  /** `work`, or the limit's error once the limit is reached first. */
  bounded<T>(work: Promise<T>): Promise<T>;
  /** Throws the limit's error when the limit has passed. */
  check(): void;
  /** Stops the timer once the review ended. */
  clear(): void;
};

/** `at` is a `Date.now()` time, `undefined` for no limit. `timedOut` throws
 * the error a reached limit fails with. */
export function startDeadline(
  at: number | undefined,
  timedOut: () => never,
): Deadline {
  if (at === undefined) {
    return {
      bounded: (work) => work,
      check: () => {},
      clear: () => {},
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        try {
          timedOut();
        } catch (error) {
          reject(error);
        }
      },
      Math.max(0, at - Date.now()),
    );
    // Never the reason the process stays alive.
    (timer as { unref?: () => void }).unref?.();
  });
  // Settled through a race only: a rejection after the review ended is not
  // an unhandled one.
  reached.catch(() => {});
  return {
    bounded: (work) => Promise.race([work, reached]),
    check: () => {
      if (Date.now() >= at) timedOut();
    },
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
