// Which beat is the tick. A lock numbers its beats from wherever it happens to begin, so
// without a rule the same beat of a watch is called the tick in about half of all runs. The
// names decided on 24 and 25 November 2026 tie them to the watch instead:
//
// - Swiss lever: the tick is the beat followed by the longer gap, read from the timestamps.
//   A lever's two beats sound alike, so only their spacing tells them apart, and a watch in
//   perfect beat has nothing to name its beats by.
// - Co-axial: the tick is the beat with the longer time from unlock to lock. Its beats are
//   timed at different sounds, so the gap between its timestamps can name the wrong beat with
//   confidence; the two times from unlock to lock differ by several per cent whatever is timed.
//
// Either difference names the beats only when it is clear of its own uncertainty. Until then
// the beats have no names, and the screen draws both in one colour.

/** A difference names the beats only when it is more than this many times its uncertainty. */
export const NAME_SD = 3;

/**
 * A Swiss lever's tick, from the gap between its timed beats. On simulated watches whose two
 * beats sound alike, none was named wrongly at 3 times the uncertainty, and two of the faintest
 * were at 2 times.
 * @param {number} offsetMs how much later than midway between the beats of type 0 the beats of
 *   type 1 fall, in milliseconds
 * @param {number} offsetSdMs its uncertainty
 * @returns {0|1|null} the type that is the tick: the one followed by the longer gap; null while
 *   the offset is within NAME_SD times its uncertainty of zero
 */
export function tickByGap(offsetMs, offsetSdMs) {
  if (!(Math.abs(offsetMs) > NAME_SD * offsetSdMs)) return null;
  // Type 1 falling late leaves the longer gap after type 0.
  return offsetMs > 0 ? 0 : 1;
}

/**
 * A co-axial's tick, from each beat type's time from unlock to lock.
 * @param {[number, number]} liftMs the time from unlock to lock in the beats of type 0 and of
 *   type 1, in milliseconds
 * @param {[number, number]} liftSd their scatter
 * @returns {0|1|null} the type with the longer time; null while the two differ by no more than
 *   NAME_SD times their combined scatter
 */
export function tickByLift(liftMs, liftSd) {
  const difference = liftMs[0] - liftMs[1];
  if (!(Math.abs(difference) > NAME_SD * Math.hypot(liftSd[0], liftSd[1]))) return null;
  return difference > 0 ? 0 : 1;
}
