import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { ArrowRight, Cat, CheckCircle2, ChevronDown, ChevronRight, Coins, Crown, Dice5, Flag, Gauge, Gem, Hand, History, Landmark, Loader2, ReceiptText, Scissors, ShieldCheck, Trophy, WalletCards, X, Zap } from "lucide-react";
import { AbstractProvider, BrowserProvider, Contract, JsonRpcProvider, formatEther, hexlify, parseEther, randomBytes } from "ethers";
import { Brand } from "./components/Brand";
import { BetSelector } from "./components/BetSelector";
import { WalletBar } from "./components/WalletBar";
import { DEMO_MODE, GAME_CONTRACT_ADDRESS, RELAYER_URL, SIMPLE_CHAIN_ID, SIMPLE_RPC_URL, shortAddress } from "./lib/simpleChain";
import { PLAYGROUND_ABI, getPlaygroundContract } from "./lib/contract";
import { WalletState, connectWallet, getAuthorizedWallet, getInjectedProvider } from "./lib/wallet";

type Page = "lobby" | "leaderboard" | "rps" | "coin" | "cat" | "admin";
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
  leaderboardCycleDays: number;
  leaderboardRewards: string[];
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
  actualPayout: string;
  roundId: string;
};
type RoundHistoryEntry = RoundResult & {
  playedAt: number;
};
type LeaderboardRow = {
  rank: number;
  address: string;
  won: string;
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
  rewards: string[];
  cycleDays: number;
  previousEpoch: number;
  previousSettled: boolean;
  previousRows: LeaderboardRow[];
};
type CatRacePhase = "prepare" | "race" | "settled";
type CatRaceDisplayPhase = "prepare" | "race" | "finish";
type CatRaceLeaderboardRow = {
  rank: number;
  address: string;
  won: string;
};
type CatRaceHistoryEntry = {
  raceId: string;
  winnerCat: number;
  picks: string;
  payout: string;
  playedAt: number;
};
type CatRaceState = {
  raceId: number;
  phase: CatRacePhase;
  startedAt: number;
  bettingEndsAt: number;
  endsAt: number;
  winnerCat: number;
  totalBets: string[];
  playerBets: string[];
  previousRaceId: number;
  previousWinnerCat: number;
  previousPlayerBets: string[];
  previousClaimed: boolean;
  leaderboard: CatRaceLeaderboardRow[];
};

const SESSION_STORAGE_PREFIX = "simple-playground-relayer-session";
const HISTORY_STORAGE_PREFIX = "simple-playground-history";
const CAT_HISTORY_STORAGE_PREFIX = "simple-playground-cat-race-history";
const WALLET_LOGOUT_STORAGE_KEY = "simple-playground-wallet-logged-out";
const AUTO_SESSION_ALLOWANCE = "1000000";
const AUTO_SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;
const CAT_RACE_PREPARE_SECONDS = 30;
const CAT_RACE_RUN_SECONDS = 30;
const CAT_RACE_FINISH_SECONDS = 5;
const emptyWallet: WalletState = { provider: null, address: "", balance: "0", chainId: "" };
const emptyAccount: AccountState = { gameBalance: "0", sessionSpent: "0" };
const emptyHealth: RelayerHealth = { ok: false, contractAddress: "", relayerAddress: "", trusted: false, currentSeedHash: "", seedCommitted: false };
const defaultLeaderboardRewards = ["3", "2", "2", "1", "1", "1", "1", "1", "1", "1"];
const publicProvider = new JsonRpcProvider(SIMPLE_RPC_URL, SIMPLE_CHAIN_ID);
const emptyLeaderboard: LeaderboardState = { epoch: 0, startedAt: 0, endsAt: 0, settled: false, rows: [], rewards: defaultLeaderboardRewards, cycleDays: 5, previousEpoch: 0, previousSettled: true, previousRows: [] };
const emptyCatRace: CatRaceState = {
  raceId: 0,
  phase: "prepare",
  startedAt: 0,
  bettingEndsAt: 0,
  endsAt: 0,
  winnerCat: 0,
  totalBets: ["0", "0", "0", "0", "0"],
  playerBets: ["0", "0", "0", "0", "0"],
  previousRaceId: 0,
  previousWinnerCat: 0,
  previousPlayerBets: ["0", "0", "0", "0", "0"],
  previousClaimed: true,
  leaderboard: [],
};

const initialSettings: SettingsState = {
  entryFeeBps: 500,
  winFeeBps: 500,
  minBet: "0.01",
  maxBet: "100",
  poolBalance: "0",
  owner: "",
  leaderboardCycleDays: 5,
  leaderboardRewards: defaultLeaderboardRewards,
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
  {
    page: "cat" as const,
    title: "Cat Race",
    subtitle: "Pick one of five racers before the gate closes.",
    icon: Cat,
  },
];

export function App() {
  const [page, setPage] = useState<Page>("lobby");
  const [wallet, setWallet] = useState<WalletState>(emptyWallet);
  const [settings, setSettings] = useState<SettingsState>(initialSettings);
  const [account, setAccount] = useState<AccountState>(emptyAccount);
  const [relayerHealth, setRelayerHealth] = useState<RelayerHealth>(emptyHealth);
  const [relayerSession, setRelayerSession] = useState<RelayerSession | null>(null);
  const [status, setStatus] = useState<TxStatus>({ tone: "info", message: "Deposit SRW once, then Play will approve quick access automatically when needed." });
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [roundHistory, setRoundHistory] = useState<Record<GameId, RoundHistoryEntry[]>>({ coin: [], rps: [] });
  const [leaderboard, setLeaderboard] = useState<LeaderboardState>(emptyLeaderboard);
  const [catRace, setCatRace] = useState<CatRaceState>(emptyCatRace);
  const [catRaceHistory, setCatRaceHistory] = useState<CatRaceHistoryEntry[]>([]);
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
    void loadPublicChainState();
    const interval = window.setInterval(() => void loadRelayerHealth(), 10000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setRoundHistory(readStoredHistory(wallet.address));
    setCatRaceHistory(readStoredCatRaceHistory(wallet.address));
  }, [wallet.address]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (DEMO_MODE) return;
    void loadCatRace(publicProvider, wallet.address);
    const interval = window.setInterval(() => void loadCatRace(publicProvider, wallet.address), 5000);
    return () => window.clearInterval(interval);
  }, [wallet.address]);

  useEffect(() => {
    if (DEMO_MODE) return;
    if (catRace.phase === "race" && catRace.winnerCat >= 5) {
      void startCatRaceViaRelayer(catRace.raceId);
    }
  }, [catRace.phase, catRace.raceId, catRace.winnerCat]);

  useEffect(() => {
    if (!DEMO_MODE) return;
    const updateDemo = () => setCatRace(buildDemoCatRace(Math.floor(Date.now() / 1000), wallet.address));
    updateDemo();
    const interval = window.setInterval(updateDemo, 1000);
    return () => window.clearInterval(interval);
  }, [wallet.address]);

  useEffect(() => {
    let cancelled = false;
    const injectedProvider = getInjectedProvider();

    async function restoreWallet() {
      try {
        if (localStorage.getItem(WALLET_LOGOUT_STORAGE_KEY) === "1") {
          return;
        }
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
      if (localStorage.getItem(WALLET_LOGOUT_STORAGE_KEY) === "1") {
        return;
      }
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
      if (localStorage.getItem(WALLET_LOGOUT_STORAGE_KEY) === "1") {
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

    void restoreWallet();
    injectedProvider?.on?.("accountsChanged", handleAccountsChanged);
    injectedProvider?.on?.("chainChanged", handleChainChanged);

    return () => {
      cancelled = true;
      injectedProvider?.removeListener?.("accountsChanged", handleAccountsChanged);
      injectedProvider?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  useEffect(() => {
    void refreshChainState(wallet.provider, wallet.address, relayerSession);
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
      localStorage.removeItem(WALLET_LOGOUT_STORAGE_KEY);
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

  async function loadPublicChainState() {
    await Promise.all([
      loadSettings(publicProvider),
      loadLeaderboard(publicProvider),
      DEMO_MODE ? Promise.resolve() : loadCatRace(publicProvider, wallet.address),
    ]);
  }

  async function refreshChainState(provider = wallet.provider, address = wallet.address, session = relayerSession) {
    await loadPublicChainState();
    if (provider && address) {
      await refreshWallet(provider, address);
      await loadAccount(provider, address, session);
    }
  }

  function handleDisconnect() {
    localStorage.setItem(WALLET_LOGOUT_STORAGE_KEY, "1");
    setWallet(emptyWallet);
    setAccount(emptyAccount);
    setRelayerSession(null);
    setRoundResult(null);
    setStatus({ tone: "info", message: "Wallet logged out from this browser session." });
    void loadPublicChainState();
  }

  async function loadSettings(provider: AbstractProvider = publicProvider) {
    if (!contractReady) return;

    try {
      const contract = getPlaygroundContract(provider);
      const [entryFeeBps, winFeeBps, minBet, maxBet, owner, poolBalance, leaderboardEpochDuration, leaderboardRewards] = await Promise.all([
        contract.entryFeeBps(),
        contract.winFeeBps(),
        contract.minBet(),
        contract.maxBet(),
        contract.owner(),
        contract.poolLiquidity(),
        contract.leaderboardEpochDuration(),
        contract.leaderboardRewardsInfo(),
      ]);

      setSettings({
        entryFeeBps: Number(entryFeeBps),
        winFeeBps: Number(winFeeBps),
        minBet: formatEther(minBet),
        maxBet: formatEther(maxBet),
        owner,
        poolBalance: formatEther(poolBalance),
        leaderboardCycleDays: Math.max(Math.round(Number(leaderboardEpochDuration) / 86400), 1),
        leaderboardRewards: Array.from(leaderboardRewards as readonly bigint[]).map((reward) => formatEther(reward)),
      });
    } catch (error) {
      setStatus({ tone: "warn", message: `Could not load contract settings: ${getErrorMessage(error)}` });
    }
  }

  async function loadLeaderboard(provider: AbstractProvider = publicProvider) {
    if (!contractReady) return;

    try {
      const contract = getPlaygroundContract(provider);
      const [epochRaw, rewardAmounts] = await Promise.all([
        contract.currentLeaderboardEpoch(),
        contract.leaderboardRewardsInfo(),
      ]);
      const epoch = Number(epochRaw);
      const rewards = Array.from(rewardAmounts as readonly bigint[]).map((reward) => formatEther(reward));
      const [players, scores, playCounts, startedAt, endsAt, settled] = await contract.leaderboardEpochInfo(BigInt(epoch));
      let previousRows: LeaderboardRow[] = [];
      let previousSettled = true;

      if (epoch > 1) {
        const [previousPlayers, previousScores, previousPlayCounts, , , previousRewardsSettled] = await contract.leaderboardEpochInfo(BigInt(epoch - 1));
        previousRows = buildLeaderboardRows(previousPlayers, previousScores, previousPlayCounts, rewards);
        previousSettled = Boolean(previousRewardsSettled);
      }

      const started = Number(startedAt);
      const ends = Number(endsAt);

      setLeaderboard({
        epoch,
        startedAt: started,
        endsAt: ends,
        settled: Boolean(settled),
        rows: buildLeaderboardRows(players, scores, playCounts, rewards),
        rewards,
        cycleDays: Math.max(Math.round((ends - started) / 86400), 1),
        previousEpoch: epoch > 1 ? epoch - 1 : 0,
        previousSettled,
        previousRows,
      });
    } catch {
      setLeaderboard(emptyLeaderboard);
    }
  }

  async function loadCatRace(provider: AbstractProvider = publicProvider, address = wallet.address) {
    if (!contractReady) return;

    try {
      const contract = getPlaygroundContract(provider);
      const [info, leaderboardInfo] = await Promise.all([
        contract.catRaceCurrentInfo(),
        contract.catRaceLeaderboardInfo(),
      ]);
      const raceId = Number(info.raceId);
      const previousRaceId = Math.max(raceId - 1, 0);
      let playerBets = ["0", "0", "0", "0", "0"];
      let previousPlayerBets = ["0", "0", "0", "0", "0"];
      let previousWinnerCat = 0;
      let previousClaimed = true;

      if (address) {
        const currentBetReads = [0, 1, 2, 3, 4].map((cat) => contract.catRacePlayerBets(BigInt(raceId), address, cat));
        const previousBetReads = previousRaceId > 0
          ? [0, 1, 2, 3, 4].map((cat) => contract.catRacePlayerBets(BigInt(previousRaceId), address, cat))
          : [];
        const [currentBets, previousInfo, previousBets, claimed] = await Promise.all([
          Promise.all(currentBetReads),
          previousRaceId > 0 ? contract.catRaceRoundInfo(BigInt(previousRaceId)) : null,
          Promise.all(previousBetReads),
          previousRaceId > 0 ? contract.catRaceClaimed(BigInt(previousRaceId), address) : true,
        ]);
        playerBets = currentBets.map((amount) => formatEther(amount));
        previousPlayerBets = previousBets.map((amount) => formatEther(amount));
        previousWinnerCat = previousInfo ? Number(previousInfo.winnerCat) : 0;
        previousClaimed = Boolean(claimed);
      } else if (previousRaceId > 0) {
        const previousInfo = await contract.catRaceRoundInfo(BigInt(previousRaceId));
        previousWinnerCat = Number(previousInfo.winnerCat);
      }

      const [players, wonTotals] = leaderboardInfo;
      setCatRace({
        raceId,
        phase: Number(info.phase) === 0 ? "prepare" : Number(info.phase) === 1 ? "race" : "settled",
        startedAt: Number(info.startedAt),
        bettingEndsAt: Number(info.bettingEndsAt),
        endsAt: Number(info.endsAt),
        winnerCat: Number(info.winnerCat),
        totalBets: Array.from(info.totalBets as readonly bigint[]).map((amount) => formatEther(amount)),
        playerBets,
        previousRaceId,
        previousWinnerCat,
        previousPlayerBets,
        previousClaimed,
        leaderboard: buildCatRaceLeaderboardRows(players, wonTotals),
      });
    } catch {
      setCatRace(emptyCatRace);
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

  async function authorizeRelayerSession() {
    if (!(await ensurePlayable()) || !wallet.provider || !wallet.address) return null;
    const health = await loadRelayerHealth();

    if (!health.relayerAddress || !health.ok || !health.trusted || !health.seedCommitted) {
      setStatus({ tone: "warn", message: "Relayer is offline. Wallet play fallback is available." });
      return null;
    }

    try {
      const signer = await wallet.provider.getSigner();
      const expiresAt = Math.floor(Date.now() / 1000) + AUTO_SESSION_DURATION_SECONDS;
      const nonce = BigInt(`0x${hexlify(randomBytes(16)).slice(2)}`).toString();
      const allowanceWei = parseEther(AUTO_SESSION_ALLOWANCE);
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
      const session = { relayer: health.relayerAddress, allowance: AUTO_SESSION_ALLOWANCE, expiresAt, nonce, signature };
      writeStoredSession(wallet.address, session);
      setRelayerSession(session);
      setAccount((current) => ({ ...current, sessionSpent: "0" }));
      setStatus({ tone: "ok", message: "Quick play access approved." });
      return session;
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
      return null;
    }
  }

  async function playGame(game: GameId, choice: number, bet: string) {
    if (!(await ensurePlayable()) || !wallet.provider || !wallet.address) return;

    const accountBeforePlay = account;
    const betAmount = Number(bet || "0");
    const chargedBalance = subtractRoundCost(accountBeforePlay.gameBalance, bet, settings.entryFeeBps);
    let optimisticApplied = false;
    let resultSettled = false;

    try {
      setBusy(true);
      setRoundResult(null);

      let activeSession = relayerSession;
      let activeSessionReady = Boolean(
        relayerReady &&
        activeSession &&
        activeSession.expiresAt > Math.floor(Date.now() / 1000) &&
        Number(activeSession.allowance) - Number(account.sessionSpent) >= betAmount &&
        (!relayerHealth.relayerAddress || activeSession.relayer.toLowerCase() === relayerHealth.relayerAddress.toLowerCase())
      );

      if (relayerReady && !activeSessionReady) {
        setStatus({ tone: "info", message: "Approve quick play access in your wallet." });
        activeSession = await authorizeRelayerSession();
        if (!activeSession) return;
        activeSessionReady = true;
      }

      setPlaying(true);
      setAccount((current) => ({
        ...current,
        gameBalance: chargedBalance,
        sessionSpent: activeSessionReady ? addEtherStrings(current.sessionSpent, bet) : current.sessionSpent,
      }));
      optimisticApplied = true;

      const playerSeed = hexlify(randomBytes(32));
      let parsedResult: RoundResult;
      let exactAccountAfterRound: AccountState | null = null;

      if (activeSessionReady && activeSession) {
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
            sessionAllowance: activeSession.allowance,
            sessionExpiresAt: activeSession.expiresAt,
            sessionNonce: activeSession.nonce,
            sessionSignature: activeSession.signature,
          }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "Relayer play failed");
        }

        parsedResult = parseRelayerRound(payload.round, game);
        if (payload.account?.gameBalance !== undefined && payload.account?.sessionSpent !== undefined) {
          exactAccountAfterRound = {
            gameBalance: String(payload.account.gameBalance),
            sessionSpent: String(payload.account.sessionSpent),
          };
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
      resultSettled = true;
      setRoundResult(parsedResult);
      setAccount((current) => ({
        ...(exactAccountAfterRound ?? current),
        gameBalance: exactAccountAfterRound?.gameBalance ?? addEtherStrings(chargedBalance, parsedResult.actualPayout),
      }));
      addHistoryEntry(wallet.address, parsedResult);
      setStatus({ tone: parsedResult.status === "win" ? "ok" : parsedResult.status === "draw" ? "warn" : "info", message: roundMessage(parsedResult) });
      await Promise.all([refreshWallet(), loadSettings(wallet.provider), loadAccount(wallet.provider, wallet.address, activeSession), loadRelayerHealth(), loadLeaderboard(wallet.provider)]);
    } catch (error) {
      if (optimisticApplied && !resultSettled) {
        setAccount(accountBeforePlay);
      }
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

  async function placeCatRaceBet(cat: number, bet: string) {
    if (DEMO_MODE) {
      setStatus({ tone: "ok", message: `Demo bet placed on ${catName(cat)}.` });
      setCatRace((current) => {
        const totalBets = [...current.totalBets];
        const playerBets = [...current.playerBets];
        totalBets[cat] = addEtherStrings(totalBets[cat] ?? "0", bet);
        playerBets[cat] = addEtherStrings(playerBets[cat] ?? "0", bet);
        return { ...current, totalBets, playerBets };
      });
      return;
    }
    if (!(await ensurePlayable()) || !wallet.provider || !wallet.address) return;
    const accountBeforeBet = account;
    try {
      setBusy(true);
      setAccount((current) => ({
        ...current,
        gameBalance: subtractRoundCost(current.gameBalance, bet, settings.entryFeeBps),
      }));
      const signer = await wallet.provider.getSigner();
      const contract = new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, signer);
      const tx = await contract.placeCatRaceBet(cat, parseEther(bet || "0"));
      setStatus({ tone: "info", message: `Cat Race bet ${shortAddress(tx.hash)} submitted...` });
      await tx.wait();
      setStatus({ tone: "ok", message: `Bet placed on ${catName(cat)}.` });
      await Promise.all([loadAccount(wallet.provider, wallet.address, relayerSession), loadCatRace(publicProvider, wallet.address)]);
    } catch (error) {
      setAccount(accountBeforeBet);
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function settleCatRaceBet(raceId: number) {
    if (DEMO_MODE) {
      const payout = catRace.previousPlayerBets[catRace.previousWinnerCat] ? String(Number(catRace.previousPlayerBets[catRace.previousWinnerCat]) * 5) : "0";
      const entry = {
        raceId: String(raceId || catRace.previousRaceId || 1),
        winnerCat: catRace.previousWinnerCat,
        picks: catRace.previousPlayerBets
          .map((amount, index) => Number(amount) > 0 ? `${catName(index)} ${safeAmount(Number(amount))}` : "")
          .filter(Boolean)
          .join(", ") || "Demo picks",
        payout,
        playedAt: Date.now(),
      };
      setCatRaceHistory((current) => [entry, ...current].slice(0, 20));
      setSuccessPopup({
        title: Number(payout) > 0 ? "Demo payout" : "Demo race settled",
        amount: `${safeAmount(Number(payout))} SRW`,
        detail: `${catName(catRace.previousWinnerCat)} crossed the finish line.`,
      });
      setStatus({ tone: Number(payout) > 0 ? "ok" : "info", message: `Demo race #${entry.raceId} settled.` });
      return;
    }
    if (!(await ensurePlayable()) || !wallet.provider || !wallet.address || !raceId) return;
    try {
      setBusy(true);
      const signer = await wallet.provider.getSigner();
      const contract = new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, signer);
      const tx = await contract.settleCatRaceBet(BigInt(raceId));
      setStatus({ tone: "info", message: `Cat Race claim ${shortAddress(tx.hash)} submitted...` });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Cat Race claim was not confirmed.");
      const result = parseCatRaceSettlement(contract, receipt.logs);
      addCatRaceHistoryEntry(wallet.address, {
        raceId: String(result.raceId),
        winnerCat: result.winnerCat,
        picks: catRace.previousPlayerBets
          .map((amount, index) => Number(amount) > 0 ? `${catName(index)} ${safeAmount(Number(amount))}` : "")
          .filter(Boolean)
          .join(", ") || "-",
        payout: result.payout,
        playedAt: Date.now(),
      });
      setSuccessPopup({
        title: Number(result.payout) > 0 ? "Cat Race payout" : "Race settled",
        amount: `${safeAmount(Number(result.payout))} SRW`,
        detail: `${catName(result.winnerCat)} crossed the finish line.`,
      });
      setStatus({ tone: Number(result.payout) > 0 ? "ok" : "info", message: `${catName(result.winnerCat)} won race #${result.raceId}.` });
      await Promise.all([loadAccount(wallet.provider, wallet.address, relayerSession), loadCatRace(publicProvider, wallet.address)]);
    } catch (error) {
      setStatus({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function startCatRaceViaRelayer(raceId: number) {
    if (!raceId) return;
    try {
      await fetch(`${RELAYER_URL}/api/cat-race/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raceId }),
      });
      await loadCatRace(publicProvider, wallet.address);
    } catch {
      // Wallet fallback still lets the first claimant finalize the race after it ends.
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

  function addCatRaceHistoryEntry(address: string, entry: CatRaceHistoryEntry) {
    setCatRaceHistory((current) => {
      const next = [entry, ...current].slice(0, 20);
      writeStoredCatRaceHistory(address, next);
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
          <button className={page === "cat" ? "nav-item nav-item--active" : "nav-item"} onClick={() => setPage("cat")} type="button">
            <Cat size={18} /> Cat Race
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
          <small>{sessionReady ? "Quick play ready" : relayerReady ? "Quick play available" : "Wallet play fallback ready"}</small>
        </div>
      </aside>

      <section className="content">
        <WalletBar wallet={wallet} isAdmin={isAdmin} onAdmin={() => setPage("admin")} onConnect={handleConnect} onDisconnect={handleDisconnect} onRefresh={() => void refreshChainState()} busy={busy} />
        <StatusBanner status={status} busy={busy} />

        {page === "lobby" && <Lobby account={account} onOpen={setPage} settings={settings} />}
        {page === "leaderboard" && <LeaderboardPage busy={busy} leaderboard={leaderboard} now={now} onSettleRewards={settleLeaderboardRewards} />}
        {page === "rps" && (
          <RpsPage
            account={account}
            busy={busy}
            playing={playing}
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
        {page === "cat" && (
          <CatRacePage
            account={account}
            busy={busy}
            catRace={catRace}
            history={catRaceHistory}
            now={now}
            onBet={placeCatRaceBet}
            onClaim={settleCatRaceBet}
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
            <strong>{leaderboard.cycleDays || "-"}-day cycle</strong>
          </div>
          <div className="countdown-grid">
            <TimeBox value={leaderboard.endsAt ? countdown.days : "--"} label="Days" />
            <TimeBox value={leaderboard.endsAt ? countdown.hours : "--"} label="Hours" />
            <TimeBox value={leaderboard.endsAt ? countdown.minutes : "--"} label="Minutes" />
            <TimeBox value={leaderboard.endsAt ? countdown.seconds : "--"} label="Seconds" />
          </div>
          <div className="progress-meta">
            <span>Start {leaderboard.startedAt ? formatDateTime(leaderboard.startedAt) : "--"}</span>
            <span>End {leaderboard.endsAt ? formatDateTime(leaderboard.endsAt) : "--"}</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }} />
            {leaderboard.cycleDays > 1 && Array.from({ length: leaderboard.cycleDays - 1 }).map((_, index) => (
              <i key={index} style={{ left: `${((index + 1) / leaderboard.cycleDays) * 100}%` }} />
            ))}
          </div>
        </div>

        <LeaderboardTable rows={leaderboard.rows} />
      </section>

      <aside className="wager-panel">
        <div className="receipt">
          <ReceiptText size={18} />
          <dl>
            {leaderboard.rewards.map((reward, index) => (
              <div key={index}><dt>Top {index + 1}</dt><dd>{safeAmount(Number(reward))} SRW</dd></div>
            ))}
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
              <th>Won</th>
              <th>Reward</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.address}>
                <td>#{row.rank}</td>
                <td>{shortAddress(row.address)}</td>
                <td><span className={row.eligible ? "criteria-badge criteria-badge--ok" : "criteria-badge"}>{row.playCount}/100 games</span></td>
                <td>{safeAmount(Number(row.won))} SRW</td>
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
          <h1>Simple Playground</h1>
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
  const betAmount = Number(bet || "0");
  const visiblePrize = betAmount * 2;
  const totalCost = betAmount + (betAmount * settings.entryFeeBps) / 10000;
  const worstCasePayout = visiblePrize - (visiblePrize * settings.winFeeBps) / 10000;
  const sessionRemaining = Math.max(Number(relayerSession?.allowance ?? "0") - Number(account.sessionSpent), 0);
  const hasBalance = Number(account.gameBalance) >= totalCost;
  const hasPoolLiquidity = Number(settings.poolBalance) >= worstCasePayout;
  const isWithinLimits = betAmount >= Number(settings.minBet) && betAmount <= Number(settings.maxBet);
  const canUseQuickPlay = relayerHealth.ok && relayerHealth.trusted && relayerHealth.seedCommitted;
  const hasSignedQuickPlay = sessionReady && sessionRemaining >= betAmount;
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
          onDeposit={onDeposit}
          onWithdraw={onWithdraw}
          relayerHealth={relayerHealth}
          sessionReady={sessionReady}
          setDepositAmount={setDepositAmount}
          setWithdrawAmount={setWithdrawAmount}
          withdrawAmount={withdrawAmount}
        />
        <div className={playMode === "quick" ? "play-mode play-mode--quick" : "play-mode play-mode--wallet"}>
          <span className={playMode === "quick" ? "status-dot status-dot--online" : "status-dot status-dot--offline"} />
          <div>
            <strong>{playMode === "quick" ? (hasSignedQuickPlay ? "Quick play ready" : "Quick play available") : "Wallet play fallback"}</strong>
            <small>{playMode === "quick" ? (hasSignedQuickPlay ? "No wallet popup for each round." : "First Play asks for one quick access signature.") : "Confirm each round in your wallet."}</small>
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
  onDeposit,
  onWithdraw,
  relayerHealth,
  sessionReady,
  setDepositAmount,
  setWithdrawAmount,
  withdrawAmount,
}: {
  account: AccountState;
  busy: boolean;
  depositAmount: string;
  onDeposit: (amount: string) => void;
  onWithdraw: (amount: string) => void;
  relayerHealth: RelayerHealth;
  sessionReady: boolean;
  setDepositAmount: (amount: string) => void;
  setWithdrawAmount: (amount: string) => void;
  withdrawAmount: string;
}) {
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
          <strong>{sessionReady ? "Quick play ready" : "Quick play"}</strong>
          <span className={relayerHealth.ok ? "relayer-badge relayer-badge--online" : "relayer-badge relayer-badge--offline"}>
            <i />
            {relayerHealth.ok ? "Relayer online" : "Relayer offline"}
          </span>
        </div>
        <span>{sessionReady ? "No tx sign for each round." : relayerHealth.ok && relayerHealth.trusted && relayerHealth.seedCommitted ? "First Play asks for one access signature." : "Wallet fallback is available."}</span>
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

function CatRacePage({
  account,
  busy,
  catRace,
  history,
  now,
  onBet,
  onClaim,
  settings,
}: {
  account: AccountState;
  busy: boolean;
  catRace: CatRaceState;
  history: CatRaceHistoryEntry[];
  now: number;
  onBet: (cat: number, bet: string) => void;
  onClaim: (raceId: number) => void;
  settings: SettingsState;
}) {
  const [selectedCat, setSelectedCat] = useState(0);
  const [bet, setBet] = useState("0.1");
  const betAmount = Number(bet || "0");
  const totalCost = betAmount + (betAmount * settings.entryFeeBps) / 10000;
  const worstCasePayout = betAmount * 5 - (betAmount * 5 * settings.winFeeBps) / 10000;
  const displayPhase = catRaceDisplayPhase(catRace, now);
  const isPrepare = displayPhase === "prepare";
  const isFinish = displayPhase === "finish";
  const canBet = isPrepare
    && betAmount > 0
    && betAmount >= Number(settings.minBet)
    && betAmount <= Number(settings.maxBet)
    && Number(account.gameBalance) >= totalCost
    && Number(settings.poolBalance) >= worstCasePayout;
  const canClaim = catRace.previousRaceId > 0
    && !catRace.previousClaimed
    && catRace.previousPlayerBets.some((amount) => Number(amount) > 0);
  const remaining = catRacePhaseRemaining(catRace, now, displayPhase);
  const countdown = splitCountdown(remaining);
  const urgentCountdown = remaining > 0 && remaining <= 10;
  const totalRacePool = catRace.totalBets.reduce((sum, amount) => sum + Number(amount), 0);

  return (
    <div className="cat-race-layout">
      <section className="cat-race-main">
        <div className="section-heading">
          <div>
            <span>Multiplayer Race</span>
            <h2>Cat Race #{catRace.raceId || "-"}</h2>
          </div>
          {DEMO_MODE && <div className="demo-pill">Demo Mode</div>}
          <div className={`race-phase race-phase--${displayPhase}`}>
            <Flag size={17} />
            {displayPhase === "prepare" ? "Prepare for race" : displayPhase === "race" ? "Race running" : "Finish celebration"}
          </div>
        </div>

        {!isPrepare && (
          <div className={urgentCountdown ? "race-clock race-clock--urgent" : "race-clock"}>
            <strong>{countdown.minutes}:{countdown.seconds}</strong>
            <span>{displayPhase === "race" ? "Finish line countdown" : "Next race starts soon"}</span>
          </div>
        )}

        <CatRaceArena catRace={catRace} displayPhase={displayPhase} now={now} phaseRemaining={remaining} urgentCountdown={urgentCountdown} />

        <div className="cat-bet-grid">
          {catRace.totalBets.map((amount, index) => (
            <button className={selectedCat === index ? "cat-card cat-card--active" : "cat-card"} key={index} onClick={() => setSelectedCat(index)} type="button">
              <span className="cat-avatar"><CatSprite cat={index} mini /></span>
              <strong>{catName(index)}</strong>
              <small>Total {safeAmount(Number(amount))} SRW</small>
              <em>Your bet {safeAmount(Number(catRace.playerBets[index] ?? "0"))} SRW</em>
              <i>5.00x</i>
            </button>
          ))}
        </div>

        <CatRaceHistory history={history} />
      </section>

      <aside className="wager-panel">
        <BetSelector bet={bet} setBet={setBet} />
        <div className="receipt">
          <ReceiptText size={18} />
          <dl>
            <div><dt>Selected cat</dt><dd>{catName(selectedCat)}</dd></div>
            <div><dt>Bet</dt><dd>{safeAmount(betAmount)} SRW</dd></div>
            <div><dt>Prize target</dt><dd>{safeAmount(betAmount * 5)} SRW</dd></div>
            <div><dt>Race pool</dt><dd>{safeAmount(totalRacePool)} SRW</dd></div>
          </dl>
        </div>
        {!isPrepare && <div className="play-warning">{isFinish ? "The winner is crossing the finish line. Next betting round starts soon." : "Betting is locked while the cats are racing."}</div>}
        {isPrepare && !canBet && <div className="play-warning">Check game balance, pool liquidity, and bet limits before placing a race bet.</div>}
        <button className="primary-action" disabled={busy || !canBet} onClick={() => onBet(selectedCat, bet)} type="button">
          {busy ? <Loader2 className="spin" size={18} /> : <Cat size={18} />}
          Bet on {catName(selectedCat)}
        </button>
        <button className="secondary-action" disabled={busy || !canClaim} onClick={() => onClaim(catRace.previousRaceId)} type="button">
          <Trophy size={18} />
          Claim Race #{catRace.previousRaceId || "-"}
        </button>
        <div className="cat-result-box">
          <span>Previous winner</span>
          <strong>{catRace.previousRaceId && catRace.previousWinnerCat < 5 ? catName(catRace.previousWinnerCat) : "-"}</strong>
          <small>{canClaim ? "Your previous race can be settled." : "Settled results appear in history."}</small>
        </div>
        <CatRaceLeaderboard rows={catRace.leaderboard} />
      </aside>
    </div>
  );
}

function CatRaceArena({
  catRace,
  displayPhase,
  now,
  phaseRemaining,
  urgentCountdown,
}: {
  catRace: CatRaceState;
  displayPhase: CatRaceDisplayPhase;
  now: number;
  phaseRemaining: number;
  urgentCountdown: boolean;
}) {
  const finishWinnerCat = displayPhase === "finish" && catRace.phase === "prepare" ? catRace.previousWinnerCat : catRace.winnerCat;
  const winnerKnown = finishWinnerCat < 5;
  const raceProgress = catRaceRaceProgress(catRace, now, displayPhase);
  const finishVisible = displayPhase === "finish" || (displayPhase === "race" && raceProgress >= 0.72);
  const revealWinner = winnerKnown && displayPhase === "finish";
  const finishApproach = Math.min(Math.max((raceProgress - 0.72) / 0.28, 0), 1);
  const startLineX = displayPhase === "prepare" ? 7 : 7 - raceProgress * 52;
  const startLineOpacity = displayPhase === "prepare" ? 1 : Math.max(1 - raceProgress * 4, 0);
  const finishLineX = displayPhase === "finish" ? 95 : 126 - finishApproach * 31;
  const popupCountdown = splitCountdown(phaseRemaining);

  return (
    <div
      className={`cat-race-arena cat-race-arena--${displayPhase} ${finishVisible ? "cat-race-arena--finish-visible" : ""} ${revealWinner ? "cat-race-arena--finished" : ""}`}
      style={{ "--race-progress": raceProgress, "--start-line-x": `${startLineX}%`, "--start-line-opacity": startLineOpacity, "--finish-line-x": `${finishLineX}%` } as CSSProperties}
    >
      <div className="race-event-strip">
        <strong>{displayPhase === "race" ? "Road sprint" : displayPhase === "finish" ? "Finish moment" : "Choose your racer"}</strong>
        <span>{displayPhase === "race" ? "Start line falls behind. Finish gate approaches." : displayPhase === "finish" ? "Winner crosses. Next round starts in seconds." : "Choose a cat and place your SRW bet."}</span>
      </div>
      <div className="finish-gate"><span>FINISH</span></div>
      {displayPhase === "prepare" && (
        <div className={urgentCountdown ? "betting-popup betting-popup--urgent" : "betting-popup"}>
          <img alt="" src="/assets/cat-winner-laugh.png" />
          <div>
            <span>{catRace.previousRaceId > 0 ? `Last winner: ${catName(catRace.previousWinnerCat)}` : "Cat Race is open"}</span>
            <strong>{urgentCountdown ? "Last chance to bet" : "Pick your cat now"}</strong>
            <p>{urgentCountdown ? "Betting closes in the final seconds." : "Choose a racer, set your SRW amount, and join the next 30-second sprint."}</p>
          </div>
          <b className={urgentCountdown ? "betting-popup-clock betting-popup-clock--urgent" : "betting-popup-clock"}>{popupCountdown.minutes}:{popupCountdown.seconds}</b>
        </div>
      )}
      {[0, 1, 2, 3, 4].map((cat) => {
        const motion = catMotion(cat, raceProgress, winnerKnown ? finishWinnerCat : -1, displayPhase === "prepare" ? "prepare" : "race", now);
        const isWinner = revealWinner && cat === finishWinnerCat;
        const isLoser = revealWinner && cat !== finishWinnerCat;
        return (
          <div className="cat-lane" key={cat}>
            <span className="lane-label">{catName(cat)}<small>{safeAmount(Number(catRace.totalBets[cat] ?? "0"))} SRW</small></span>
            <div className="lane-track">
              <span className="start-line" />
              <span className="finish-line" />
              <div
                className={`cat-runner cat-runner--${cat} ${displayPhase === "race" ? "cat-runner--racing" : ""} ${isWinner ? "cat-runner--winner cat-runner--finish-winner" : ""} ${isLoser ? "cat-runner--loser-cry" : ""}`}
                style={{ "--cat-x": `${motion.position}%`, "--cat-bob": `${motion.bob}px`, "--cat-color": catColor(cat), "--cat-accent": catAccent(cat) } as CSSProperties}
              >
                <span className="cat-speed"><Gauge size={12} /> {motion.speed} km/h</span>
                <CatSprite cat={cat} expression={isWinner ? "happy" : isLoser ? "cry" : ""} />
              </div>
            </div>
          </div>
        );
      })}
      {revealWinner && (
        <div className="race-fireworks" aria-hidden="true">
          <i /><i /><i /><i /><i />
        </div>
      )}
      {revealWinner && (
        <div className="race-winner-banner">
          <strong>{catName(finishWinnerCat)} wins</strong>
          <span>The winner crossed the finish line. Next race starts now.</span>
        </div>
      )}
    </div>
  );
}

function CatSprite({ cat, expression = "", mini = false }: { cat: number; expression?: string; mini?: boolean }) {
  return (
    <span className={mini ? `cat-sprite cat-sprite--mini cat-sprite--${cat} cat-sprite--${expression}` : `cat-sprite cat-sprite--${cat} cat-sprite--${expression}`} aria-hidden="true">
      <i className="cat-tail" />
      <i className="cat-body" />
      <i className="cat-head"><b /><b /><em /></i>
      <i className="cat-leg cat-leg--front" />
      <i className="cat-leg cat-leg--back" />
    </span>
  );
}

function CatRaceLeaderboard({ rows }: { rows: CatRaceLeaderboardRow[] }) {
  return (
    <div className="cat-leaderboard">
      <span className="field-label">Cat Race Winners</span>
      {rows.length === 0 ? (
        <small>No winners yet.</small>
      ) : (
        rows.map((row) => (
          <div key={row.address}>
            <b>#{row.rank}</b>
            <span>{shortAddress(row.address)}</span>
            <strong>{safeAmount(Number(row.won))} SRW</strong>
          </div>
        ))
      )}
    </div>
  );
}

function CatRaceHistory({ history }: { history: CatRaceHistoryEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="history-panel">
      <button className="history-toggle" onClick={() => setOpen((value) => !value)} type="button">
        <span><History size={17} /> Race History</span>
        <small>{history.length}/20</small>
        {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
      </button>
      {open && (
        <div className="history-table-wrap">
          {history.length === 0 ? (
            <div className="history-empty">No race settlements yet.</div>
          ) : (
            <table className="history-table">
              <thead>
                <tr>
                  <th>Race</th>
                  <th>Winner</th>
                  <th>Your picks</th>
                  <th>Payout</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={`${item.raceId}-${item.playedAt}`}>
                    <td>#{item.raceId}</td>
                    <td>{catName(item.winnerCat)}</td>
                    <td>{item.picks}</td>
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
  const [cycleDays, setCycleDays] = useState(String(settings.leaderboardCycleDays));
  const [leaderboardRewards, setLeaderboardRewards] = useState<string[]>(settings.leaderboardRewards);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEntryFee(String(settings.entryFeeBps / 100));
    setWinFee(String(settings.winFeeBps / 100));
    setCycleDays(String(settings.leaderboardCycleDays));
    setLeaderboardRewards(settings.leaderboardRewards);
  }, [settings.entryFeeBps, settings.winFeeBps, settings.leaderboardCycleDays, settings.leaderboardRewards]);

  async function runAdmin(action: "fees" | "deposit" | "withdraw" | "trustRelayer" | "leaderboardRewards" | "leaderboardCycle") {
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
              : action === "leaderboardRewards"
                ? await contract.setLeaderboardRewards(leaderboardRewards.map((reward) => parseEther(reward || "0")))
                : action === "leaderboardCycle"
                  ? await contract.setLeaderboardCycleDays(Math.round(Number(cycleDays || "0")))
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
              <span>Leaderboard cycle days</span>
              <input value={cycleDays} onChange={(event) => setCycleDays(event.target.value)} />
            </label>
            <button className="secondary-action" disabled={busy} onClick={() => runAdmin("leaderboardCycle")} type="button">
              Save Cycle
            </button>
          </div>
        )}
        {isAdmin && (
          <div className="admin-reward-panel">
            <span className="field-label">Leaderboard rewards</span>
            <div className="admin-grid admin-grid--rewards">
              {leaderboardRewards.map((reward, index) => (
                <label className="number-field" key={index}>
                  <span>Top {index + 1} reward SRW</span>
                  <input
                    value={reward}
                    onChange={(event) => {
                      const next = [...leaderboardRewards];
                      next[index] = event.target.value;
                      setLeaderboardRewards(next);
                    }}
                  />
                </label>
              ))}
            </div>
            <button className="secondary-action" disabled={busy} onClick={() => runAdmin("leaderboardRewards")} type="button">
              Save Rewards
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
            <div><dt>Leaderboard cycle</dt><dd>{settings.leaderboardCycleDays} days</dd></div>
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

function readStoredCatRaceHistory(address: string): CatRaceHistoryEntry[] {
  if (!address) return [];
  try {
    const raw = localStorage.getItem(catRaceHistoryStorageKey(address));
    return raw ? JSON.parse(raw) as CatRaceHistoryEntry[] : [];
  } catch {
    return [];
  }
}

function writeStoredCatRaceHistory(address: string, history: CatRaceHistoryEntry[]) {
  if (!address) return;
  localStorage.setItem(catRaceHistoryStorageKey(address), JSON.stringify(history));
}

function catRaceHistoryStorageKey(address: string) {
  return `${CAT_HISTORY_STORAGE_PREFIX}:${GAME_CONTRACT_ADDRESS}:${address.toLowerCase()}`;
}

function buildLeaderboardRows(players: readonly string[], scores: readonly bigint[], playCounts: readonly bigint[], rewards: readonly string[]): LeaderboardRow[] {
  return players
    .map((address, index) => ({
      rank: index + 1,
      address,
      won: formatEther(scores[index] ?? 0n),
      reward: `${safeAmount(Number(rewards[index] ?? "0"))} SRW`,
      playCount: Number(playCounts[index] ?? 0n),
      eligible: Number(playCounts[index] ?? 0n) >= 100,
      rawScore: scores[index] ?? 0n,
    }))
    .filter((row) => row.address && row.address !== "0x0000000000000000000000000000000000000000" && row.rawScore > 0n)
    .map(({ rawScore, ...row }) => row);
}

function buildCatRaceLeaderboardRows(players: readonly string[], wonTotals: readonly bigint[]): CatRaceLeaderboardRow[] {
  return players
    .map((address, index) => ({
      rank: index + 1,
      address,
      won: formatEther(wonTotals[index] ?? 0n),
    }))
    .filter((row) => row.address && row.address !== "0x0000000000000000000000000000000000000000" && Number(row.won) > 0);
}

function catRaceDisplayPhase(catRace: CatRaceState, now: number): CatRaceDisplayPhase {
  if (catRace.phase === "settled") return "finish";
  if (catRace.phase === "prepare" && catRace.previousRaceId > 0 && now - catRace.startedAt < CAT_RACE_FINISH_SECONDS) {
    return "finish";
  }
  return catRace.phase === "race" ? "race" : "prepare";
}

function catRacePhaseRemaining(catRace: CatRaceState, now: number, displayPhase: CatRaceDisplayPhase) {
  if (displayPhase === "finish") {
    if (catRace.phase === "prepare") {
      return Math.max((catRace.startedAt || now) + CAT_RACE_FINISH_SECONDS - now, 0);
    }
    return Math.max((catRace.endsAt || now) + CAT_RACE_FINISH_SECONDS - now, 0);
  }
  if (displayPhase === "prepare") {
    const phaseEnd = Math.min(catRace.bettingEndsAt || now, (catRace.startedAt || now) + CAT_RACE_PREPARE_SECONDS);
    return Math.max(phaseEnd - now, 0);
  }
  if (displayPhase === "race") {
    const phaseEnd = Math.min(catRace.endsAt || now, (catRace.bettingEndsAt || now) + CAT_RACE_RUN_SECONDS);
    return Math.max(phaseEnd - now, 0);
  }
  return 0;
}

function catRaceRaceProgress(catRace: CatRaceState, now: number, displayPhase: CatRaceDisplayPhase) {
  if (displayPhase === "finish") return 1;
  if (catRace.phase === "settled") return 1;
  if (catRace.phase !== "race") return 0;
  const raceStartedAt = catRace.bettingEndsAt || now;
  return Math.min(Math.max((now - raceStartedAt) / CAT_RACE_RUN_SECONDS, 0), 1);
}

function catName(index: number) {
  return ["Neon", "Pixel", "Turbo", "Shadow", "Lucky"][index] ?? `Cat ${index + 1}`;
}

function catGlyph(index: number) {
  return ["🐱", "😺", "😸", "😼", "😻"][index] ?? "🐱";
}

function catColor(index: number) {
  return ["#34e4f4", "#39f29a", "#ffd166", "#ff4dce", "#f4fbff"][index] ?? "#34e4f4";
}

function catAccent(index: number) {
  return ["#9af8ff", "#b3ffd8", "#fff0ad", "#ffb2ed", "#34e4f4"][index] ?? "#9af8ff";
}

function buildDemoCatRace(now: number, address: string): CatRaceState {
  const cycle = CAT_RACE_PREPARE_SECONDS + CAT_RACE_RUN_SECONDS + CAT_RACE_FINISH_SECONDS;
  const base = Math.floor(now / cycle) * cycle;
  const elapsed = now - base;
  const raceId = Math.floor(now / cycle) + 1;
  const phase: CatRacePhase = elapsed < CAT_RACE_PREPARE_SECONDS
    ? "prepare"
    : elapsed < CAT_RACE_PREPARE_SECONDS + CAT_RACE_RUN_SECONDS
      ? "race"
      : "settled";
  const winnerCat = (raceId * 7 + 2) % 5;
  const previousWinnerCat = ((raceId - 1) * 7 + 2) % 5;
  const totalBets = [0, 1, 2, 3, 4].map((cat) => {
    const amount = 12 + ((raceId + cat * 3) % 9) * 1.35 + (elapsed < 30 ? elapsed * (cat + 1) * 0.015 : 0);
    return amount.toFixed(4);
  });
  const playerBets = address
    ? ["0.1", "0", "0.25", "0", "0"]
    : ["0", "0", "0", "0", "0"];
  const previousPlayerBets = ["0", "0.2", "0", "0", "0.15"];
  return {
    raceId,
    phase,
    startedAt: base,
    bettingEndsAt: base + CAT_RACE_PREPARE_SECONDS,
    endsAt: base + CAT_RACE_PREPARE_SECONDS + CAT_RACE_RUN_SECONDS,
    winnerCat,
    totalBets,
    playerBets,
    previousRaceId: raceId - 1,
    previousWinnerCat,
    previousPlayerBets,
    previousClaimed: false,
    leaderboard: [
      { rank: 1, address: "0x91aA11111111111111111111111111111111BEEF", won: "42.75" },
      { rank: 2, address: "0x72bB22222222222222222222222222222222CAFE", won: "31.5" },
      { rank: 3, address: "0x83cC33333333333333333333333333333333F00D", won: "18.25" },
      { rank: 4, address: "0x64dD44444444444444444444444444444444D00D", won: "12.1" },
    ],
  };
}

function catMotion(cat: number, progress: number, winnerCat: number, phase: CatRacePhase, now: number) {
  if (phase === "prepare") {
    return { position: 11, speed: 0, bob: 0 };
  }
  const winner = cat === winnerCat;
  const seed = (cat + 1) * 17;
  const wave = Math.sin(progress * 18 + seed + now * 0.01) * 3.2;
  const drift = Math.sin(progress * 9 + seed * 0.4) * 2.1;
  const fieldPosition = 18 + progress * 48 + wave + drift;
  const lateSprint = Math.min(Math.max((progress - 0.9) / 0.1, 0), 1);
  const finishPosition = winner ? 95 : 75 + ((cat * 4 + 3) % 13);
  const finalPush = winner
    ? Math.pow(lateSprint, 3) * 27
    : -Math.pow(lateSprint, 2) * (5 + ((cat + 1) % 4) * 2);
  const rawPosition = fieldPosition + finalPush;
  const position = progress >= 0.985 ? finishPosition : Math.min(Math.max(rawPosition, 11), finishPosition);
  const runPulse = Math.sin(now * 0.018 + cat * 1.7) * 4;
  const speed = Math.max(Math.round(38 + progress * 18 + wave * 1.2 + runPulse + (winner ? lateSprint * 18 : 0)), 14);
  return { position, speed, bob: Math.sin(now * 0.012 + cat) * 4 };
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
  const betWei = parseEther(round.betAmount || "0");
  const displayPayout = status === "win" ? formatEther(betWei * 2n) : status === "draw" ? formatEther(betWei) : "0";

  return {
    game,
    status,
    betAmount: round.betAmount,
    playerMove: round.playerMove,
    outcome: round.outcome,
    payout: displayPayout,
    actualPayout: round.payout,
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

function parseCatRaceSettlement(contract: Contract, logs: readonly { topics: readonly string[]; data: string }[]) {
  for (const log of logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: Array.from(log.topics), data: log.data });
      if (parsed?.name !== "CatRaceSettled") {
        continue;
      }
      return {
        raceId: Number(parsed.args.raceId),
        winnerCat: Number(parsed.args.winnerCat),
        payout: formatEther(parsed.args.payout),
      };
    } catch {
      continue;
    }
  }
  throw new Error("Cat Race settlement confirmed but result was not found.");
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

function subtractRoundCost(balance: string, bet: string, entryFeeBps: number) {
  try {
    const betWei = parseEther(bet || "0");
    const entryFeeWei = (betWei * BigInt(entryFeeBps)) / 10_000n;
    const balanceWei = parseEther(balance || "0");
    const nextBalance = balanceWei > betWei + entryFeeWei ? balanceWei - betWei - entryFeeWei : 0n;
    return formatEther(nextBalance);
  } catch {
    return balance;
  }
}

function addEtherStrings(a: string, b: string) {
  try {
    return formatEther(parseEther(a || "0") + parseEther(b || "0"));
  } catch {
    return a;
  }
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

function formatDateTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
