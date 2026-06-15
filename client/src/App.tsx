import { useEffect, useMemo, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  DeclaredNumber,
  DiceResult,
  PublicPlayer,
  PublicRoomState,
  ServerAck
} from "../../../shared/types";

type Props = {
  socket: Socket;
};

const colorLabels: Record<PublicPlayer["color"], string> = {
  red: "赤",
  blue: "青",
  green: "緑",
  yellow: "黄"
};

const colorValues: Record<PublicPlayer["color"], string> = {
  red: "#EF4444",
  blue: "#3B82F6",
  green: "#22C55E",
  yellow: "#EAB308"
};

const emptyName = "プレイヤー";

function App({ socket }: Props) {
  const queryRoomId = new URLSearchParams(window.location.search).get("room") ?? "";
  const [playerName, setPlayerName] = useState(localStorage.getItem("lieBridgeName") ?? "");
  const [joinRoomId, setJoinRoomId] = useState(queryRoomId);
  const [roomId, setRoomId] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [privateDice, setPrivateDice] = useState<DiceResult | null>(null);
  const [revealedDice, setRevealedDice] = useState<DiceResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    socket.on("roomUpdated", ({ room: nextRoom }: { room: PublicRoomState }) => {
      setRoom(nextRoom);
      setRoomId(nextRoom.id);
      if (nextRoom.phase === "rolling" || nextRoom.status === "lobby" || nextRoom.status === "finished") {
        setPrivateDice(null);
      }
      if (nextRoom.phase !== "resolving") {
        setRevealedDice(null);
      }
    });
    socket.on("privateDiceResult", ({ diceResult }: { diceResult: DiceResult }) => {
      setPrivateDice(diceResult);
    });
    socket.on("diceRevealed", ({ diceResult }: { diceResult: DiceResult }) => {
      setRevealedDice(diceResult);
    });
    socket.on("connect_error", () => setError("サーバーに接続できません"));

    return () => {
      socket.off("roomUpdated");
      socket.off("privateDiceResult");
      socket.off("diceRevealed");
      socket.off("connect_error");
    };
  }, [socket]);

  const me = useMemo(() => room?.players.find((player) => player.id === playerId) ?? null, [room, playerId]);
  const currentTurnPlayer = useMemo(
    () => room?.players.find((player) => player.id === room.currentTurnPlayerId) ?? null,
    [room]
  );
  const inviteUrl = room ? `${window.location.origin}${window.location.pathname}?room=${room.id}` : "";
  const isMyTurn = Boolean(room && playerId && room.currentTurnPlayerId === playerId);
  const myActivePiece = me?.pieces.find((piece) => piece.status === "active") ?? null;
  const canChallenge = Boolean(
    room?.phase === "challengeWindow" &&
      !isMyTurn &&
      !room.challengerId &&
      myActivePiece &&
      !me?.isEliminated
  );
  const secondsLeft = room?.challengeEndsAt
    ? Math.max(0, Math.ceil((room.challengeEndsAt - now) / 1000))
    : room?.declareEndsAt
      ? Math.max(0, Math.ceil((room.declareEndsAt - now) / 1000))
      : null;

  const emitWithAck = <T extends Record<string, unknown>>(
    event: string,
    payload: T,
    onOk?: (ack: Extract<ServerAck<{ roomId?: string; playerId?: string }>, { ok: true }>) => void
  ) => {
    setError("");
    socket.emit(event, payload, (ack: ServerAck<{ roomId?: string; playerId?: string }>) => {
      if (!ack.ok) {
        setError(ack.error);
        return;
      }
      onOk?.(ack);
    });
  };

  const rememberName = () => {
    const name = playerName.trim() || emptyName;
    localStorage.setItem("lieBridgeName", name);
    return name;
  };

  const createRoom = () => {
    const name = rememberName();
    emitWithAck("createRoom", { playerName: name }, (ack) => {
      setPlayerId(ack.playerId ?? "");
      setRoomId(ack.roomId ?? "");
    });
  };

  const joinRoom = () => {
    const name = rememberName();
    emitWithAck("joinRoom", { roomId: joinRoomId.trim().toUpperCase(), playerName: name }, (ack) => {
      setPlayerId(ack.playerId ?? "");
      setRoomId(ack.roomId ?? "");
    });
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  };

  const action = (event: string, payload: Record<string, unknown> = {}) => {
    if (!roomId) return;
    emitWithAck(event, { roomId, ...payload });
  };

  if (!room) {
    return (
      <main className="shell start-shell">
        <section className="start-hero">
          <div className="sky-mark">Lie Bridge Online</div>
          <h1>雲の一本橋で、ほんの少しだけ大胆に。</h1>
          <p>特殊ダイスの出目を隠して宣言し、ウソを見抜きながら3つのコマをゴールへ運ぶ対戦ブラフゲーム。</p>
        </section>

        <section className="entry-panel">
          <label>
            プレイヤー名
            <input
              value={playerName}
              maxLength={16}
              placeholder="例：あおい"
              onChange={(event) => setPlayerName(event.target.value)}
            />
          </label>
          <button className="primary" onClick={createRoom}>
            ルームを作る
          </button>

          <div className="join-row">
            <label>
              ルームID
              <input
                value={joinRoomId}
                maxLength={8}
                placeholder="ABC123"
                onChange={(event) => setJoinRoomId(event.target.value.toUpperCase())}
              />
            </label>
            <button onClick={joinRoom}>参加</button>
          </div>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="shell game-shell">
      <header className="top-bar">
        <div>
          <div className="room-code">ROOM {room.id}</div>
          <h1>Lie Bridge Online</h1>
        </div>
        <div className="turn-chip">
          {room.status === "lobby"
            ? "ロビー"
            : room.status === "finished"
              ? "ゲーム終了"
              : `${currentTurnPlayer?.name ?? "?"} の手番`}
          {secondsLeft !== null && room.status === "playing" && <span>{secondsLeft}s</span>}
        </div>
      </header>

      {room.status === "lobby" ? (
        <Lobby
          room={room}
          me={me}
          inviteUrl={inviteUrl}
          copied={copied}
          copyInvite={copyInvite}
          startGame={() => action("startGame")}
          error={error}
        />
      ) : (
        <div className="play-layout">
          <section className="board-zone">
            <StatusStrip
              room={room}
              privateDice={privateDice}
              revealedDice={revealedDice}
              isMyTurn={isMyTurn}
              currentTurnPlayer={currentTurnPlayer}
            />
            <Bridge room={room} />
            <Controls
              room={room}
              isMyTurn={isMyTurn}
              canChallenge={canChallenge}
              rollDice={() => action("rollDice")}
              declareNumber={(declaredNumber) => action("declareNumber", { declaredNumber })}
              challenge={() => action("challenge")}
              rematch={() => action("rematch")}
              backToLobby={() => action("backToLobby")}
              isHost={Boolean(me?.isHost)}
            />
          </section>

          <aside className="side-panel">
            <PlayerList room={room} playerId={playerId} />
            <LogPanel logs={room.logs} />
          </aside>
        </div>
      )}

      {error && <div className="toast">{error}</div>}
    </main>
  );
}

function Lobby({
  room,
  me,
  inviteUrl,
  copied,
  copyInvite,
  startGame,
  error
}: {
  room: PublicRoomState;
  me: PublicPlayer | null;
  inviteUrl: string;
  copied: boolean;
  copyInvite: () => void;
  startGame: () => void;
  error: string;
}) {
  return (
    <section className="lobby-panel">
      <div className="invite-box">
        <span>招待URL</span>
        <code>{inviteUrl}</code>
        <button onClick={copyInvite}>{copied ? "コピー済み" : "コピー"}</button>
      </div>

      <PlayerList room={room} playerId={me?.id ?? ""} />

      <button className="primary wide" disabled={!me?.isHost || room.players.length < 2} onClick={startGame}>
        ゲーム開始
      </button>
      {!me?.isHost && <p className="hint">ホストがゲームを開始します。</p>}
      {room.players.length < 2 && <p className="hint">開始には2人以上必要です。</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function StatusStrip({
  room,
  privateDice,
  revealedDice,
  isMyTurn,
  currentTurnPlayer
}: {
  room: PublicRoomState;
  privateDice: DiceResult | null;
  revealedDice: DiceResult | null;
  isMyTurn: boolean;
  currentTurnPlayer: PublicPlayer | null;
}) {
  return (
    <section className="status-strip">
      <div>
        <span className="label">手番</span>
        <strong>{currentTurnPlayer?.name ?? "-"}</strong>
      </div>
      <div>
        <span className="label">フェーズ</span>
        <strong>{phaseText(room.phase, room.status)}</strong>
      </div>
      <div>
        <span className="label">宣言</span>
        <strong>{room.currentDeclaredNumber ? `${room.currentDeclaredNumber}` : "-"}</strong>
      </div>
      <div>
        <span className="label">{revealedDice ? "公開出目" : isMyTurn ? "自分の出目" : "出目"}</span>
        <strong>{revealedDice ?? privateDice ?? "非公開"}</strong>
      </div>
    </section>
  );
}

function Bridge({ room }: { room: PublicRoomState }) {
  const cells = Array.from({ length: room.bridgeLength + 1 }, (_, index) => index);

  return (
    <section className="bridge-wrap" aria-label="橋の盤面">
      <div className="cloud cloud-left" />
      <div className="cloud cloud-right" />
      <div className="bridge">
        {cells.map((position) => (
          <div className="bridge-cell" key={position}>
            <span>{position === 0 ? "START" : position}</span>
            <div className="piece-stack">
              {room.players.flatMap((player) =>
                player.pieces
                  .filter((piece) => piece.status === "active" && Math.min(piece.position, room.bridgeLength) === position)
                  .map((piece) => (
                    <span
                      className="piece"
                      key={piece.id}
                      title={`${player.name} のコマ`}
                      style={{ background: colorValues[player.color] }}
                    />
                  ))
              )}
            </div>
          </div>
        ))}
        <div className="goal-cell">
          <span>GOAL</span>
          <div className="piece-stack">
            {room.players.flatMap((player) =>
              player.pieces
                .filter((piece) => piece.status === "goal" || (piece.status === "active" && piece.position > room.bridgeLength))
                .map((piece) => (
                  <span
                    className="piece goal-piece"
                    key={piece.id}
                    title={`${player.name} のゴール候補`}
                    style={{ background: colorValues[player.color] }}
                  />
                ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Controls({
  room,
  isMyTurn,
  canChallenge,
  rollDice,
  declareNumber,
  challenge,
  rematch,
  backToLobby,
  isHost
}: {
  room: PublicRoomState;
  isMyTurn: boolean;
  canChallenge: boolean;
  rollDice: () => void;
  declareNumber: (declaredNumber: DeclaredNumber) => void;
  challenge: () => void;
  rematch: () => void;
  backToLobby: () => void;
  isHost: boolean;
}) {
  if (room.status === "finished") {
    return (
      <section className="controls finished-controls">
        <strong>{room.resultText}</strong>
        <button className="primary" disabled={!isHost} onClick={rematch}>
          もう一度遊ぶ
        </button>
        <button disabled={!isHost} onClick={backToLobby}>
          ロビーに戻る
        </button>
      </section>
    );
  }

  return (
    <section className="controls">
      <button className="primary" disabled={!isMyTurn || room.phase !== "rolling"} onClick={rollDice}>
        ダイスを振る
      </button>
      <div className="declare-buttons">
        {[1, 2, 3, 4].map((number) => (
          <button
            key={number}
            disabled={!isMyTurn || room.phase !== "declaring"}
            onClick={() => declareNumber(number as DeclaredNumber)}
          >
            {number}
          </button>
        ))}
      </div>
      <button className="danger" disabled={!canChallenge} onClick={challenge}>
        ウソだ！
      </button>
    </section>
  );
}

function PlayerList({ room, playerId }: { room: PublicRoomState; playerId: string }) {
  return (
    <section className="players">
      <h2>プレイヤー</h2>
      {room.players.map((player) => {
        const waiting = player.pieces.filter((piece) => piece.status === "waiting").length;
        const goals = player.pieces.filter((piece) => piece.status === "goal").length;
        const fallen = player.pieces.filter((piece) => piece.status === "fallen").length;
        const score = player.pieces.reduce((sum, piece) => sum + (piece.score ?? 0), 0);

        return (
          <article className={`player-card ${player.id === room.currentTurnPlayerId ? "current" : ""}`} key={player.id}>
            <div className="player-title">
              <span className="color-dot" style={{ background: colorValues[player.color] }} />
              <strong>
                {player.name}
                {player.id === playerId ? "（あなた）" : ""}
              </strong>
              {player.isHost && <span className="badge">HOST</span>}
            </div>
            <div className="player-stats">
              <span>{colorLabels[player.color]}</span>
              <span>ゴール {goals}</span>
              <span>待機 {waiting}</span>
              <span>落下 {fallen}</span>
              <span>点 {score}</span>
            </div>
            {!player.isConnected && <p className="mini-alert">切断中</p>}
            {player.isEliminated && <p className="mini-alert">観戦状態</p>}
          </article>
        );
      })}
    </section>
  );
}

function LogPanel({ logs }: { logs: string[] }) {
  return (
    <section className="logs">
      <h2>ログ</h2>
      <div className="log-list">
        {[...logs].reverse().map((log, index) => (
          <p key={`${log}-${index}`}>{log}</p>
        ))}
      </div>
    </section>
  );
}

function phaseText(phase: PublicRoomState["phase"], status: PublicRoomState["status"]) {
  if (status === "finished") return "終了";
  if (status === "lobby") return "待機";
  switch (phase) {
    case "rolling":
      return "ダイス";
    case "declaring":
      return "宣言";
    case "challengeWindow":
      return "疑い受付";
    case "resolving":
      return "判定";
    default:
      return "-";
  }
}

export default App;
