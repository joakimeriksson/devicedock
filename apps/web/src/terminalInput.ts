// The backend accepts at most 8192 UTF-16 units per terminal input message and drops the session on more.
/** Splits terminal input into pieces of at most `size` UTF-16 units without splitting a surrogate pair. */
export function chunkInput(data: string, size = 4096): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length; ) {
    let end = Math.min(i + size, data.length);
    if (end < data.length && end - i > 1 && /[\ud800-\udbff]/.test(data[end - 1])) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}
