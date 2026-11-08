/** Strip C0/C1 control characters, keeping tab and newline. Run this over any
 * string that came from the model or a remote server before it is printed to a
 * terminal or a CI log, so it cannot inject ANSI/OSC escape sequences (cursor
 * moves, screen clears, OSC 52 clipboard writes, OSC 8 disguised links) or a
 * bare carriage return that overwrites the line. */
export function stripControlChars(value: string): string {
  // Dropped: 00-08, 0B-1F (so \r too), DEL 7F, and C1 80-9F. Kept: \t and \n.
  // eslint-disable-next-line no-control-regex -- matching control chars is the point
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
