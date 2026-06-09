import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Coins, Crown, Dice5, Gem, Hand, History, Landmark, Loader2, ReceiptText, Scissors, ShieldCheck, Trophy, WalletCards, X, Zap } from "lucide-react";
import { BrowserProvider, Contract, formatEther, hexlify, parseEther, randomBytes } from "ethers";
import { Brand } from "./components/Brand";
import { BetSelector } from "./components/BetSelector";
import { WalletBar } from "./components/WalletBar";
import { GAME_CONTRACT_ADDRESS, RELAYER_URL, SIMPLE_CHAIN_ID, shortAddress } from "./lib/simpleChain";
import { PLAYGROUND_ABI, getPlaygroundContract } from "./lib/contract";
import { WalletState, connectWallet, getAuthorizedWallet } from "./lib/wallet";

type Page = "lobby" | "leaderboard" | "rps" | "coin" | "admin";
type GameId = "coin" | "rps";
type TxStatus = { tone: "info" | "ok" | "warn" | "error"; message: string };
type SuccessPopupState = { title: string; amount: string; detail: string } | null;
type RoundStatus = "win" | "lose" | "draw";
type SettingsState = {
  entryFeeBps: number;
  winFeeBps: number;
  minBet: string;
  maxBet: string;
  poolBalance: string;
  owner: string;
};
type AccountState = {
  gameBalance: string;
  sessionSpent: string;
};
type RelayerHealth = {
  ok: boolean;
  contractAddress: string;
  relayerAddress: string;
  trusted: boolean;
  currentSeedHash: string;
  seedCommitted: boolean;
};
type RelayerSession = {
  relayer: string;
  allowance: string;
  expiresAt: number;
  nonce: string;
  signature: string;
};
type RoundResult = {
  game: GameId;
  status: RoundStatus;
  playerMove: number;
  outcome: number;
  betAmount: string;
  payout: string;
  roundId: string;
};
type RoundHistoryEntry = RoundResult & {
  playedAt: number;
};
type LeaderboardRow = {
  rank: number;
  address: string;
  reward: string;
  playCount: number;
  eligible: boolean;
};
type LeaderboardState = {
  epoch: number;
  startedAt: number;
  endsAt: number;
  settled: boolean;
  rows: LeaderboardRow[];
  previousEpoch: number;
  previousSettled: boolean;
  previousRows: LeaderboardRow[];
};

const SESSION_STORAGE_PREFIX = "simple-playground-relayer-session";
const HISTORY_STORAGE_PREFIX = "simple-playground-history";
const emptyWallet: WalletState = { provider: null, address: "", balance: "0", chainId: "" };
const emptyAccount: AccountState = { gameBalance: "0", sessionSpent: "0" };
const emptyHealth: RelayerHealth = { ok: false, contractAddress: "", relayerAddress: "", trusted: false, currentSeedHash: "", seedCommitted: false };
const emptyLeaderboard: LeaderboardState = { epoch: 0, startedAt: 0, endsAt: 0, settled: false, rows: [], previousEpoch: 0, previousSettled: true, previousRows: [] };

const initialSettings: SettingsState = {
  entryFeeBps: 500,
  winFeeBps: 500,
  minBet: "0.01",
  maxBet: "100",
  poolBalance: "0",
  owner: "",
};

const games = [
  {
    page: "rps" as const,
    title: "Rock Scissors Paper",
    subtitle: "Pick rock, scissors, or paper and play against the Simple pool.",
    icon: Hand,
  },
  {
    page: "coin" as const,
    title: "Coin Flip",
    subtitle: "Guess whether the Simple Chain logo lands up or down.",
    icon: Coins,
  },
];

export function App() {
  const [page, setPage] = useState<Page>("lobby");
  const [wallet, setWallet] = useState<WalletState>(emptyWallet);
  const [settings, setSettings] = useState<SettingsState>(initialSettings);
  const [account, setAccount] = useState<AccountState>(emptyAccount);
  const [relayerHealth, setRelayerHealth] = useState<RelayerHealth>(emptyHealth);
  const [relayerSession, setRelayerSession] = useState<RelayerSession | null>(null);
  const [status, setStatus] = useState<TxStatus>({ tone: "info", message: "Deposit SRW once, sign a relayer session, then play without wallet popups every round." });
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [roundHistory, setRoundHistory] = useState<Record<GameId, RoundHistoryEntry[]>>({ coin: [], rps: [] });
  const [leaderboard, setLeaderboard] = useState<LeaderboardState>(emptyLeaderboard);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [successPopup, setSuccessPopup] = useState<SuccessPopupState>(null);
  const contractReady = Boolean(GAME_CONTRACT_ADDRESS);

  const sessionRemaining = Math.max(Number(relayerSession?.allowance ?? "0") - Number(account.sessionSpent), 0);
  const relayerReady = Boolean(relayerHealth.ok && relayerHealth.trusted && relayerHealth.seedCommitted);
  const sessionReady = Boolean(relayerReady && relayerSession && relayerSession.expiresAt > Math.floor(Date.now() / 1000) && sessionRemaining > 0);

  const isAdmin = useMemo(() => {
    return Boolean(wallet.address && settings.owner && wallet.address.toLowerCase() === settings.owner.toLowerCase());
  }, [settings.owner, wallet.address]);

  useEffect(() => {
    void loadRelayerHealth();
    const interval = window.setInterval(() => void loadRelayerHealth(), 10000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setRoundHistory(readStoredHistory(wallet.address));
  }, [wallet.address]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restoreWallet() {
      try {
        const restored = await getAuthorizedWallet();
        if (!cancelled && restored) {
          setWallet(restored);
          setRelayerSession(readStoredSession(restored.address));
          setStatus({ tone: "ok", message: "Wallet session restored." });
          await refreshChainState(restored.provider, restored.address, readStoredSession(restored.address));
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({ tone: "warn", message: `Wallet session could not be restored: ${getErrorMessage(error)}` });
        }
      }
    }

    function handleAccountsChanged(accounts: unknown) {
      const [nextAddress] = Array.isArray(accounts) ? (accounts as string[]) : [];
      if (!nextAddress) {
        setWallet(emptyWallet);
        setAccount(emptyAccount);
        setRelayerSession(null);
        setStatus({ tone: "info", message: "Wallet disconnected." });
        return;
      }
      void getAuthorizedWallet().then((next) => {
        if (next) {
          const stored = readStoredSession(next.address);
          setWallet(next);
          setRelayerSession(stored);
          void refreshChainState(next.provider, next.address, stored);
        }
      });
    }

    function handleChainChanged() {
      void getAuthorizedWallet().then((next) => {
        if (next) {
          const stored = readStoredSession(next.address);
          setWallet(next);
          setRelayerSession(stored);
          void refreshChainState(next.provider, next.address, stored);
        }
      });
    }

    void restoreWallet();
    window.ethereum?.on?.("accountsChanged", handleAccountsChanged);
    window.ethereum?.on?.("chainChanged", handleChainChanged);

    return () => {
      cancelled = true;
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  useEffect(() => {
    if (wallet.provider) {
      void refreshChainState(wallet.provider, wallet.address, relayerSession);
    }
  }, [wallet.provider, wallet.address, relayerSession]);

  useEffect(() => {
    if (page === "admin" && !isAdmin) {
      setPage("lobby");
    }
  }, [isAdmin, page]);

  async function loadRelayerHealth() {
    try {
      const response = await fetch(`${RELAYER_URL}/api/health`);
      const health = await response.json() as RelayerHealth;
      setRelayerHealth(health);
      return health;
    } catch {
      setRelayerHealth(emptyHealth);
      return emptyHealth;
    }
  }

  async function handleConnect() {
    try {
      setBusy(true);
      const next = await connectWallet();
      const stored = readStoredSession(next.address);
      setWallet(next);
      setRelayerSession(stored);
      setStatus({ tone: "ok", message: "Wallet connected to Simple Chain." });
      await refreshChainState(next.provider, next.address, stored);
      await loadRelayerHealth();
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function refreshWallet(provider = wallet.provider, address = wallet.address) {
    if (!provider || !address) return;
    const balance = formatEther(await provider.getBalance(address));
    setWallet((current) => ({ ...current, provider, address, balance }));
  }

  async function refreshChainState(provider = wallet.provider, address = wallet.address, session = relayerSession) {
    if (!provider) return;
    await refreshWallet(provider, address);
    await loadSettings(provider);
    await loadLeaderboard(provider);
    if (address) {
      await loadAccount(provider, address, session);
    }
  }

  async function loadSettings(provider?: BrowserProvider | null) {
    if (!contractReady) return;
    const activeProvider = provider ?? wallet.provider;
    if (!activeProvider) return;

    try {
      const contract = getPlaygroundContract(activeProvider);
      const [entryFeeBps, winFeeBps, minBet, maxBet, owner, poolBalance] = await Promise.all([
        contract.entryFeeBps(),
        contract.winFeeBps(),
        contract.minBet(),
        contract.maxBet(),
        contract.owner(),
        contract.poolLiquidity(),
      ]);

      setSettings({
        entryFeeBps: Number(entryFeeBps),
        winFeeBps: Number(winFeeBps),
        minBet: formatEther(minBet),
        maxBet: formatEther(maxBet),
        owner,
        poolBalance: formatEther(poolBalance),
      });
    } catch (error) {
      setStatus({ tone: "warn", message: `Could not load contract settings: ${getErrorMessage(error)}` });
    }
  }

  async function loadLeaderboard(provider?: BrowserProvider | null) {
    if (!contractReady) return;
    const activeProvider = provider ?? wallet.provider;
    if (!activeProvider) return;

    try {
      const contract = getPlaygroundContract(activeProvider);
      const epoch = Number(await contract.currentLeaderboardEpoch());
      const [players, scores, playCounts, startedAt, endsAt, settled] = await contract.leaderboardEpochInfo(BigInt(epoch));
      let previousRows: LeaderboardRow[] = [];
      let previousSettled = true;

      if (epoch > 1) {
        const [previousPlayers, previousScores, previousPlayCounts, , , previousRewardsSettled] = await contract.leaderboardEpochInfo(BigInt(epoch - 1));
        previousRows = buildLeaderboardRows(previousPlayers, previousScores, previousPlayCounts);
        previousSettled = Boolean(previousRewardsSettled);
      }

      setLeaderboard({
        epoch,
        startedAt: Number(startedAt),
        endsAt: Number(endsAt),
        settled: Boolean(settled),
        rows: buildLeaderboardRows(players, scores, playCounts),
        previousEpoch: epoch > 1 ? epoch - 1 : 0,
        previousSettled,
        previousRows,
      });
    } catch {
      setLeaderboard(emptyLeaderboard);
    }
  }

  async function loadAccount(provider: BrowserProvider, address: string, session = relayerSession) {
    if (!contractReady || !address) return;

    try {
      const contract = getPlaygroundContract(provider);
      const gameBalance = await contract.playerBalances(address);
      let sessionSpent = 0n;

      if (session) {
        const sessionHash = await contract.sessionHash(address, session.relayer, parseEther(session.allowance), BigInt(session.expiresAt), BigInt(session.nonce));
        sessionSpent = await contract.sessionSpent(sessionHash);
      }

      setAccount({
        gameBalance: formatEther(gameBalance),
        sessionSpent: formatEther(sessionSpent),
      });
    } catch (error) {
      setStatus({ tone: "warn", message: `Could not load player account: ${getErrorMessage(error)}` });
    }
  }

  async function ensurePlayable() {
    if (!wallet.provider || !wallet.address) {
      await handleConnect();
      return false;
    }

    if (!contractReady) {
      setStatus({ tone: "warn", message: "VITE_GAME_CONTRACT_ADDRESS is missing. Deploy the relayer contract and configure its address before real wagers." });
      return false;
    }

    return true;
  }

  async function depositPlayer(amount: string) {
    if (!(await ensurePlayable()) || !wallet.provider) return;
    const displayAmount = safeAmount(Number(amount || "0"));

    try {
      setBusy(true);
      const signer = await wallet.provider.getSigner();
      const contract = new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, signer);
      const tx = await contract.depositPlayer({ value: parseEther(amount || "0") });
      setStatus({ tone: "info", message: `Deposit ${shortAddress(tx.hash)} submitted...` });
      await tx.wait();
      setStatus({ tone: "ok", message: "Game balance funded." });
      setSuccessPopup({ title: "Deposit complete", amount: `${displayAmount} SRW`, detail: "Added to your game balance." });
      await refreshChainState();
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function withdrawPlayer(amount: string) {
    if (!(await ensurePlayable()) || !wallet.provider) return;
    const displayAmount = safeAmount(Number(amount || "0"));

    try {
      setBusy(true);
      const signer = await wallet.provider.getSigner();
      const contract = new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, signer);
      const tx = await contract.withdrawPlayer(parseEther(amount || "0"));
      setStatus({ tone: "info", message: `Withdraw ${shortAddress(tx.hash)} submitted...` });
      await tx.wait();
      setStatus({ tone: "ok", message: "SRW withdrawn to your wallet." });
      setSuccessPopup({ title: "Withdraw complete", amount: `${displayAmount} SRW`, detail: "Sent back to your wallet." });
      await refreshChainState();
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function authorizeRelayerSession(amount: string) {
    if (!(await ensurePlayable()) || !wallet.provider || !wallet.address) return;
    const health = await loadRelayerHealth();

    if (!health.relayerAddress || !health.ok || !health.trusted || !health.seedCommitted) {
      setStatus({ tone: "warn", message: "Relayer is offline. Wallet play fallback is available." });
      return;
    }

    try {
      setBusy(true);
      const signer = await wallet.provider.getSigner();
      const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      const nonce = BigInt(`0x${hexlify(randomBytes(16)).slice(2)}`).toString();
      const allowanceWei = parseEther(amount || "0");
      const domain = {
        name: "SimplePlayground",
        version: "1",
        chainId: SIMPLE_CHAIN_ID,
        verifyingContract: GAME_CONTRACT_ADDRESS,
      };
      const types = {
        Session: [
          { name: "player", type: "address" },
          { name: "relayer", type: "address" },
          { name: "allowance", type: "uint256" },
          { name: "expiresAt", type: "uint64" },
          { name: "nonce", type: "uint256" },
        ],
      };
      const value = {
        player: wallet.address,
        relayer: health.relayerAddress,
        allowance: allowanceWei,
        expiresAt,
        nonce,
      };
      const signature = await signer.signTypedData(domain, types, value);
      const session = { relayer: health.relayerAddress, allowance: amount, expiresAt, nonce, signature };
      writeStoredSession(wallet.address, session);
      setRelayerSession(session);
      setStatus({ tone: "ok", message: "Relayer session signed for 24 hours. No gas transfer to a session wallet is required." });
      await refreshChainState(wallet.provider, wallet.address, session);
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function clearRelayerSession() {
    if (wallet.address) {
      localStorage.removeItem(sessionStorageKey(wallet.address));
    }
    setRelayerSession(null);
    setAccount((current) => ({ ...current, sessionSpent: "0" }));
    setStatus({ tone: "info", message: "Local relayer session cleared. Previously signed unused allowance cannot be used by the frontend anymore." });
  }

  async function playGame(game: GameId, choice: number, bet: string) {
    if (!(await ensurePlayable()) || !wallet.provider || !wallet.address) return;

    try {
      setBusy(true);
      setPlaying(true);
      setRoundResult(null);

      const playerSeed = hexlify(randomBytes(32));
      let parsedResult: RoundResult;

      if (sessionReady && relayerSession) {
        setStatus({ tone: "info", message: "Quick play is submitting the round on-chain..." });
        const response = await fetch(`${RELAYER_URL}/api/play`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            player: wallet.address,
            gameType: game === "coin" ? 0 : 1,
            move: choice,
            betAmount: bet,
            playerSeed,
            sessionAllowance: relayerSession.allowance,
            sessionExpiresAt: relayerSession.expiresAt,
            sessionNonce: relayerSession.nonce,
            sessionSignature: relayerSession.signature,
          }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "Relayer play failed");
        }

        parsedResult = parseRelayerRound(payload.round, game);
        if (payload.account?.gameBalance !== undefined && payload.account?.sessionSpent !== undefined) {
          setAccount({
            gameBalance: String(payload.account.gameBalance),
            sessionSpent: String(payload.account.sessionSpent),
          });
        }
      } else {
        setStatus({ tone: "info", message: "Wallet play fallback active. Confirm this round in your wallet." });
        const signer = await wallet.provider.getSigner();
        const contract = new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, signer);
        const tx = await contract.playDirect(game === "coin" ? 0 : 1, choice, parseEther(bet || "0"), playerSeed);
        setStatus({ tone: "info", message: `Wallet play ${shortAddress(tx.hash)} submitted...` });
        const receipt = await tx.wait();
        if (!receipt) {
          throw new Error("Direct play transaction was not confirmed.");
        }
        parsedResult = parseDirectRound(contract, receipt.logs, game);
      }

      setPlaying(false);
      setRoundResult(parsedResult);
      addHistoryEntry(wallet.address, parsedResult);
      setStatus({ tone: parsedResult.status === "win" ? "ok" : parsedResult.status === "draw" ? "warn" : "info", message: roundMessage(parsedResult) });
      await Promise.all([refreshWallet(), loadSettings(wallet.provider), loadAccount(wallet.provider, wallet.address, relayerSession), loadRelayerHealth(), loadLeaderboard(wallet.provider)]);
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setPlaying(false);
      setBusy(false);
    }
  }

  async function settleLeaderboardRewards(epoch: number) {
    if (!wallet.provider || !wallet.address || !epoch) {
      await handleConnect();
      return;
    }

    try {
      setBusy(true);
      const signer = await wallet.provider.getSigner();
      const contract = new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, signer);
      const tx = await contract.settleLeaderboardRewards(BigInt(epoch));
      setStatus({ tone: "info", message: `Leaderboard rewards ${shortAddress(tx.hash)} submitted...` });
      await tx.wait();
      setStatus({ tone: "ok", message: "Leaderboard rewards paid from the pool." });
      await refreshChainState();
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setPlaying(false);
      setBusy(false);
    }
  }

  function addHistoryEntry(address: string, result: RoundResult) {
    const entry = { ...result, playedAt: Date.now() };
    setRoundHistory((current) => {
      const next = {
        ...current,
        [result.game]: [entry, ...(current[result.game] ?? [])].slice(0, 20),
      };
      writeStoredHistory(address, next);
      return next;
    });
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav className="nav-list">
          <button className={page === "lobby" ? "nav-item nav-item--active" : "nav-item"} onClick={() => setPage("lobby")} type="button">
            <Dice5 size={18} /> Lobby
          </button>
          <button className={page === "leaderboard" ? "nav-item nav-item--active" : "nav-item"} onClick={() => setPage("leaderboard")} type="button">
            <Trophy size={18} /> Leaderboard
          </button>
          <button className={page === "rps" ? "nav-item nav-item--active" : "nav-item"} onClick={() => setPage("rps")} type="button">
            <Hand size={18} /> Rock Paper
          </button>
          <button className={page === "coin" ? "nav-item nav-item--active" : "nav-item"} onClick={() => setPage("coin")} type="button">
            <Coins size={18} /> Coin Flip
          </button>
          {isAdmin && (
            <button className={page === "admin" ? "nav-item nav-item--active" : "nav-item"} onClick={() => setPage("admin")} type="button">
              <Landmark size={18} /> Pool Admin
            </button>
          )}
        </nav>
        <div className="pool-panel">
          <span>Pool Liquidity</span>
          <strong>{Number(settings.poolBalance).toFixed(4)} SRW</strong>
          <small>{GAME_CONTRACT_ADDRESS ? `Receiver ${shortAddress(GAME_CONTRACT_ADDRESS)}` : "No pool contract configured"}</small>
        </div>
        <div className="pool-panel">
          <span>Your Game Balance</span>
          <strong>{Number(account.gameBalance).toFixed(4)} SRW</strong>
          <small>{sessionReady ? "Quick play ready" : "Wallet play fallback ready"}</small>
        </div>
      </aside>

      <section className="content">
        <WalletBar wallet={wallet} isAdmin={isAdmin} relayerOnline={relayerReady} onAdmin={() => setPage("admin")} onConnect={handleConnect} onRefresh={() => void refreshChainState()} busy={busy} />
        <StatusBanner status={status} busy={busy} />

        {page === "lobby" && <Lobby account={account} onOpen={setPage} settings={settings} />}
        {page === "leaderboard" && <LeaderboardPage busy={busy} leaderboard={leaderboard} now={now} onSettleRewards={settleLeaderboardRewards} />}
        {page === "rps" && (
          <RpsPage
            account={account}
            busy={busy}
            playing={playing}
            onAuthorizeRelayerSession={authorizeRelayerSession}
            onClearRelayerSession={clearRelayerSession}
            onDeposit={depositPlayer}
            onPlay={(choice, bet) => playGame("rps", choice, bet)}
            onWithdraw={withdrawPlayer}
            relayerHealth={relayerHealth}
            relayerSession={relayerSession}
            result={roundResult?.game === "rps" ? roundResult : null}
            history={roundHistory.rps}
            sessionReady={sessionReady}
            settings={settings}
          />
        )}
        {page === "coin" && (
          <CoinPage
            account={account}
            busy={busy}
            playing={playing}
            onAuthorizeRelayerSession={authorizeRelayerSession}
            onClearRelayerSession={clearRelayerSession}
            onDeposit={depositPlayer}
            onPlay={(choice, bet) => playGame("coin", choice, bet)}
            onWithdraw={withdrawPlayer}
            relayerHealth={relayerHealth}
            relayerSession={relayerSession}
            result={roundResult?.game === "coin" ? roundResult : null}
            history={roundHistory.coin}
            sessionReady={sessionReady}
            settings={settings}
          />
        )}
        {page === "admin" && (
          <AdminPage
            contractReady={contractReady}
            isAdmin={isAdmin}
            provider={wallet.provider}
            refresh={() => refreshChainState()}
            relayerHealth={relayerHealth}
            setStatus={setStatus}
            settings={settings}
            walletAddress={wallet.address}
          />
        )}
      </section>
      {successPopup && <SuccessPopup popup={successPopup} onClose={() => setSuccessPopup(null)} />}
    </main>
  );
}

function SuccessPopup({ popup, onClose }: { popup: NonNullable<SuccessPopupState>; onClose: () => void }) {
  return (
    <div className="success-popup" role="status">
      <div className="success-popup-icon">
        <CheckCircle2 size={22} />
      </div>
      <div>
        <strong>{popup.title}</strong>
        <span>{popup.amount}</span>
        <small>{popup.detail}</small>
      </div>
      <button className="success-popup-close" onClick={onClose} type="button" aria-label="Close">
        <X size={16} />
      </button>
    </div>
  );
}

function StatusBanner({ status, busy }: { status: TxStatus; busy: boolean }) {
  return (
    <div className={`status-banner status-banner--${status.tone}`}>
      {busy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
      <span>{status.message}</span>
    </div>
  );
}

function LeaderboardPage({
  busy,
  leaderboard,
  now,
  onSettleRewards,
}: {
  busy: boolean;
  leaderboard: LeaderboardState;
  now: number;
  onSettleRewards: (epoch: number) => void;
}) {
  const duration = Math.max(leaderboard.endsAt - leaderboard.startedAt, 1);
  const elapsed = Math.min(Math.max(now - leaderboard.startedAt, 0), duration);
  const progress = leaderboard.endsAt ? (elapsed / duration) * 100 : 0;
  const remaining = Math.max(leaderboard.endsAt - now, 0);
  const countdown = splitCountdown(remaining);
  const canSettlePrevious = leaderboard.previousEpoch > 0 && !leaderboard.previousSettled && leaderboard.previousRows.length > 0;

  return (
    <div className="leaderboard-layout">
      <section className="leaderboard-main">
        <div className="section-heading">
          <div>
            <span>Leaderboard</span>
            <h2>Top Players</h2>
          </div>
          <div className="epoch-pill">Epoch #{leaderboard.epoch || "-"}</div>
        </div>

        <div className="countdown-panel">
          <div className="countdown-head">
            <span>Next reset</span>
            <strong>5-day cycle</strong>
          </div>
          <div className="countdown-grid">
            <TimeBox value={leaderboard.endsAt ? countdown.days : "--"} label="Days" />
            <TimeBox value={leaderboard.endsAt ? countdown.hours : "--"} label="Hours" />
            <TimeBox value={leaderboard.endsAt ? countdown.minutes : "--"} label="Minutes" />
            <TimeBox value={leaderboard.endsAt ? countdown.seconds : "--"} label="Seconds" />
          </div>
          <div className="progress-track">
            <span style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }} />
          </div>
        </div>

        <LeaderboardTable rows={leaderboard.rows} />
      </section>

      <aside className="wager-panel">
        <div className="receipt">
          <ReceiptText size={18} />
          <dl>
            <div><dt>Top 1</dt><dd>3 SRW</dd></div>
            <div><dt>Top 2-3</dt><dd>2 SRW</dd></div>
            <div><dt>Top 4-10</dt><dd>1 SRW</dd></div>
          </dl>
        </div>
        <div className="criteria-note">
          <strong>Criteria</strong>
          <span>Only wallets with at least 100 games in this 5-day cycle can receive rewards.</span>
        </div>
        <div className="leaderboard-note">
          Rewards are paid directly from pool liquidity after each 5-day cycle.
        </div>
        {canSettlePrevious && (
          <button className="primary-action" disabled={busy} onClick={() => onSettleRewards(leaderboard.previousEpoch)} type="button">
            <Trophy size={18} /> Settle Epoch #{leaderboard.previousEpoch}
          </button>
        )}
      </aside>
    </div>
  );
}

function TimeBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="time-box">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function LeaderboardTable({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <div className="leaderboard-table-wrap">
      {rows.length === 0 ? (
        <div className="leaderboard-empty">No ranked players yet.</div>
      ) : (
        <table className="leaderboard-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Wallet</th>
              <th>Criteria</th>
              <th>Reward</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.address}>
                <td>#{row.rank}</td>
                <td>{shortAddress(row.address)}</td>
                <td><span className={row.eligible ? "criteria-badge criteria-badge--ok" : "criteria-badge"}>{row.playCount}/100 games</span></td>
                <td>{row.eligible ? row.reward : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Lobby({ account, onOpen, settings }: { account: AccountState; onOpen: (page: Page) => void; settings: SettingsState }) {
  return (
    <div className="lobby-layout">
      <section className="hero-band">
        <div className="hero-copy">
          <Brand compact />
          <h1>Simple Playground</h1>
          <p>Deposit SRW once, sign a relayer session, then play fast mini games while the smart contract tracks balances and settles each round.</p>
          <div className="metric-row">
            <span><b>{Number(account.gameBalance).toFixed(2)}</b> game SRW</span>
            <span><b>{Number(settings.poolBalance).toFixed(2)}</b> pool SRW</span>
            <span><b>{Number(settings.maxBet).toFixed(0)}</b> max SRW</span>
          </div>
        </div>
        <img alt="SimpleChain logo" src="/assets/simple-chain-hero.svg" />
      </section>

      <div className="game-grid">
        {games.map((game) => {
          const Icon = game.icon;
          return (
            <button className="game-tile" key={game.page} onClick={() => onOpen(game.page)} type="button">
              <span className="game-icon"><Icon size={24} /></span>
              <strong>{game.title}</strong>
              <small>{game.subtitle}</small>
              <span className="tile-action">Play <ArrowRight size={16} /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type GamePageProps = {
  account: AccountState;
  busy: boolean;
  playing: boolean;
  onAuthorizeRelayerSession: (amount: string) => void;
  onClearRelayerSession: () => void;
  onDeposit: (amount: string) => void;
  onPlay: (choice: number, bet: string) => void;
  onWithdraw: (amount: string) => void;
  relayerHealth: RelayerHealth;
  relayerSession: RelayerSession | null;
  result: RoundResult | null;
  history: RoundHistoryEntry[];
  sessionReady: boolean;
  settings: SettingsState;
};

function RpsPage(props: GamePageProps) {
  const [bet, setBet] = useState("0.1");
  const [choice, setChoice] = useState(0);
  const options = ["Rock", "Scissors", "Paper"];

  return (
    <GameSurface
      {...props}
      bet={bet}
      choices={options}
      selected={choice}
      setBet={setBet}
      setSelected={setChoice}
      title="Rock Scissors Paper"
      visual={<RpsArena busy={props.playing} choice={choice} result={props.result} />}
      renderChoice={(item, index) => (
        <span className="rps-choice-content">
          <RpsMoveIcon move={index} size={25} />
          <span>{item}</span>
        </span>
      )}
      onPlay={() => props.onPlay(choice, bet)}
    />
  );
}

function CoinPage(props: GamePageProps) {
  const [bet, setBet] = useState("0.1");
  const [choice, setChoice] = useState(0);
  const [animationMode, setAnimationMode] = useState(0);
  const options = ["Logo Up", "Logo Down"];

  return (
    <GameSurface
      {...props}
      bet={bet}
      choices={options}
      selected={choice}
      setBet={setBet}
      setSelected={setChoice}
      title="Coin Flip"
      visual={<CoinArena animationMode={animationMode} busy={props.playing} choice={choice} result={props.result} />}
      onPlay={() => {
        setAnimationMode(Math.floor(Math.random() * 4));
        props.onPlay(choice, bet);
      }}
    />
  );
}

type GameSurfaceProps = GamePageProps & {
  bet: string;
  choices: string[];
  selected: number;
  setBet: (bet: string) => void;
  setSelected: (selected: number) => void;
  title: string;
  visual: ReactNode;
  renderChoice?: (item: string, index: number) => ReactNode;
  onPlay: () => void;
};

function GameSurface({
  account,
  bet,
  busy,
  choices,
  history,
  onAuthorizeRelayerSession,
  onClearRelayerSession,
  onDeposit,
  onPlay,
  onWithdraw,
  relayerHealth,
  relayerSession,
  result,
  selected,
  sessionReady,
  setBet,
  setSelected,
  settings,
  title,
  visual,
  renderChoice,
}: GameSurfaceProps) {
  const [depositAmount, setDepositAmount] = useState("5");
  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [sessionAllowanceAmount, setSessionAllowanceAmount] = useState("5");
  const betAmount = Number(bet || "0");
  const visiblePrize = betAmount * 2;
  const totalCost = betAmount + (betAmount * settings.entryFeeBps) / 10000;
  const worstCasePayout = visiblePrize - (visiblePrize * settings.winFeeBps) / 10000;
  const sessionRemaining = Math.max(Number(relayerSession?.allowance ?? "0") - Number(account.sessionSpent), 0);
  const hasBalance = Number(account.gameBalance) >= totalCost;
  const hasPoolLiquidity = Number(settings.poolBalance) >= worstCasePayout;
  const isWithinLimits = betAmount >= Number(settings.minBet) && betAmount <= Number(settings.maxBet);
  const canUseQuickPlay = sessionReady && sessionRemaining >= betAmount;
  const playMode = canUseQuickPlay ? "quick" : "wallet";
  const canPlay = betAmount > 0 && hasBalance && hasPoolLiquidity && isWithinLimits;
  const blockReason =
    betAmount <= 0
      ? "Enter a valid bet amount."
      : !isWithinLimits
        ? `Bet must be between ${safeAmount(Number(settings.minBet))} and ${safeAmount(Number(settings.maxBet))} SRW.`
        : !hasBalance
          ? "Your game balance is too low. Deposit more SRW before playing."
          : !hasPoolLiquidity
            ? "Pool liquidity is too low for the maximum possible payout. Ask the admin to fund the pool."
            : "";

  return (
    <div className="game-layout">
      <section className="play-surface">
        <div className="section-heading">
          <div>
            <span>Game</span>
            <h2>{title}</h2>
          </div>
          {result && (
            <div className={`result-pill result-pill--${result.status}`}>
              <strong>{result.status.toUpperCase()}</strong>
              <span>Round #{result.roundId} - Payout {safeAmount(Number(result.payout))} SRW</span>
            </div>
          )}
        </div>
        {visual}
        <div className="choice-row">
          {choices.map((item, index) => (
            <button className={selected === index ? "choice-button choice-button--active" : "choice-button"} key={item} onClick={() => setSelected(index)} type="button">
              {renderChoice ? renderChoice(item, index) : item}
            </button>
          ))}
        </div>
        <RoundHistory history={history} />
      </section>

      <aside className="wager-panel">
        <BetSelector bet={bet} setBet={setBet} />
        <AccountPanel
          account={account}
          busy={busy}
          depositAmount={depositAmount}
          onAuthorizeRelayerSession={onAuthorizeRelayerSession}
          onClearRelayerSession={onClearRelayerSession}
          onDeposit={onDeposit}
          onWithdraw={onWithdraw}
          relayerHealth={relayerHealth}
          relayerSession={relayerSession}
          sessionAllowanceAmount={sessionAllowanceAmount}
          sessionReady={sessionReady}
          setDepositAmount={setDepositAmount}
          setSessionAllowanceAmount={setSessionAllowanceAmount}
          setWithdrawAmount={setWithdrawAmount}
          withdrawAmount={withdrawAmount}
        />
        <div className={playMode === "quick" ? "play-mode play-mode--quick" : "play-mode play-mode--wallet"}>
          <span className={playMode === "quick" ? "status-dot status-dot--online" : "status-dot status-dot--offline"} />
          <div>
            <strong>{playMode === "quick" ? "Quick play active" : "Wallet play fallback"}</strong>
            <small>{playMode === "quick" ? "No wallet popup for each round." : "Confirm each round in your wallet."}</small>
          </div>
        </div>
        <div className="receipt">
          <ReceiptText size={18} />
          <dl>
            <div><dt>Bet</dt><dd>{safeAmount(betAmount)} SRW</dd></div>
            <div><dt>Prize target</dt><dd>{safeAmount(visiblePrize)} SRW</dd></div>
          </dl>
        </div>
        {!canPlay && <div className="play-warning">{blockReason}</div>}
        <button className="primary-action" disabled={busy || !canPlay} onClick={onPlay} type="button">
          {busy ? <Loader2 className="spin" size={18} /> : canUseQuickPlay ? <Zap size={18} /> : <WalletCards size={18} />}
          Play for {safeAmount(betAmount)} SRW
        </button>
      </aside>
    </div>
  );
}

function AccountPanel({
  account,
  busy,
  depositAmount,
  onAuthorizeRelayerSession,
  onClearRelayerSession,
  onDeposit,
  onWithdraw,
  relayerHealth,
  relayerSession,
  sessionAllowanceAmount,
  sessionReady,
  setDepositAmount,
  setSessionAllowanceAmount,
  setWithdrawAmount,
  withdrawAmount,
}: {
  account: AccountState;
  busy: boolean;
  depositAmount: string;
  onAuthorizeRelayerSession: (amount: string) => void;
  onClearRelayerSession: () => void;
  onDeposit: (amount: string) => void;
  onWithdraw: (amount: string) => void;
  relayerHealth: RelayerHealth;
  relayerSession: RelayerSession | null;
  sessionAllowanceAmount: string;
  sessionReady: boolean;
  setDepositAmount: (amount: string) => void;
  setSessionAllowanceAmount: (amount: string) => void;
  setWithdrawAmount: (amount: string) => void;
  withdrawAmount: string;
}) {
  const sessionRemaining = Math.max(Number(relayerSession?.allowance ?? "0") - Number(account.sessionSpent), 0);
  return (
    <div className="account-panel">
      <div className="account-header">
        <WalletCards size={18} />
        <strong>{Number(account.gameBalance).toFixed(4)} SRW</strong>
        <span>Game balance</span>
      </div>
      <div className="mini-form">
        <input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} />
        <button className="secondary-action" disabled={busy} onClick={() => onDeposit(depositAmount)} type="button">Deposit</button>
      </div>
      <div className="mini-form">
        <input value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} />
        <button className="secondary-action" disabled={busy} onClick={() => onWithdraw(withdrawAmount)} type="button">Withdraw</button>
      </div>
      <div className={sessionReady ? "session-box session-box--ready" : "session-box"}>
        <div className="session-status-row">
          <strong>{sessionReady ? "Quick play ready" : "Quick play setup"}</strong>
          <span className={relayerHealth.ok && relayerHealth.trusted && relayerHealth.seedCommitted ? "relayer-badge relayer-badge--online" : "relayer-badge relayer-badge--offline"}>
            <i />
            {relayerHealth.ok && relayerHealth.trusted && relayerHealth.seedCommitted ? "Relayer online" : "Relayer offline"}
          </span>
        </div>
        <span>Quick play, no tx sign</span>
        <small>Remaining {sessionRemaining.toFixed(4)} SRW</small>
        <div className="mini-form">
          <input aria-label="Allowed balance in SRW" placeholder="Allowed balance" title="Maximum SRW this session can spend from your game balance" value={sessionAllowanceAmount} onChange={(event) => setSessionAllowanceAmount(event.target.value)} />
          <button className="secondary-action" disabled={busy || !relayerHealth.ok || !relayerHealth.trusted || !relayerHealth.seedCommitted} onClick={() => onAuthorizeRelayerSession(sessionAllowanceAmount)} type="button">Allowed Balance</button>
        </div>
        {relayerSession && <button className="ghost-action" disabled={busy} onClick={onClearRelayerSession} type="button">Clear Local Session</button>}
      </div>
    </div>
  );
}

function RoundHistory({ history }: { history: RoundHistoryEntry[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="history-panel">
      <button className="history-toggle" onClick={() => setOpen((value) => !value)} type="button">
        <span><History size={17} /> Recent Results</span>
        <small>{history.length}/20</small>
        {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
      </button>
      {open && (
        <div className="history-table-wrap">
          {history.length === 0 ? (
            <div className="history-empty">No rounds yet.</div>
          ) : (
            <table className="history-table">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Result</th>
                  <th>Pick</th>
                  <th>Outcome</th>
                  <th>Payout</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={`${item.game}-${item.roundId}-${item.playedAt}`}>
                    <td>#{item.roundId}</td>
                    <td><span className={`history-result history-result--${item.status}`}>{item.status}</span></td>
                    <td>{moveLabel(item.game, item.playerMove)}</td>
                    <td>{moveLabel(item.game, item.outcome)}</td>
                    <td>{safeAmount(Number(item.payout))} SRW</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function RpsArena({ busy, choice, result }: { busy: boolean; choice: number; result: RoundResult | null }) {
  const labels = ["ROCK", "SCISSORS", "PAPER"];
  return (
    <div className={`arena rps-arena ${busy ? "arena--playing" : ""} ${result ? `arena--${result.status}` : ""}`}>
      <div className="rps-duel">
        <div className={`rps-side rps-side--player ${result?.status === "win" ? "rps-side--winner" : ""}`}>
          <small>Your pick</small>
          <span className="rps-arena-icon"><RpsMoveIcon move={choice} size={72} /></span>
          <strong>{labels[choice]}</strong>
        </div>
        <b>VS</b>
        <div className="rps-side rps-side--pool">
          <small>Pool pick</small>
          <span className="rps-arena-icon">
            {busy ? <RpsPoolCycle /> : result ? <RpsMoveIcon move={result.outcome} size={72} /> : <Dice5 size={72} />}
          </span>
          <strong>{busy ? "..." : result ? labels[result.outcome] : "READY"}</strong>
        </div>
      </div>
      {result && <span className="arena-result">{result.status.toUpperCase()}</span>}
    </div>
  );
}

function RpsPoolCycle() {
  return (
    <span className="rps-cycle" aria-hidden="true">
      <span className="rps-cycle-item rps-cycle-item--rock"><RpsMoveIcon move={0} size={72} /></span>
      <span className="rps-cycle-item rps-cycle-item--scissors"><RpsMoveIcon move={1} size={72} /></span>
      <span className="rps-cycle-item rps-cycle-item--paper"><RpsMoveIcon move={2} size={72} /></span>
    </span>
  );
}

function RpsMoveIcon({ move, size = 22 }: { move: number; size?: number }) {
  if (move === 0) return <Gem size={size} strokeWidth={1.85} />;
  if (move === 1) return <Scissors size={size} strokeWidth={1.85} />;
  return <Hand size={size} strokeWidth={1.85} />;
}

function CoinArena({ animationMode, busy, choice, result }: { animationMode: number; busy: boolean; choice: number; result: RoundResult | null }) {
  const isDown = result ? result.outcome === 1 : choice === 1;
  const modeClass = busy ? `coin-arena--mode-${animationMode + 1}` : "";
  const isWheel = busy && animationMode === 3;
  return (
    <div className={`arena coin-arena ${modeClass} ${busy ? "arena--playing" : ""} ${result ? `arena--${result.status}` : ""}`}>
      <div className={`${isDown ? "simple-coin simple-coin--down" : "simple-coin"} ${busy ? "simple-coin--flipping" : ""} ${isWheel ? "simple-coin--wheel" : ""}`}>
        <span className="brand-mark" aria-hidden="true"><span /><span /></span>
        {isWheel && <i className="wheel-pointer" />}
      </div>
      <strong>{busy ? "FLIPPING" : result ? (result.outcome === 0 ? "LOGO UP" : "LOGO DOWN") : (choice === 0 ? "LOGO UP" : "LOGO DOWN")}</strong>
      {result && <span className="arena-result">{result.status.toUpperCase()}</span>}
    </div>
  );
}

function AdminPage({
  contractReady,
  isAdmin,
  provider,
  refresh,
  relayerHealth,
  setStatus,
  settings,
  walletAddress,
}: {
  contractReady: boolean;
  isAdmin: boolean;
  provider: BrowserProvider | null;
  refresh: () => Promise<void>;
  relayerHealth: RelayerHealth;
  setStatus: (status: TxStatus) => void;
  settings: SettingsState;
  walletAddress: string;
}) {
  const [entryFee, setEntryFee] = useState(String(settings.entryFeeBps / 100));
  const [winFee, setWinFee] = useState(String(settings.winFeeBps / 100));
  const [deposit, setDeposit] = useState("10");
  const [withdraw, setWithdraw] = useState("1");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEntryFee(String(settings.entryFeeBps / 100));
    setWinFee(String(settings.winFeeBps / 100));
  }, [settings.entryFeeBps, settings.winFeeBps]);

  async function runAdmin(action: "fees" | "deposit" | "withdraw" | "trustRelayer") {
    if (!contractReady || !provider) {
      setStatus({ tone: "warn", message: "Connect a wallet and configure the game contract first." });
      return;
    }

    try {
      setBusy(true);
      const signer = await provider.getSigner();
      const contract = new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, signer);
      const tx =
        action === "fees"
          ? await contract.setFees(Math.round(Number(entryFee) * 100), Math.round(Number(winFee) * 100))
          : action === "deposit"
            ? await contract.depositPool({ value: parseEther(deposit || "0") })
            : action === "trustRelayer"
              ? await contract.setTrustedRelayer(relayerHealth.relayerAddress, true)
              : await contract.withdrawPool(parseEther(withdraw || "0"), walletAddress);

      setStatus({ tone: "info", message: `Admin transaction ${shortAddress(tx.hash)} is waiting for confirmation...` });
      await tx.wait();
      setStatus({ tone: "ok", message: "Admin settings updated." });
      await refresh();
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-layout">
      <section className="admin-main">
        <div className="section-heading">
          <span>Settings</span>
          <h2>{isAdmin ? "Pool & Relayer Control" : "Pool Control"}</h2>
          <p className="admin-note">
            Pool liquidity is separate from player game balances. The owner can approve the backend relayer and fund or withdraw only pool liquidity.
          </p>
        </div>
        {!isAdmin && (
          <div className="restricted-panel">
            <strong>Admin access required</strong>
            <span>Connect the contract owner wallet to manage pool settings.</span>
          </div>
        )}
        {isAdmin && (
          <div className="admin-grid">
            <label className="number-field">
              <span>Entry fee %</span>
              <input value={entryFee} onChange={(event) => setEntryFee(event.target.value)} />
            </label>
            <label className="number-field">
              <span>Win fee %</span>
              <input value={winFee} onChange={(event) => setWinFee(event.target.value)} />
            </label>
            <button className="primary-action" disabled={busy} onClick={() => runAdmin("fees")} type="button">
              <Crown size={18} /> Save Fees
            </button>
          </div>
        )}
        {isAdmin && (
          <div className="admin-grid">
            <label className="number-field">
              <span>Deposit SRW</span>
              <input value={deposit} onChange={(event) => setDeposit(event.target.value)} />
            </label>
            <button className="secondary-action" disabled={!provider || busy} onClick={() => runAdmin("deposit")} type="button">
              Fund Pool
            </button>
            <label className="number-field">
              <span>Withdraw SRW</span>
              <input value={withdraw} onChange={(event) => setWithdraw(event.target.value)} />
            </label>
            <button className="secondary-action" disabled={busy} onClick={() => runAdmin("withdraw")} type="button">
              Withdraw
            </button>
            <button className="secondary-action" disabled={busy || !relayerHealth.relayerAddress || relayerHealth.trusted} onClick={() => runAdmin("trustRelayer")} type="button">
              Trust Relayer
            </button>
          </div>
        )}
      </section>

      <aside className="wager-panel">
        <span className="field-label">Admin status</span>
        <div className="receipt">
          <dl>
            <div><dt>Pool receiver</dt><dd>{GAME_CONTRACT_ADDRESS ? shortAddress(GAME_CONTRACT_ADDRESS) : "Not configured"}</dd></div>
            <div><dt>Owner</dt><dd>{settings.owner ? shortAddress(settings.owner) : "N/A"}</dd></div>
            <div><dt>Your wallet</dt><dd>{walletAddress ? shortAddress(walletAddress) : "Not connected"}</dd></div>
            <div><dt>Relayer</dt><dd>{relayerHealth.relayerAddress ? shortAddress(relayerHealth.relayerAddress) : "Offline"}</dd></div>
            <div><dt>Relayer trust</dt><dd>{relayerHealth.trusted ? "Trusted" : "Not trusted"}</dd></div>
            <div><dt>Seed status</dt><dd>{relayerHealth.seedCommitted ? "Committed" : "Pending"}</dd></div>
            <div><dt>Permission</dt><dd>{isAdmin ? "Admin" : "Read only"}</dd></div>
            <div><dt>Pool liquidity</dt><dd>{Number(settings.poolBalance).toFixed(4)} SRW</dd></div>
          </dl>
        </div>
      </aside>
    </div>
  );
}

function readStoredSession(address: string) {
  try {
    const raw = localStorage.getItem(sessionStorageKey(address));
    return raw ? JSON.parse(raw) as RelayerSession : null;
  } catch {
    return null;
  }
}

function writeStoredSession(address: string, session: RelayerSession) {
  localStorage.setItem(sessionStorageKey(address), JSON.stringify(session));
}

function sessionStorageKey(address: string) {
  return `${SESSION_STORAGE_PREFIX}:${GAME_CONTRACT_ADDRESS}:${address.toLowerCase()}`;
}

function readStoredHistory(address: string): Record<GameId, RoundHistoryEntry[]> {
  const empty = { coin: [], rps: [] };
  if (!address) return empty;
  try {
    const raw = localStorage.getItem(historyStorageKey(address));
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch {
    return empty;
  }
}

function writeStoredHistory(address: string, history: Record<GameId, RoundHistoryEntry[]>) {
  if (!address) return;
  localStorage.setItem(historyStorageKey(address), JSON.stringify(history));
}

function historyStorageKey(address: string) {
  return `${HISTORY_STORAGE_PREFIX}:${GAME_CONTRACT_ADDRESS}:${address.toLowerCase()}`;
}

function buildLeaderboardRows(players: readonly string[], scores: readonly bigint[], playCounts: readonly bigint[]): LeaderboardRow[] {
  return players
    .map((address, index) => ({
      rank: index + 1,
      address,
      reward: leaderboardRewardLabel(index + 1),
      playCount: Number(playCounts[index] ?? 0n),
      eligible: Number(playCounts[index] ?? 0n) >= 100,
      rawScore: scores[index] ?? 0n,
    }))
    .filter((row) => row.address && row.address !== "0x0000000000000000000000000000000000000000" && row.rawScore > 0n)
    .map(({ rawScore, ...row }) => row);
}

function leaderboardRewardLabel(rank: number) {
  if (rank === 1) return "3 SRW";
  if (rank <= 3) return "2 SRW";
  return "1 SRW";
}

function moveLabel(game: GameId, move: number) {
  if (game === "coin") return move === 0 ? "Logo Up" : "Logo Down";
  return ["Rock", "Scissors", "Paper"][move] ?? "-";
}

function parseRelayerRound(round: {
  roundId: string;
  gameType: number;
  betAmount: string;
  playerMove: number;
  outcome: number;
  result: number;
  payout: string;
}, game: GameId): RoundResult {
  const status = round.result === 1 ? "win" : round.result === 2 ? "draw" : "lose";
  const displayPayout = status === "win" ? Number(round.betAmount) * 2 : status === "draw" ? Number(round.betAmount) : 0;

  return {
    game,
    status,
    betAmount: round.betAmount,
    playerMove: round.playerMove,
    outcome: round.outcome,
    payout: String(displayPayout),
    roundId: round.roundId,
  };
}

function parseDirectRound(contract: Contract, logs: readonly { topics: readonly string[]; data: string }[], game: GameId): RoundResult {
  for (const log of logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: Array.from(log.topics), data: log.data });
      if (parsed?.name !== "RoundSettled") {
        continue;
      }

      return parseRelayerRound({
        roundId: parsed.args.roundId.toString(),
        gameType: Number(parsed.args.gameType),
        betAmount: formatEther(parsed.args.betAmount),
        playerMove: Number(parsed.args.playerMove),
        outcome: Number(parsed.args.outcome),
        result: Number(parsed.args.result),
        payout: formatEther(parsed.args.payout),
      }, game);
    } catch {
      continue;
    }
  }

  throw new Error("Direct play confirmed but round result was not found.");
}

function roundMessage(result: RoundResult) {
  if (result.status === "win") {
    return `You won round #${result.roundId}. Payout: ${safeAmount(Number(result.payout))} SRW.`;
  }
  if (result.status === "draw") {
    return `Round #${result.roundId} was a draw. Payout: ${safeAmount(Number(result.payout))} SRW.`;
  }
  return `Round #${result.roundId} settled as a loss.`;
}

function safeAmount(value: number) {
  if (!Number.isFinite(value)) return "0.0000";
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function splitCountdown(totalSeconds: number) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return {
    days: String(days),
    hours: padTime(hours),
    minutes: padTime(minutes),
    seconds: padTime(seconds),
  };
}

function padTime(value: number) {
  return String(value).padStart(2, "0");
}

function getErrorMessage(error: unknown) {
  const explainRevert = "Transaction reverted. Common causes: old contract address, low game balance, low pool liquidity, untrusted relayer, expired session, low session allowance, or bet outside limits.";

  if (typeof error === "object" && error) {
    if ("shortMessage" in error && typeof error.shortMessage === "string") {
      return error.shortMessage.includes("transaction execution reverted") ? explainRevert : error.shortMessage;
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message.includes("transaction execution reverted") ? explainRevert : error.message;
    }
  }
  const raw = String(error);
  if (raw.includes("transaction execution reverted")) {
    return explainRevert;
  }
  return raw === "undefined" ? "Unknown error" : raw;
}
