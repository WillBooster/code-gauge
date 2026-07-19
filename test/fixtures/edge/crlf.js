// CRLF fixture: line endings are rewritten to \r\n by the test helper.
export function greet(name) {
  if (!name) {
    return 'anonymous';
  }
  return `hello ${name}`;
}
