import assert from 'node:assert/strict';
import test from 'node:test';
import { isTicTacToeRequest } from './tic-tac-toe-intent.js';

test('recognizes Korean and English tic-tac-toe requests', () => {
  assert.equal(isTicTacToeRequest('\uB098\uB791 \uD2F1\uD0DD\uD1A0 \uD560\uB798?'), true);
  assert.equal(isTicTacToeRequest('Want to play tic-tac-toe?'), true);
});

test('does not treat ordinary chat as a tic-tac-toe request', () => {
  assert.equal(isTicTacToeRequest('What game should we play later?'), false);
});
