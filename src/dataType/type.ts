import * as crypto from 'crypto';
import { Chess,Move } from 'chess';

export function generateUniqueId(length: number): string {
  if (length <= 0) {
    throw new Error("Length must be a positive integer");
  }
  const bytes = Math.ceil(length / 2);
  const uniqueId = crypto.randomBytes(bytes).toString('hex');
  // Trim
  return uniqueId.slice(0, length);
}

export interface Room {
  authToken: string;
  board: Chess;
  participants: Map<string,string>;
  gameState: boolean;
  clocks: {
    "w": { remainingTime: number, lastMoveTimestamp: number|null },
    "b": { remainingTime: number, lastMoveTimestamp: number|null },
  },
  activePlayer: string,
  timeout?: NodeJS.Timeout;
  result?: string;
}
export interface MessageParams{
  message: Move;
}
export interface RoomParams {
  opponentUsername?: string,
  preference?: string;
  time? : number;
  user? : string;
}

export interface joinRoomParams{
  roomId: string
}