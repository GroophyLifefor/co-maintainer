/** Thrown when the model stopped at its output limit before writing a word.
 * Its own module so the batch can tell it apart without importing every
 * provider. */
export class OutputLimitError extends Error {}
