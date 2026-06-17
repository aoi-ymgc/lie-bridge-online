import { useEffect, useMemo, useRef, useState } from "react";
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

type DiceOverlayState = {
  key: number;
  mode: "rolling" | "private" | "reveal" | "victory";
  dice?: DiceResult;
  title: string;
  detail: string;
  verdict?: "truth" | "lie" | "skip";
};

type ActionBannerState = {
  key: number;
  text: string;
  kind: "move" | "goal" | "fall";
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
  const [showRules, setShowRules] = useState(false);
  const [diceOverlay, setDiceOverlay] = useState<DiceOverlayState | null>(null);
  const [actionBanner, setActionBanner] = useState<ActionBannerState | null>(null);
  const [motionPieceIds, setMotionPieceIds] = useState<Set<string>>(new Set());
  const previousPiecesRef = useRef<Map<string, string>>(new Map());
  const lastLogRef = useRef("");
  const diceRevealTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    socket.on("roomUpdated", ({ room: nextRoom }: { room: PublicRoomState }) => {
      setRoom(nextRoom);
      setRoomId(nextRoom.id);
      if (nextRoom.revealedDiceResult) {
        setRevealedDice(nextRoom.revealedDiceResult);
      }
      if (nextRoom.phase === "rolling" || nextRoom.status === "lobby" || nextRoom.status === "finished") {
        setPrivateDice(null);
        if (!nextRoom.revealedDiceResult) {
          setRevealedDice(null);
        }
      }
      if (nextRoom.phase !== "resolving" && !nextRoom.revealedDiceResult) {
        setRevealedDice(null);
      }
    });
    socket.on("privateDiceResult", ({ diceResult }: { diceResult: DiceResult }) => {
      setPrivateDice(diceResult);
      if (diceRevealTimerRef.current) {
        window.clearTimeout(diceRevealTimerRef.current);
      }
      diceRevealTimerRef.current = window.setTimeout(() => {
        setDiceOverlay({
          key: Date.now(),
          mode: "private",
          dice: diceResult,
          title: "あなたの出目",
          detail: "この出目は自分だけに見えています"
        });
      }, 780);
    });
    socket.on("diceRevealed", ({ diceResult }: { diceResult: DiceResult }) => {
      setRevealedDice(diceResult);
    });
    socket.on("gameFinished", ({ resultText }: { winnerId: string | null; resultText: string }) => {
      setDiceOverlay({
        key: Date.now(),
        mode: "victory",
        title: "勝負あり",
        detail: resultText
      });
    });
    socket.on("connect_error", () => setError("サーバーに接続できません"));

    return () => {
      socket.off("roomUpdated");
      socket.off("privateDiceResult");
      socket.off("diceRevealed");
      socket.off("gameFinished");
      socket.off("connect_error");
      if (diceRevealTimerRef.current) {
        window.clearTimeout(diceRevealTimerRef.current);
      }
    };
  }, [socket]);

  useEffect(() => {
    if (!room || room.status === "finished") return;
    setDiceOverlay((current) => (current?.mode === "victory" ? null : current));
  }, [room?.status, room?.phase]);

  useEffect(() => {
    if (!privateDice) return;
    const timer = window.setTimeout(() => {
      setDiceOverlay((current) => (current?.mode === "private" ? null : current));
    }, 1900);
    return () => window.clearTimeout(timer);
  }, [privateDice]);

  useEffect(() => {
    if (!room?.revealedDiceResult || !room.resolutionText) return;
    setDiceOverlay({
      key: Date.now(),
      mode: "reveal",
      dice: room.revealedDiceResult,
      title: "答え合わせ",
      detail: room.resolutionText,
      verdict: room.resolutionKind ?? undefined
    });
    const timer = window.setTimeout(() => {
      setDiceOverlay((current) => (current?.mode === "reveal" ? null : current));
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [room?.revealedDiceResult, room?.resolutionText, room?.resolutionKind]);

  useEffect(() => {
    if (!room) return;
    const nextMap = new Map<string, string>();
    const changed = new Set<string>();
    room.players.forEach((player) => {
      player.pieces.forEach((piece) => {
        const signature = `${piece.position}:${piece.status}:${piece.goalOrder ?? ""}`;
        nextMap.set(piece.id, signature);
        if (previousPiecesRef.current.has(piece.id) && previousPiecesRef.current.get(piece.id) !== signature) {
          changed.add(piece.id);
        }
      });
    });
    previousPiecesRef.current = nextMap;
    if (changed.size) {
      setMotionPieceIds(changed);
      const timer = window.setTimeout(() => setMotionPieceIds(new Set()), 1000);
      return () => window.clearTimeout(timer);
    }
  }, [room]);

  useEffect(() => {
    const latest = room?.logs.at(-1);
    if (!latest || latest === lastLogRef.current) return;
    lastLogRef.current = latest;
    const kind = latest.includes("ゴール")
      ? "goal"
      : latest.includes("落ち") || latest.includes("失いました")
        ? "fall"
        : latest.includes("進み")
          ? "move"
          : null;
    if (!kind) return;
    setActionBanner({ key: Date.now(), text: latest, kind });
    const timer = window.setTimeout(() => setActionBanner(null), 1800);
    return () => window.clearTimeout(timer);
  }, [room?.logs]);

  const me = useMemo(() => room?.players.find((player) => player.id === playerId) ?? null, [room, playerId]);
  const currentTurnPlayer = useMemo(
    () => room?.players.find((player) => player.id === room.currentTurnPlayerId) ?? null,
    [room]
  );
  const currentChallengePlayer = useMemo(
    () => room?.players.find((player) => player.id === room.currentChallengePlayerId) ?? null,
    [room]
  );
  const inviteUrl = room ? `${window.location.origin}${window.location.pathname}?room=${room.id}` : "";
  const isMyTurn = Boolean(room && playerId && room.currentTurnPlayerId === playerId);
  const myActivePiece = me?.pieces.find((piece) => piece.status === "active") ?? null;
  const myGoalPieces = me?.pieces.filter((piece) => piece.status === "goal") ?? [];
  const isGoalStakeChallenge = Boolean(!myActivePiece && myGoalPieces.length > 0);
  const challengeStakeLabel = isGoalStakeChallenge ? "ゴール済みコマを賭けてウソだ！" : "ウソだ！";
  const canChallenge = Boolean(
    room?.phase === "challengeWindow" &&
      room.currentChallengePlayerId === playerId &&
      !isMyTurn &&
      !room.challengerId &&
      (myActivePiece || myGoalPieces.length > 0)
  );
  const canSkipChallenge = Boolean(room?.phase === "challengeWindow" && room.currentChallengePlayerId === playerId);
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

  const clearEndOverlays = () => {
    setDiceOverlay((current) => (current?.mode === "victory" ? null : current));
    setActionBanner(null);
  };

  const rollDiceWithAnimation = () => {
    setDiceOverlay({
      key: Date.now(),
      mode: "rolling",
      title: "ダイスロール！",
      detail: "何が出るかは、まだ雲の中"
    });
    action("rollDice");
  };

  const leaveToTitle = () => {
    clearEndOverlays();
    if (!roomId) {
      setRoom(null);
      return;
    }
    emitWithAck("leaveRoom", { roomId }, () => {
      setRoom(null);
      setRoomId("");
      setPlayerId("");
      setPrivateDice(null);
      setRevealedDice(null);
      setDiceOverlay(null);
      window.history.replaceState({}, "", window.location.pathname);
    });
  };

  if (!room) {
    return (
      <main className="shell start-shell">
        <section className="start-hero">
          <div className="sky-mark">Lie Bridge Online</div>
          <h1>時に慎重に、時に大胆に。</h1>
          <p>特殊ダイスの出目を隠して宣言し、ウソを見抜きながら3つのコマをゴールへ運ぶ対戦ブラフゲーム。</p>
          <button className="ghost" onClick={() => setShowRules(true)}>
            ルールを見る
          </button>
        </section>

        <section className="entry-panel">
          <label>
            プレイヤー名
            <input
              value={playerName}
              maxLength={16}
              placeholder="例：プレイヤー1"
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
        {showRules && <RulesModal onClose={() => setShowRules(false)} />}
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
        <div className="top-actions">
          <button className="ghost" onClick={() => setShowRules(true)}>
            ルール
          </button>
          <TurnTimer
            room={room}
            secondsLeft={secondsLeft}
            currentTurnPlayer={currentTurnPlayer}
            currentChallengePlayer={currentChallengePlayer}
          />
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
          leaveToTitle={leaveToTitle}
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
              currentChallengePlayer={currentChallengePlayer}
            />
            <Bridge room={room} motionPieceIds={motionPieceIds} />
            <Controls
              room={room}
              isMyTurn={isMyTurn}
              canChallenge={canChallenge}
              canSkipChallenge={canSkipChallenge}
              challengeStakeLabel={challengeStakeLabel}
              rollDice={rollDiceWithAnimation}
              declareNumber={(declaredNumber) => action("declareNumber", { declaredNumber })}
              challenge={() => action("challenge")}
              skipChallenge={() => action("skipChallenge")}
              rematch={() => {
                clearEndOverlays();
                action("rematch");
              }}
              backToLobby={() => {
                clearEndOverlays();
                action("backToLobby");
              }}
              isHost={Boolean(me?.isHost)}
            />
          </section>

          <aside className="side-panel">
            <PlayerList room={room} playerId={playerId} />
            <RoundResults room={room} />
            <LogPanel room={room} />
          </aside>
        </div>
      )}

      {diceOverlay && <DiceOverlay state={diceOverlay} onDismiss={() => setDiceOverlay(null)} />}
      {actionBanner && <ActionBanner banner={actionBanner} />}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}
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
  leaveToTitle,
  error
}: {
  room: PublicRoomState;
  me: PublicPlayer | null;
  inviteUrl: string;
  copied: boolean;
  copyInvite: () => void;
  startGame: () => void;
  leaveToTitle: () => void;
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

      <div className="lobby-actions">
        <button onClick={leaveToTitle}>最初の画面に戻る</button>
        <button className="primary" disabled={!me?.isHost || room.players.length < 2} onClick={startGame}>
          ゲーム開始
        </button>
      </div>
      {!me?.isHost && <p className="hint">ホストがゲームを開始します。</p>}
      {room.players.length < 2 && <p className="hint">開始には2人以上必要です。</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function TurnTimer({
  room,
  secondsLeft,
  currentTurnPlayer,
  currentChallengePlayer
}: {
  room: PublicRoomState;
  secondsLeft: number | null;
  currentTurnPlayer: PublicPlayer | null;
  currentChallengePlayer: PublicPlayer | null;
}) {
  const title =
    room.status === "lobby"
      ? "ロビー"
      : room.status === "finished"
        ? "ゲーム終了"
        : room.phase === "challengeWindow"
          ? `${currentChallengePlayer?.name ?? "?"} が選ぶ番`
          : `${currentTurnPlayer?.name ?? "?"} の手番`;
  const label = room.phase === "challengeWindow" ? "指摘判断" : room.phase === "declaring" ? "宣言時間" : "現在";

  return (
    <div className={`turn-timer ${secondsLeft !== null && secondsLeft <= 5 ? "urgent" : ""}`}>
      <span>{label}</span>
      <strong>{title}</strong>
      {secondsLeft !== null && room.status === "playing" && <b>{secondsLeft}</b>}
    </div>
  );
}

function StatusStrip({
  room,
  privateDice,
  revealedDice,
  isMyTurn,
  currentTurnPlayer,
  currentChallengePlayer
}: {
  room: PublicRoomState;
  privateDice: DiceResult | null;
  revealedDice: DiceResult | null;
  isMyTurn: boolean;
  currentTurnPlayer: PublicPlayer | null;
  currentChallengePlayer: PublicPlayer | null;
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
        <span className="label">指摘判断</span>
        <strong>{currentChallengePlayer?.name ?? "-"}</strong>
      </div>
      <div>
        <span className="label">{revealedDice ? "公開出目" : isMyTurn ? "自分の出目" : "出目"}</span>
        <strong>{revealedDice ?? privateDice ?? "非公開"}</strong>
      </div>
      <div>
        <span className="label">宣言</span>
        <strong>{room.currentDeclaredNumber ? `${room.currentDeclaredNumber}` : "-"}</strong>
      </div>
    </section>
  );
}

function Bridge({ room, motionPieceIds }: { room: PublicRoomState; motionPieceIds: Set<string> }) {
  const cells = Array.from({ length: room.bridgeLength + 1 }, (_, index) => index);

  return (
    <section className="bridge-wrap" aria-label="橋の盤面">
      <div className="cloud cloud-left" />
      <div className="cloud cloud-right" />
      <div className="reserve-dock" aria-label="待機中のコマ">
        <span className="reserve-title">残機</span>
        {room.players.map((player) => {
          const waitingPieces = player.pieces.filter((piece) => piece.status === "waiting");
          return (
            <div className="reserve-row" key={player.id}>
              <strong style={{ color: colorValues[player.color] }}>{player.name}</strong>
              <div className="reserve-pieces">
                {waitingPieces.length ? (
                  waitingPieces.map((piece) => (
                    <span
                      className="piece reserve-piece"
                      key={piece.id}
                      title={`${player.name} の残機`}
                      style={{ background: colorValues[player.color] }}
                    />
                  ))
                ) : (
                  <span className="reserve-empty">なし</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
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
                      className={`piece ${motionPieceIds.has(piece.id) ? "piece-moving" : ""}`}
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
                    className={`piece goal-piece ${motionPieceIds.has(piece.id) ? "piece-goal-burst" : ""}`}
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
  canSkipChallenge,
  challengeStakeLabel,
  rollDice,
  declareNumber,
  challenge,
  skipChallenge,
  rematch,
  backToLobby,
  isHost
}: {
  room: PublicRoomState;
  isMyTurn: boolean;
  canChallenge: boolean;
  canSkipChallenge: boolean;
  challengeStakeLabel: string;
  rollDice: () => void;
  declareNumber: (declaredNumber: DeclaredNumber) => void;
  challenge: () => void;
  skipChallenge: () => void;
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
      <div className="challenge-actions">
        <button className="danger" disabled={!canChallenge} onClick={challenge}>
          {challengeStakeLabel}
        </button>
        <button disabled={!canSkipChallenge} onClick={skipChallenge}>
          スキップ
        </button>
      </div>
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
        const choosing = room.currentChallengePlayerId === player.id;

        return (
          <article
            className={`player-card ${player.id === room.currentTurnPlayerId ? "current" : ""} ${choosing ? "choosing" : ""}`}
            key={player.id}
          >
            <div className="player-title">
              <span className="color-dot" style={{ background: colorValues[player.color] }} />
              <strong>
                {player.name}
                {player.id === playerId ? "（あなた）" : ""}
              </strong>
              {player.isHost && <span className="badge">HOST</span>}
              {choosing && <span className="badge choose-badge">選択中</span>}
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

function RoundResults({ room }: { room: PublicRoomState }) {
  const results = [...room.roundResults].reverse();

  return (
    <section className="round-results">
      <h2>ラウンド結果</h2>
      {results.length === 0 ? (
        <p className="empty-results">まだ判定はありません</p>
      ) : (
        <div className="result-list">
          {results.map((result) => (
            <article className={`result-card ${result.outcome}`} key={result.id}>
              <span className="result-badge">
                {result.outcome === "success" ? "指摘成功" : result.outcome === "failure" ? "指摘失敗" : "確定"}
              </span>
              <strong>{result.summary}</strong>
              <p>
                宣言 {result.declaredNumber ?? "-"} / 出目 {result.diceResult ?? "非公開"}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LogPanel({ room }: { room: PublicRoomState }) {
  return (
    <section className="logs">
      <h2>ログ</h2>
      <div className="log-list">
        {[...room.logs].reverse().map((log, index) => (
          <p key={`${log}-${index}`}>
            <ColoredLogLine log={log} players={room.players} />
          </p>
        ))}
      </div>
    </section>
  );
}

function ColoredLogLine({ log, players }: { log: string; players: PublicPlayer[] }) {
  const orderedPlayers = players.slice().sort((a, b) => b.name.length - a.name.length);
  const segments: Array<{ text: string; player?: PublicPlayer }> = [];
  let cursor = 0;

  while (cursor < log.length) {
    let nextMatch: { index: number; player: PublicPlayer } | null = null;
    orderedPlayers.forEach((player) => {
      const index = log.indexOf(player.name, cursor);
      if (index >= 0 && (!nextMatch || index < nextMatch.index)) {
        nextMatch = { index, player };
      }
    });

    if (!nextMatch) {
      segments.push({ text: log.slice(cursor) });
      break;
    }

    if (nextMatch.index > cursor) {
      segments.push({ text: log.slice(cursor, nextMatch.index) });
    }
    segments.push({ text: nextMatch.player.name, player: nextMatch.player });
    cursor = nextMatch.index + nextMatch.player.name.length;
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.player ? (
          <strong className="log-name" key={`${segment.text}-${index}`} style={{ color: colorValues[segment.player.color] }}>
            {segment.text}
          </strong>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        )
      )}
    </>
  );
}

function DiceOverlay({ state, onDismiss }: { state: DiceOverlayState; onDismiss: () => void }) {
  const verdictLabel =
    state.verdict === "truth" ? "ホント" : state.verdict === "lie" ? "ウソ" : state.verdict === "skip" ? "確定" : "";
  const cutinLabel = state.verdict === "truth" ? "指摘失敗！" : state.verdict === "lie" ? "見破った！" : "";

  return (
    <div
      className={`dice-overlay ${state.mode} ${state.verdict ?? ""}`}
      key={state.key}
      onClick={state.mode === "victory" ? onDismiss : undefined}
    >
      <div className="dice-card" onClick={state.mode === "victory" ? onDismiss : (event) => event.stopPropagation()}>
        <span className="dice-title">{state.title}</span>
        {state.mode === "rolling" && <div className="big-dice rolling-dice">?</div>}
        {state.dice && <div className={`big-dice ${state.dice === "X" ? "x-face" : ""}`}>{state.dice}</div>}
        {cutinLabel && <div className="cutin-text">{cutinLabel}</div>}
        {verdictLabel && <strong className="verdict-label">{verdictLabel}</strong>}
        <p>{state.detail}</p>
        {state.mode === "victory" && <button onClick={onDismiss}>閉じる</button>}
      </div>
    </div>
  );
}

function ActionBanner({ banner }: { banner: ActionBannerState }) {
  return (
    <div className={`action-banner ${banner.kind}`} key={banner.key}>
      {banner.text}
    </div>
  );
}

function RulesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rules-title">
      <section className="rules-modal">
        <div className="modal-head">
          <h2 id="rules-title">遊び方</h2>
          <button onClick={onClose}>閉じる</button>
        </div>
        <div className="rules-grid">
          <article>
            <h3>目的</h3>
            <p>自分のコマを先に3個ゴールさせた人が勝ちです。</p>
          </article>
          <article>
            <h3>手番</h3>
            <p>ダイスを振り、出目を見たあと、1〜4の数字を宣言します。宣言した数だけ進みます。</p>
          </article>
          <article>
            <h3>ブラフ</h3>
            <p>出目と違う数字を言ってもOKです。Xが出たら必ずウソになります。</p>
          </article>
          <article>
            <h3>指摘</h3>
            <p>宣言後、他のプレイヤーが順番に30秒ずつ「ウソだ！」か「スキップ」を選びます。</p>
          </article>
          <article>
            <h3>当たり</h3>
            <p>ウソを見破ると、手番のコマが落ち、指摘した人のコマが宣言数だけ進みます。</p>
          </article>
          <article>
            <h3>外れ</h3>
            <p>宣言が本当だった場合、指摘した人のコマが落ち、手番の移動は確定します。</p>
          </article>
          <article>
            <h3>観戦者の勝負</h3>
            <p>動けるコマがなくても、ゴール済みコマがあればそれを賭けて指摘できます。外すとそのコマを失います。</p>
          </article>
        </div>
      </section>
    </div>
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
      return "指摘選択";
    case "resolving":
      return "判定";
    default:
      return "-";
  }
}

export default App;
