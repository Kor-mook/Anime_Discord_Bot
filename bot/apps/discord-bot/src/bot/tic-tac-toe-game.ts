import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction
} from 'discord.js';
import {
  bestTicTacToeMove,
  createTicTacToeBoard,
  isTicTacToeDraw,
  ticTacToeWinner,
  type TicTacToeCell
} from './tic-tac-toe.js';

export const ticTacToeButtonPrefix = 'tictactoe';
const gameLifetimeMs = 10 * 60 * 1_000;
const games = new Map<string, TicTacToeGame>();

type TicTacToeGame = {
  id: string;
  playerId: string;
  board: TicTacToeCell[];
  expiresAt: number;
};

export type TicTacToeGameMessage = {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

export type TicTacToeGameStart = {
  id: string;
  playerId: string;
  reply: (message: TicTacToeGameMessage) => Promise<unknown>;
};
export async function startTicTacToeGame(input: TicTacToeGameStart): Promise<void> {
  removeExpiredGames();
  const game: TicTacToeGame = {
    id: input.id,
    playerId: input.playerId,
    board: createTicTacToeBoard(),
    expiresAt: Date.now() + gameLifetimeMs
  };
  games.set(game.id, game);
  await input.reply(gameMessage(game, 'You are **X** and Seline is **O**. Your turn.'));
}

export async function handleTicTacToeButton(interaction: ButtonInteraction): Promise<void> {
  const [, gameId, rawMove] = interaction.customId.split(':');
  const move = Number.parseInt(rawMove ?? '', 10);
  const game = gameId ? games.get(gameId) : undefined;
  if (!game || !Number.isInteger(move) || move < 0 || move > 8 || game.expiresAt <= Date.now()) {
    if (gameId) games.delete(gameId);
    await interaction.reply({ content: 'This game has expired. Start a new one with `/loveai tictactoe`.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== game.playerId) {
    await interaction.reply({ content: 'Only the player who started this game can make a move.', ephemeral: true });
    return;
  }
  if (game.board[move] !== null) {
    await interaction.reply({ content: 'That space is already taken.', ephemeral: true });
    return;
  }

  game.board[move] = 'X';
  if (ticTacToeWinner(game.board) === 'X' || isTicTacToeDraw(game.board)) {
    const playerWon = ticTacToeWinner(game.board) === 'X';
    games.delete(game.id);
    await interaction.update(gameMessage(game, playerWon ? 'You win!' : "It's a draw.", true));
    return;
  }

  const botMove = bestTicTacToeMove(game.board, 'O');
  if (botMove !== undefined) game.board[botMove] = 'O';
  const botWon = ticTacToeWinner(game.board) === 'O';
  const draw = isTicTacToeDraw(game.board);
  if (botWon || draw) games.delete(game.id);
  await interaction.update(gameMessage(game, botWon ? 'Seline wins!' : draw ? "It's a draw." : 'Your turn.', botWon || draw));
}

function gameMessage(game: TicTacToeGame, status: string, finished = false): TicTacToeGameMessage {
  const components = [0, 1, 2].map((row) => new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...[0, 1, 2].map((column) => {
      const position = row * 3 + column;
      const cell = game.board[position];
      return new ButtonBuilder()
        .setCustomId(`${ticTacToeButtonPrefix}:${game.id}:${position}`)
        .setLabel(cell ?? '\u00B7')
        .setStyle(cell === 'X' ? ButtonStyle.Primary : cell === 'O' ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(finished || cell !== null);
    })
  ));
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('Tic-tac-toe')
        .setDescription(`**${status}**\nYou: X  |  Seline: O`)
        .setFooter({ text: 'This game expires after 10 minutes.' })
    ],
    components
  };
}

function removeExpiredGames(): void {
  const now = Date.now();
  for (const [id, game] of games) {
    if (game.expiresAt <= now) games.delete(id);
  }
}
