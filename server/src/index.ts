import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { Server } from "socket.io";
import type {
  DeclaredNumber,
  DiceResult,
  Piece,
  PlayerColor,
  PublicPlayer,
  PublicRoomState,
  RoundResult,
  RoomPhase,
  RoomStatus,
  ServerAck
} from "../../shared/types.js";

type Player = PublicPlayer & {
  socketId: string;
};

type Room = {
  id: string;
  status: RoomStatus;
  phase: RoomPhase;
  players: Player[];
  currentTurnPlayerId: string | null;
  currentDiceResult: DiceResult | null;
  currentDeclaredNumber: DeclaredNumber | null;
  currentChallengePlayerId: string | null;
  challengerId: string | null;
  challengeQueueIds: string[];
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
  challengeTimer: NodeJS.Timeout | null;
  declareTimer: NodeJS.Timeout | null;
};

const app = express();
const httpServer = createServer(app);
const allowedOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim())
  : true;
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const clientDist = path.resolve(process.cwd(), "client/dist");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"), (error) => {
    if (error) {
      res.status(404).send("Client build not found. Run npm run build first.");
    }
  });
});

const rooms = new Map<string, Room>();
const colors: PlayerColor[] = ["red", "blue", "green", "yellow"];
const diceFaces: DiceResult[] = [1, 2, 3, 4, "X", "X"];

const makeId = (length = 6) =>
  Array.from({ length }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

const safeName = (name: string) => name.trim().slice(0, 16) || "ななし";

const makePieces = (playerId: string): Piece[] =>
  Array.from({ length: 7 }, (_, index) => ({
    id: `${playerId}-piece-${index + 1}`,
    status: "waiting",
    position: 0
  }));

const publicRoom = (room: Room): PublicRoomState => ({
  id: room.id,
  status: room.status,
  phase: room.phase,
  players: room.players.map(({ socketId: _socketId, ...player }) => player),
  currentTurnPlayerId: room.currentTurnPlayerId,
  currentDeclaredNumber: room.currentDeclaredNumber,
  currentChallengePlayerId: room.currentChallengePlayerId,
  challengerId: room.challengerId,
  challengeSkippedPlayerIds: room.challengeSkippedPlayerIds,
  bridgeLength: room.bridgeLength,
  goalCount: room.goalCount,
  logs: room.logs.slice(-80),
  roundResults: room.roundResults.slice(-8),
  challengeEndsAt: room.challengeEndsAt,
  declareEndsAt: room.declareEndsAt,
  revealedDiceResult: room.revealedDiceResult,
  resolutionText: room.resolutionText,
  resolutionKind: room.resolutionKind,
  resultText: room.resultText,
  winnerId: room.winnerId
});

const emitRoom = (room: Room) => {
  io.to(room.id).emit("roomUpdated", { room: publicRoom(room) });
};

const addLog = (room: Room, message: string) => {
  room.logs.push(message);
  if (room.logs.length > 100) {
    room.logs = room.logs.slice(-100);
  }
  io.to(room.id).emit("turnMessage", { message });
};

const addRoundResult = (room: Room, result: Omit<RoundResult, "id">) => {
  room.roundResults.push({
    id: `${Date.now()}-${room.roundResults.length}`,
    ...result
  });
  if (room.roundResults.length > 12) {
    room.roundResults = room.roundResults.slice(-12);
  }
};

const clearTimers = (room: Room) => {
  if (room.challengeTimer) clearTimeout(room.challengeTimer);
  if (room.declareTimer) clearTimeout(room.declareTimer);
  room.challengeTimer = null;
  room.declareTimer = null;
  room.challengeEndsAt = null;
  room.declareEndsAt = null;
};

const resetChallengeState = (room: Room) => {
  room.currentChallengePlayerId = null;
  room.challengerId = null;
  room.challengeQueueIds = [];
  room.challengeSkippedPlayerIds = [];
  room.challengeEndsAt = null;
  if (room.challengeTimer) clearTimeout(room.challengeTimer);
  room.challengeTimer = null;
};

const activePiece = (player: Player) => player.pieces.find((piece) => piece.status === "active");
const waitingPiece = (player: Player) => player.pieces.find((piece) => piece.status === "waiting");
const goalPieces = (player: Player) => player.pieces.filter((piece) => piece.status === "goal");
const scoreOf = (player: Player) => goalPieces(player).reduce((sum, piece) => sum + (piece.score ?? 0), 0);
const latestGoalPiece = (player: Player) =>
  goalPieces(player).sort((a, b) => (b.goalOrder ?? 0) - (a.goalOrder ?? 0))[0];
const canChallengeWithStake = (player: Player) => Boolean(activePiece(player) || latestGoalPiece(player));

const ensureActivePiece = (player: Player) => {
  if (activePiece(player) || player.isEliminated) return;
  const nextPiece = waitingPiece(player);
  if (!nextPiece) {
    player.isEliminated = true;
    return;
  }
  nextPiece.status = "active";
  nextPiece.position = 0;
};

const refreshElimination = (player: Player) => {
  const canStillMove = player.pieces.some((piece) => piece.status === "active" || piece.status === "waiting");
  player.isEliminated = !canStillMove;
};

const fallActivePiece = (room: Room, player: Player) => {
  const piece = activePiece(player);
  if (!piece) return;
  piece.status = "fallen";
  piece.position = -1;
  addLog(room, `${player.name} のコマが雲の下へ落ちました`);
  ensureActivePiece(player);
  refreshElimination(player);
};

const loseChallengeStake = (room: Room, player: Player) => {
  const piece = activePiece(player);
  if (piece) {
    fallActivePiece(room, player);
    return;
  }

  const goalPiece = latestGoalPiece(player);
  if (!goalPiece) return;
  goalPiece.status = "fallen";
  goalPiece.position = -1;
  goalPiece.goalOrder = undefined;
  goalPiece.score = undefined;
  addLog(room, `${player.name} は賭けたゴール済みコマを失いました`);
  refreshElimination(player);
};

const finalizeGoalIfNeeded = (room: Room, player: Player) => {
  const piece = activePiece(player);
  if (!piece || piece.position <= room.bridgeLength) return;
  room.goalCount += 1;
  piece.status = "goal";
  piece.goalOrder = room.goalCount;
  piece.score = room.goalCount;
  addLog(room, `${player.name} のコマがゴールしました`);
  ensureActivePiece(player);
  refreshElimination(player);
};

const winnerByScore = (players: Player[]) => {
  const ranked = [...players].sort((a, b) => {
    const scoreDiff = scoreOf(b) - scoreOf(a);
    if (scoreDiff) return scoreDiff;
    const goalDiff = goalPieces(b).length - goalPieces(a).length;
    if (goalDiff) return goalDiff;
    const lastGoalA = Math.max(0, ...goalPieces(a).map((piece) => piece.score ?? 0));
    const lastGoalB = Math.max(0, ...goalPieces(b).map((piece) => piece.score ?? 0));
    return lastGoalB - lastGoalA;
  });
  const top = ranked[0];
  const second = ranked[1];
  if (!top || (second && scoreOf(top) === scoreOf(second) && goalPieces(top).length === goalPieces(second).length)) {
    return null;
  }
  return top;
};

const finishGame = (room: Room, winner: Player | null, resultText: string) => {
  clearTimers(room);
  room.status = "finished";
  room.phase = null;
  room.currentTurnPlayerId = null;
  room.currentDiceResult = null;
  room.currentDeclaredNumber = null;
  room.currentChallengePlayerId = null;
  room.challengerId = null;
  room.challengeQueueIds = [];
  room.challengeSkippedPlayerIds = [];
  room.revealedDiceResult = null;
  room.resolutionText = null;
  room.resolutionKind = null;
  room.resultText = resultText;
  room.winnerId = winner?.id ?? null;
  addLog(room, resultText);
  io.to(room.id).emit("gameFinished", { winnerId: winner?.id ?? null, resultText });
  emitRoom(room);
};

const maybeFinishGame = (room: Room) => {
  const normalWinner = room.players.find((player) => goalPieces(player).length >= 3);
  if (normalWinner) {
    finishGame(room, normalWinner, `${normalWinner.name} が3個目のコマをゴールさせました。${normalWinner.name} の勝利です`);
    return true;
  }

  const movablePlayers = room.players.filter((player) => activePiece(player) && !player.isEliminated);
  if (movablePlayers.length === 0) {
    const scoreWinner = winnerByScore(room.players);
    finishGame(
      room,
      scoreWinner,
      scoreWinner ? `全員が動けなくなりました。得点勝負で ${scoreWinner.name} の勝利です` : "全員が動けなくなりました。引き分けです"
    );
    return true;
  }

  return false;
};

const nextTurn = (room: Room, fromPlayerId = room.currentTurnPlayerId) => {
  if (maybeFinishGame(room)) return;

  const activePlayers = room.players.filter((player) => activePiece(player) && !player.isEliminated);
  if (activePlayers.length === 0) {
    maybeFinishGame(room);
    return;
  }

  const currentIndex = room.players.findIndex((player) => player.id === fromPlayerId);
  for (let step = 1; step <= room.players.length; step += 1) {
    const candidate = room.players[(currentIndex + step + room.players.length) % room.players.length];
    if (candidate && activePiece(candidate) && !candidate.isEliminated) {
      room.currentTurnPlayerId = candidate.id;
      room.phase = "rolling";
      room.currentDiceResult = null;
      room.currentDeclaredNumber = null;
      resetChallengeState(room);
      room.revealedDiceResult = null;
      room.resolutionText = null;
      room.resolutionKind = null;
      room.challengeEndsAt = null;
      room.declareEndsAt = null;
      addLog(room, `${candidate.name} の手番です`);
      emitRoom(room);
      return;
    }
  }
};

const resolveChallenge = (room: Room) => {
  const actor = room.players.find((player) => player.id === room.currentTurnPlayerId);
  const challenger = room.players.find((player) => player.id === room.challengerId);
  const declared = room.currentDeclaredNumber;
  const dice = room.currentDiceResult;

  if (!actor || !challenger || !declared || !dice || room.status !== "playing") return;

  const truth = dice !== "X" && dice === declared;
  if (truth) {
    room.resolutionText = `出目は ${dice}。宣言は本当でした`;
    room.resolutionKind = "truth";
    addLog(room, `出目は ${dice}。宣言は本当でした`);
    addRoundResult(room, {
      actorName: actor.name,
      challengerName: challenger.name,
      declaredNumber: declared,
      diceResult: dice,
      outcome: "failure",
      summary: `${challenger.name} の指摘失敗。${actor.name} の宣言は本当でした`
    });
    loseChallengeStake(room, challenger);
    finalizeGoalIfNeeded(room, actor);
  } else {
    room.resolutionText = `出目は ${dice}。宣言はウソでした`;
    room.resolutionKind = "lie";
    addLog(room, `出目は ${dice}。宣言はウソでした`);
    addRoundResult(room, {
      actorName: actor.name,
      challengerName: challenger.name,
      declaredNumber: declared,
      diceResult: dice,
      outcome: "success",
      summary: `${challenger.name} が見破りました。${actor.name} の宣言はウソでした`
    });
    fallActivePiece(room, actor);
    const challengerPiece = activePiece(challenger);
    if (challengerPiece) {
      challengerPiece.position += declared;
      addLog(room, `${challenger.name} のコマが${declared}マス進みました`);
      finalizeGoalIfNeeded(room, challenger);
    } else {
      addLog(room, `${challenger.name} はゴール済みコマを守りました`);
    }
  }

  if (!maybeFinishGame(room)) {
    emitRoom(room);
    setTimeout(() => nextTurn(room, actor.id), 900);
  }
};

const resolveNoChallenge = (room: Room) => {
  const actor = room.players.find((player) => player.id === room.currentTurnPlayerId);
  if (!actor || room.status !== "playing") return;

  clearTimers(room);
  room.phase = "resolving";
  room.currentChallengePlayerId = null;
  room.resolutionText = "全員がスキップしました。移動が確定します";
  room.resolutionKind = "skip";
  addLog(room, room.resolutionText);
  addRoundResult(room, {
    actorName: actor.name,
    declaredNumber: room.currentDeclaredNumber,
    diceResult: null,
    outcome: "skip",
    summary: `${actor.name} の宣言は指摘なしで確定しました`
  });
  finalizeGoalIfNeeded(room, actor);

  if (!maybeFinishGame(room)) {
    emitRoom(room);
    setTimeout(() => nextTurn(room, actor.id), 900);
  }
};

const currentPlayerFromSocket = (socketId: string, roomId?: string) => {
  if (!roomId) return null;
  const room = rooms.get(roomId);
  if (!room) return null;
  const player = room.players.find((item) => item.socketId === socketId);
  if (!player) return null;
  return { room, player };
};

const advanceChallengeTurn = (room: Room, skippedPlayerId?: string) => {
  if (room.challengeTimer) clearTimeout(room.challengeTimer);
  room.challengeTimer = null;

  if (skippedPlayerId && !room.challengeSkippedPlayerIds.includes(skippedPlayerId)) {
    room.challengeSkippedPlayerIds.push(skippedPlayerId);
  }

  const nextId = room.challengeQueueIds.find((playerId) => !room.challengeSkippedPlayerIds.includes(playerId));
  if (!nextId) {
    resolveNoChallenge(room);
    return;
  }

  const nextPlayer = room.players.find((player) => player.id === nextId);
  if (!nextPlayer || !canChallengeWithStake(nextPlayer)) {
    advanceChallengeTurn(room, nextId);
    return;
  }

  room.currentChallengePlayerId = nextId;
  room.challengeEndsAt = Date.now() + 30000;
  room.challengeTimer = setTimeout(() => {
    addLog(room, `${nextPlayer.name} は時間切れでスキップしました`);
    advanceChallengeTurn(room, nextId);
  }, 30000);
  addLog(room, `${nextPlayer.name} が指摘するか選ぶ番です`);
  emitRoom(room);
};

const startChallengeSequence = (room: Room, actor: Player) => {
  resetChallengeState(room);
  const orderedPlayers = room.players
    .slice()
    .sort((a, b) => a.order - b.order);
  const actorIndex = orderedPlayers.findIndex((player) => player.id === actor.id);
  room.challengeQueueIds = orderedPlayers
    .map((_, index) => orderedPlayers[(actorIndex + index + 1 + orderedPlayers.length) % orderedPlayers.length])
    .filter((player) => player.id !== actor.id && canChallengeWithStake(player))
    .map((player) => player.id);
  advanceChallengeTurn(room);
};

const startDeclareTimer = (room: Room) => {
  if (room.declareTimer) clearTimeout(room.declareTimer);
  room.declareEndsAt = Date.now() + 30000;
  room.declareTimer = setTimeout(() => {
    const randomDeclare = (Math.floor(Math.random() * 4) + 1) as DeclaredNumber;
    declareNumber(room, randomDeclare, true);
  }, 30000);
};

const declareNumber = (room: Room, declaredNumber: DeclaredNumber, isTimeout = false) => {
  const actor = room.players.find((player) => player.id === room.currentTurnPlayerId);
  const piece = actor ? activePiece(actor) : null;
  if (!actor || !piece || room.phase !== "declaring") return false;

  if (room.declareTimer) clearTimeout(room.declareTimer);
  room.declareTimer = null;
  room.declareEndsAt = null;
  room.currentDeclaredNumber = declaredNumber;
  piece.position += declaredNumber;
  room.phase = "challengeWindow";
  addLog(room, `${actor.name} は「${declaredNumber}」と宣言しました${isTimeout ? "（時間切れの自動宣言）" : ""}`);
  startChallengeSequence(room, actor);
  return true;
};

const resetRoomForGame = (room: Room) => {
  clearTimers(room);
  room.status = "playing";
  room.phase = "rolling";
  room.currentDiceResult = null;
  room.currentDeclaredNumber = null;
  room.currentChallengePlayerId = null;
  room.challengerId = null;
  room.challengeQueueIds = [];
  room.challengeSkippedPlayerIds = [];
  room.revealedDiceResult = null;
  room.resolutionText = null;
  room.resolutionKind = null;
  room.goalCount = 0;
  room.resultText = null;
  room.winnerId = null;
  room.logs = [];
  room.roundResults = [];
  room.players.forEach((player, index) => {
    player.order = index;
    player.isEliminated = false;
    player.pieces = makePieces(player.id);
    ensureActivePiece(player);
  });
  const starters = room.players.filter((player) => activePiece(player));
  const first = starters[Math.floor(Math.random() * starters.length)];
  room.currentTurnPlayerId = first?.id ?? null;
  addLog(room, "ゲームを開始しました");
  if (first) addLog(room, `${first.name} の手番です`);
};

const makeRoom = (playerName: string, socketId: string): { room: Room; player: Player } => {
  let roomId = makeId();
  while (rooms.has(roomId)) roomId = makeId();

  const player: Player = {
    id: crypto.randomUUID(),
    socketId,
    name: safeName(playerName),
    color: colors[0],
    order: 0,
    isHost: true,
    isConnected: true,
    isEliminated: false,
    pieces: makePieces("host")
  };
  player.pieces = makePieces(player.id);

  const room: Room = {
    id: roomId,
    status: "lobby",
    phase: null,
    players: [player],
    currentTurnPlayerId: null,
    currentDiceResult: null,
    currentDeclaredNumber: null,
    currentChallengePlayerId: null,
    challengerId: null,
    challengeQueueIds: [],
    challengeSkippedPlayerIds: [],
    bridgeLength: 10,
    goalCount: 0,
    logs: [`${player.name} がルームを作りました`],
    roundResults: [],
    challengeEndsAt: null,
    declareEndsAt: null,
    revealedDiceResult: null,
    resolutionText: null,
    resolutionKind: null,
    resultText: null,
    winnerId: null,
    challengeTimer: null,
    declareTimer: null
  };

  rooms.set(roomId, room);
  return { room, player };
};

io.on("connection", (socket) => {
  socket.on("createRoom", (payload: { playerName: string }, ack?: (response: ServerAck<{ roomId: string; playerId: string }>) => void) => {
    const { room, player } = makeRoom(payload.playerName, socket.id);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    ack?.({ ok: true, roomId: room.id, playerId: player.id });
    emitRoom(room);
  });

  socket.on("joinRoom", (payload: { roomId: string; playerName: string }, ack?: (response: ServerAck<{ roomId: string; playerId: string }>) => void) => {
    const room = rooms.get(payload.roomId.trim().toUpperCase());
    if (!room) {
      ack?.({ ok: false, error: "ルームが見つかりません" });
      return;
    }
    if (room.status !== "lobby") {
      ack?.({ ok: false, error: "ゲーム開始後は参加できません" });
      return;
    }
    if (room.players.length >= 4) {
      ack?.({ ok: false, error: "このルームは満員です" });
      return;
    }

    const player: Player = {
      id: crypto.randomUUID(),
      socketId: socket.id,
      name: safeName(payload.playerName),
      color: colors[room.players.length],
      order: room.players.length,
      isHost: false,
      isConnected: true,
      isEliminated: false,
      pieces: []
    };
    player.pieces = makePieces(player.id);
    room.players.push(player);
    addLog(room, `${player.name} が参加しました`);

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    ack?.({ ok: true, roomId: room.id, playerId: player.id });
    emitRoom(room);
  });

  socket.on("startGame", (payload: { roomId: string }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: false, error: "ルームに参加していません" });
      return;
    }
    const { room, player } = state;
    if (!player.isHost) {
      ack?.({ ok: false, error: "ホストだけが開始できます" });
      return;
    }
    if (room.players.length < 2 || room.players.length > 4) {
      ack?.({ ok: false, error: "2〜4人で開始できます" });
      return;
    }
    resetRoomForGame(room);
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on("rollDice", (payload: { roomId: string }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: false, error: "ルームに参加していません" });
      return;
    }
    const { room, player } = state;
    if (room.phase !== "rolling" || room.currentTurnPlayerId !== player.id) {
      ack?.({ ok: false, error: "今はダイスを振れません" });
      return;
    }
    room.currentDiceResult = diceFaces[Math.floor(Math.random() * diceFaces.length)];
    room.phase = "declaring";
    addLog(room, `${player.name} がダイスを振りました`);
    socket.emit("privateDiceResult", { diceResult: room.currentDiceResult });
    startDeclareTimer(room);
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on("declareNumber", (payload: { roomId: string; declaredNumber: DeclaredNumber }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: false, error: "ルームに参加していません" });
      return;
    }
    const { room, player } = state;
    if (room.phase !== "declaring" || room.currentTurnPlayerId !== player.id) {
      ack?.({ ok: false, error: "今は宣言できません" });
      return;
    }
    if (![1, 2, 3, 4].includes(payload.declaredNumber)) {
      ack?.({ ok: false, error: "1〜4を宣言してください" });
      return;
    }
    declareNumber(room, payload.declaredNumber);
    ack?.({ ok: true });
  });

  socket.on("challenge", (payload: { roomId: string }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: false, error: "ルームに参加していません" });
      return;
    }
    const { room, player } = state;
    if (room.phase !== "challengeWindow" || room.challengerId) {
      ack?.({ ok: false, error: "今は疑えません" });
      return;
    }
    if (room.currentChallengePlayerId !== player.id) {
      ack?.({ ok: false, error: "まだあなたが選ぶ番ではありません" });
      return;
    }
    if (room.currentTurnPlayerId === player.id || !canChallengeWithStake(player) || !room.currentDiceResult || !room.currentDeclaredNumber) {
      ack?.({ ok: false, error: "このプレイヤーは疑えません" });
      return;
    }

    if (room.challengeTimer) clearTimeout(room.challengeTimer);
    room.challengeTimer = null;
    room.challengeEndsAt = null;
    room.challengerId = player.id;
    room.currentChallengePlayerId = null;
    room.phase = "resolving";
    room.revealedDiceResult = room.currentDiceResult;
    const truth = room.currentDiceResult !== "X" && room.currentDiceResult === room.currentDeclaredNumber;
    room.resolutionText = `出目は ${room.currentDiceResult}。宣言は${truth ? "本当" : "ウソ"}でした`;
    room.resolutionKind = truth ? "truth" : "lie";
    addLog(room, `${player.name} が「ウソだ！」を宣言しました`);
    io.to(room.id).emit("diceRevealed", { diceResult: room.currentDiceResult });
    ack?.({ ok: true });
    emitRoom(room);
    setTimeout(() => resolveChallenge(room), 3600);
  });

  socket.on("skipChallenge", (payload: { roomId: string }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: false, error: "ルームに参加していません" });
      return;
    }
    const { room, player } = state;
    if (room.phase !== "challengeWindow" || room.currentChallengePlayerId !== player.id) {
      ack?.({ ok: false, error: "今はスキップできません" });
      return;
    }
    addLog(room, `${player.name} はスキップしました`);
    ack?.({ ok: true });
    advanceChallengeTurn(room, player.id);
  });

  socket.on("rematch", (payload: { roomId: string }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: false, error: "ルームに参加していません" });
      return;
    }
    const { room, player } = state;
    if (!player.isHost) {
      ack?.({ ok: false, error: "ホストだけが再戦できます" });
      return;
    }
    if (room.players.filter((item) => item.isConnected).length < 2) {
      ack?.({ ok: false, error: "再戦には2人以上必要です" });
      return;
    }
    room.players = room.players.filter((item) => item.isConnected).slice(0, 4);
    room.players.forEach((item, index) => {
      item.order = index;
      item.color = colors[index];
      item.isHost = index === 0;
    });
    resetRoomForGame(room);
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on("backToLobby", (payload: { roomId: string }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: false, error: "ルームに参加していません" });
      return;
    }
    const { room, player } = state;
    if (!player.isHost) {
      ack?.({ ok: false, error: "ホストだけがロビーに戻せます" });
      return;
    }
    clearTimers(room);
    room.status = "lobby";
    room.phase = null;
    room.currentTurnPlayerId = null;
    room.currentDiceResult = null;
    room.currentDeclaredNumber = null;
    room.currentChallengePlayerId = null;
    room.challengerId = null;
    room.challengeQueueIds = [];
    room.challengeSkippedPlayerIds = [];
    room.revealedDiceResult = null;
    room.resolutionText = null;
    room.resolutionKind = null;
    room.resultText = null;
    room.winnerId = null;
    room.logs = ["ロビーに戻りました"];
    room.roundResults = [];
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on("leaveRoom", (payload: { roomId: string }, ack?: (response: ServerAck) => void) => {
    const state = currentPlayerFromSocket(socket.id, payload.roomId);
    if (!state) {
      ack?.({ ok: true });
      return;
    }
    const { room, player } = state;
    if (room.status !== "lobby") {
      ack?.({ ok: false, error: "ゲーム中はトップへ戻れません" });
      return;
    }

    room.players = room.players.filter((item) => item.id !== player.id);
    socket.leave(room.id);
    socket.data.roomId = undefined;
    socket.data.playerId = undefined;
    addLog(room, `${player.name} がロビーを退出しました`);

    if (room.players.length === 0) {
      clearTimers(room);
      rooms.delete(room.id);
    } else {
      if (!room.players.some((item) => item.isHost)) {
        room.players[0].isHost = true;
      }
      emitRoom(room);
    }
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((item) => item.id === socket.data.playerId);
    if (!player) return;

    player.isConnected = false;
    player.socketId = "";
    addLog(room, `${player.name} が切断しました`);

    if (room.status === "lobby") {
      room.players = room.players.filter((item) => item.isConnected);
      if (room.players.length === 0) {
        rooms.delete(room.id);
        clearTimers(room);
        return;
      }
      if (!room.players.some((item) => item.isHost)) {
        room.players[0].isHost = true;
      }
      emitRoom(room);
      return;
    }

    if (!room.players.some((item) => item.isHost && item.isConnected)) {
      const nextHost = room.players.find((item) => item.isConnected);
      if (nextHost) nextHost.isHost = true;
    }

    if (room.status === "playing") {
      setTimeout(() => {
        if (player.isConnected || room.status !== "playing") return;
        player.pieces.forEach((piece) => {
          if (piece.status === "active" || piece.status === "waiting") {
            piece.status = "fallen";
            piece.position = -1;
          }
        });
        player.isEliminated = true;
        addLog(room, `${player.name} は復帰しなかったため観戦状態になりました`);
        if (room.currentTurnPlayerId === player.id || room.challengerId === player.id) {
          clearTimers(room);
          nextTurn(room, player.id);
        } else {
          maybeFinishGame(room);
          emitRoom(room);
        }
      }, 10000);
    }

    emitRoom(room);
  });
});

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, () => {
  console.log(`Lie Bridge Online server listening on http://localhost:${port}`);
});
