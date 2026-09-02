export type TicTacToeMark = 'X' | 'O';
export type TicTacToeCell = TicTacToeMark | null;
export type TicTacToeBoard = readonly TicTacToeCell[];

export const TIC_TAC_TOE_WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
] as const;

export function createTicTacToeBoard(): TicTacToeCell[] {
  return Array<TicTacToeCell>(9).fill(null);
}

export function ticTacToeWinner(board: TicTacToeBoard): TicTacToeMark | undefined {
  for (const [first, second, third] of TIC_TAC_TOE_WINNING_LINES) {
    const mark = board[first];
    if (mark && mark === board[second] && mark === board[third]) return mark;
  }
  return undefined;
}

export function isTicTacToeDraw(board: TicTacToeBoard): boolean {
  return !ticTacToeWinner(board) && board.every((cell) => cell !== null);
}

export function availableTicTacToeMoves(board: TicTacToeBoard): number[] {
  return board.flatMap((cell, index) => cell === null ? [index] : []);
}

/** Returns an unbeatable move for the supplied mark, or undefined when no move remains. */
export function bestTicTacToeMove(board: TicTacToeBoard, botMark: TicTacToeMark): number | undefined {
  const moves = availableTicTacToeMoves(board);
  if (moves.length === 0) return undefined;

  const opponentMark: TicTacToeMark = botMark === 'X' ? 'O' : 'X';
  let bestScore = Number.NEGATIVE_INFINITY;
  let chosenMove = moves[0];

  for (const move of moves) {
    const next = [...board];
    next[move] = botMark;
    const score = minimax(next, opponentMark, botMark, opponentMark, 0);
    if (score > bestScore) {
      bestScore = score;
      chosenMove = move;
    }
  }
  return chosenMove;
}

function minimax(
  board: TicTacToeBoard,
  currentMark: TicTacToeMark,
  botMark: TicTacToeMark,
  opponentMark: TicTacToeMark,
  depth: number
): number {
  const winner = ticTacToeWinner(board);
  if (winner === botMark) return 10 - depth;
  if (winner === opponentMark) return depth - 10;
  if (isTicTacToeDraw(board)) return 0;

  const scores = availableTicTacToeMoves(board).map((move) => {
    const next = [...board];
    next[move] = currentMark;
    return minimax(next, currentMark === 'X' ? 'O' : 'X', botMark, opponentMark, depth + 1);
  });
  return currentMark === botMark ? Math.max(...scores) : Math.min(...scores);
}
