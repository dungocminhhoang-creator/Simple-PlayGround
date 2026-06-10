import { AbstractProvider, Contract, parseEther } from "ethers";
import { GAME_CONTRACT_ADDRESS } from "./simpleChain";

export const PLAYGROUND_ABI = [
  "function entryFeeBps() view returns (uint16)",
  "function winFeeBps() view returns (uint16)",
  "function minBet() view returns (uint256)",
  "function maxBet() view returns (uint256)",
  "function owner() view returns (address)",
  "function poolLiquidity() view returns (uint256)",
  "function currentLeaderboardEpoch() view returns (uint256)",
  "function leaderboardEpochDuration() view returns (uint256)",
  "function leaderboardRewardsInfo() view returns (uint256[10] rewards)",
  "function leaderboardEpochInfo(uint256 epoch) view returns (address[10] players, int256[10] scores, uint256[10] playCounts, uint256 startedAt, uint256 endsAt, bool rewardsSettled)",
  "function currentCatRaceId() view returns (uint256)",
  "function catRaceCurrentInfo() view returns (tuple(uint256 raceId,uint8 phase,uint256 startedAt,uint256 bettingEndsAt,uint256 endsAt,uint8 winnerCat,uint256[5] totalBets))",
  "function catRaceRoundInfo(uint256 raceId) view returns (tuple(uint256 raceId,uint8 phase,uint256 startedAt,uint256 bettingEndsAt,uint256 endsAt,uint8 winnerCat,uint256[5] totalBets))",
  "function catRaceLeaderboardInfo() view returns (address[10] players, uint256[10] wonTotals)",
  "function catRacePlayerBets(uint256 raceId, address player, uint8 cat) view returns (uint256)",
  "function catRaceClaimed(uint256 raceId, address player) view returns (bool)",
  "function startCatRace(uint256 raceId) returns (uint8)",
  "function playerBalances(address player) view returns (uint256)",
  "function sessionSpent(bytes32 sessionHash) view returns (uint256)",
  "function trustedRelayers(address relayer) view returns (bool)",
  "function sessionHash(address player, address relayer, uint256 allowance, uint64 expiresAt, uint256 nonce) pure returns (bytes32)",
  "function setTrustedRelayer(address relayer, bool trusted)",
  "function commitServerSeed(bytes32 serverSeedHash)",
  "function playRelayed((address player,uint8 gameType,uint8 playerMove,uint256 betAmount,bytes32 playerSeed,uint256 sessionAllowance,uint64 sessionExpiresAt,uint256 sessionNonce,bytes sessionSignature,bytes32 serverSeed,bytes32 nextServerSeedHash) play) returns (uint256)",
  "function playDirect(uint8 gameType, uint8 playerMove, uint256 betAmount, bytes32 playerSeed) returns (uint256)",
  "function depositPlayer() payable",
  "function withdrawPlayer(uint256 amount)",
  "function setFees(uint16 nextEntryFeeBps, uint16 nextWinFeeBps)",
  "function setBetLimits(uint256 nextMinBet, uint256 nextMaxBet)",
  "function depositPool() payable",
  "function withdrawPool(uint256 amount, address payable to)",
  "function settleLeaderboardRewards(uint256 epoch)",
  "function setLeaderboardRewards(uint256[10] rewards)",
  "function setLeaderboardCycleDays(uint16 cycleDays)",
  "function placeCatRaceBet(uint8 cat, uint256 betAmount) returns (uint256)",
  "function settleCatRaceBet(uint256 raceId) returns (uint256)",
  "event TrustedRelayerUpdated(address indexed relayer, bool trusted)",
  "event ServerSeedCommitted(bytes32 indexed serverSeedHash, address indexed relayer)",
  "event ServerSeedRevealed(bytes32 indexed serverSeedHash, bytes32 indexed nextServerSeedHash, address indexed relayer)",
  "event RoundSettled(uint256 indexed roundId, address indexed player, uint8 gameType, uint256 betAmount, uint8 playerMove, uint8 outcome, uint8 result, uint256 payout)",
  "event RoundRandomness(uint256 indexed roundId, bytes32 indexed playerSeed, bytes32 indexed serverSeedHash)",
  "event LeaderboardUpdated(uint256 indexed epoch, address indexed player, int256 netProfit)",
  "event LeaderboardRewardPaid(uint256 indexed epoch, uint8 rank, address indexed player, uint256 amount)",
  "event LeaderboardRewardsSettled(uint256 indexed epoch, uint256 totalRewards)",
  "event LeaderboardRewardUpdated(uint8 indexed rank, uint256 amount)",
  "event LeaderboardCycleUpdated(uint256 duration)",
  "event CatRaceBetPlaced(uint256 indexed raceId, address indexed player, uint8 indexed cat, uint256 amount)",
  "event CatRaceStarted(uint256 indexed raceId, uint8 indexed winnerCat)",
  "event CatRaceSettled(uint256 indexed raceId, address indexed player, uint8 indexed winnerCat, uint256 payout)"
];

export function getPlaygroundContract(provider: AbstractProvider) {
  if (!GAME_CONTRACT_ADDRESS) {
    throw new Error("Missing VITE_GAME_CONTRACT_ADDRESS");
  }

  return new Contract(GAME_CONTRACT_ADDRESS, PLAYGROUND_ABI, provider);
}

export function getRequiredStake(bet: string, entryFeeBps: number) {
  const betWei = parseEther(bet || "0");
  return betWei + (betWei * BigInt(entryFeeBps)) / 10_000n;
}
