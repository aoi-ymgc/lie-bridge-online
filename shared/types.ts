export type DiceResult = 1 | 2 | 3 | 4 | "X";
export type DeclaredNumber = 1 | 2 | 3 | 4;
export type PlayerColor = "red" | "blue" | "green" | "yellow";
export type PieceStatus = "waiting" | "active" | "goal" | "fallen";
export type RoomStatus = "lobby" | "playing" | "finished";
export type RoomPhase =
  | "rolling"
  | "declaring"
  | "challengeWindow"
  | "resolving"
  | null;
export type RoundOutcome = "success" | "failure" | "skip";

export type Piece = {
  id: string;
  status: PieceStatus;
  position: number;
  goalOrder?: number;
  score?: number;
};

export type PublicPlayer = {
  id: string;
  name: string;
  color: PlayerColor;
  order: number;
  isHost: boolean;
  isConnected: boolean;
  isEliminated: boolean;
  pieces: Piece[];
};

export type RoundResult = {
  id: string;
  actorName: string;
  challengerName?: string;
  declaredNumber: DeclaredNumber | null;
  diceResult: DiceResult | null;
  outcome: RoundOutcome;
  summary: string;
};

export type PublicRoomState = {
  id: string;
  status: RoomStatus;
  phase: RoomPhase;
  players: PublicPlayer[];
  currentTurnPlayerId: string | null;
  currentDeclaredNumber: DeclaredNumber | null;
  currentChallengePlayerId: string | null;
  challengerId: string | null;
  challengeSkippedPlayerIds: string[];
  bridgeLength: number;
  goalCount: number;
  logs: string[];
  roundResults: RoundResult[];
  challengeEndsAt: number | null;
  declareEndsAt: number | null;
  revealedDiceResult: DiceResult | null;
  resolutionText: string | null;
  resolutionKind: "truth" | "lie" | "skip" | null;
  resultText: string | null;
  winnerId: string | null;
};

export type ServerAck<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
