/** Recognizes a request to start a tic-tac-toe game in a natural chat message. */
export function isTicTacToeRequest(text: string): boolean {
  return /(?:\uD2F1\s*\uD0DD\s*\uD1A0|tic\s*[- ]?\s*tac\s*[- ]?\s*toe)/iu.test(text);
}
