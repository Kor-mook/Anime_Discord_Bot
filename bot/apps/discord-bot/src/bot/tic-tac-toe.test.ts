import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableTicTacToeMoves,
  bestTicTacToeMove,
  createTicTacToeBoard,
  isTicTacToeDraw,
  ticTacToeWinner
} from './tic-tac-toe.js';

test('starts with a blank board', () => {
  assert.deepEqual(createTicTacToeBoard(), Array(9).fill(null));
  assert.deepEqual(availableTicTacToeMoves(createTicTacToeBoard()), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('identifies wins and draws', () => {
  assert.equal(ticTacToeWinner(['X', 'X', 'X', null, 'O', null, 'O', null, null]), 'X');
  assert.equal(ticTacToeWinner(['X', 'O', 'O', null, 'X', null, null, null, 'X']), 'X');
  assert.equal(isTicTacToeDraw(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']), true);
});

test('chooses an immediate win before another move', () => {
  const board = ['O', 'O', null, 'X', 'X', null, null, null, null] as const;
  assert.equal(bestTicTacToeMove(board, 'O'), 2);
});

test('blocks the player when they threaten to win', () => {
  const board = ['X', 'X', null, 'O', null, null, null, null, null] as const;
  assert.equal(bestTicTacToeMove(board, 'O'), 2);
});
