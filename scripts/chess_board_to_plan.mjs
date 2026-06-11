#!/usr/bin/env node
import fs from 'fs';
import { Chess } from 'chess.js';

const input = fs.readFileSync(0, 'utf8');
const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const files = 'abcdefgh';
const rankLines = new Map();

for (const line of lines) {
  const match = line.match(/^(\d)\s*[:.]?\s*(.+)$/);
  if (!match) continue;
  const rank = Number(match[1]);
  if (rank < 1 || rank > 8) continue;
  const raw = match[2].replace(/\s+/g, '');
  const cells = [];
  for (const char of raw) {
    if ('rnbqkpRNBQKP.'.includes(char)) cells.push(char);
  }
  if (cells.length >= 8) rankLines.set(rank, cells.slice(0, 8));
}

const board = Array.from({ length: 8 }, () => Array(8).fill('.'));
for (const [rank, row] of rankLines.entries()) {
  board[8 - rank] = row;
}

const chess = new Chess();
chess.clear();
for (let rank = 8; rank >= 1; rank -= 1) {
  for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
    const piece = board[8 - rank][fileIndex];
    if (!piece || piece === '.') continue;
    const square = `${files[fileIndex]}${rank}`;
    chess.put({ type: piece.toLowerCase(), color: piece === piece.toUpperCase() ? 'w' : 'b' }, square);
  }
}
chess.turn('w');
const legalMoves = chess.moves({ verbose: true });
const plans = legalMoves.slice(0, 20).map((move) => ({ san: move.san, from: move.from, to: move.to, flags: move.flags }));
const result = {
  ok: rankLines.size >= 5 && legalMoves.length > 0,
  recognizedRanks: Array.from(rankLines.keys()).sort((a, b) => a - b),
  board,
  fen: chess.fen(),
  legalMoveCount: legalMoves.length,
  candidatePlans: plans,
  summary: plans[0] ? `best-effort next move candidates: ${plans.slice(0, 5).map((p) => p.san).join(', ')}` : 'no-candidates'
};
console.log(JSON.stringify(result, null, 2));
