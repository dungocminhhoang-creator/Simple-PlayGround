import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { Contract, JsonRpcProvider, Wallet, formatEther, getBytes, id, keccak256, parseEther } from "ethers";
import { log, logError } from "./logger.js";

loadDotEnv();

const PORT = Number(process.env.PORT || process.env.RELAYER_PORT || 8787);
const RPC_URL = process.env.VITE_SIMPLE_RPC_URL || "https://rpc-c.simplechain.com";
const CONTRACT_ADDRESS = process.env.VITE_GAME_CONTRACT_ADDRESS || "";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || "";
const STATE_FILE = process.env.RELAYER_STATE_FILE || "server/data/relayer-state.json";

const ABI = [
  "function trustedRelayers(address relayer) view returns (bool)",
  "function playerBalances(address player) view returns (uint256)",
  "function sessionHash(address player, address relayer, uint256 allowance, uint64 expiresAt, uint256 nonce) pure returns (bytes32)",
  "function sessionSpent(bytes32 sessionHash) view returns (uint256)",
  "function serverSeedCommitments(bytes32 serverSeedHash) view returns (bool)",
  "function commitServerSeed(bytes32 serverSeedHash)",
  "function playRelayed((address player,uint8 gameType,uint8 playerMove,uint256 betAmount,bytes32 playerSeed,uint256 sessionAllowance,uint64 sessionExpiresAt,uint256 sessionNonce,bytes sessionSignature,bytes32 serverSeed,bytes32 nextServerSeedHash) play) returns (uint256)",
  "event RoundSettled(uint256 indexed roundId, address indexed player, uint8 gameType, uint256 betAmount, uint8 playerMove, uint8 outcome, uint8 result, uint256 payout)",
  "event RoundRandomness(uint256 indexed roundId, bytes32 indexed playerSeed, bytes32 indexed serverSeedHash)",
];

function loadDotEnv() {
  const envPath = ".env";
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function randomSeed() {
  return `0x${randomBytes(32).toString("hex")}`;
}

function seedHash(seed) {
  return keccak256(getBytes(seed));
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    const firstSeed = randomSeed();
    const state = {
      currentSeed: firstSeed,
      currentSeedHash: seedHash(firstSeed),
      committed: false,
      rounds: 0,
    };
    saveState(state);
    return state;
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function parseRound(contract, receipt) {
  let round = null;
  let randomness = {};
  for (const logEntry of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(logEntry);
      if (parsed?.name === "RoundSettled") {
        round = {
          roundId: parsed.args.roundId.toString(),
          player: parsed.args.player,
          gameType: Number(parsed.args.gameType),
          betAmount: formatEther(parsed.args.betAmount),
          playerMove: Number(parsed.args.playerMove),
          outcome: Number(parsed.args.outcome),
          result: Number(parsed.args.result),
          payout: formatEther(parsed.args.payout),
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        };
      }
      if (parsed?.name === "RoundRandomness") {
        randomness = {
          playerSeed: parsed.args.playerSeed,
          serverSeedHash: parsed.args.serverSeedHash,
        };
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  if (!round) throw new Error("RoundSettled event not found");
  return { ...round, ...randomness };
}

function validatePlayRequest(body) {
  const required = ["player", "gameType", "move", "betAmount", "playerSeed", "sessionAllowance", "sessionExpiresAt", "sessionNonce", "sessionSignature"];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      throw new Error(`Missing ${key}`);
    }
  }
  if (![0, 1].includes(Number(body.gameType))) throw new Error("Invalid gameType");
  if (Number(body.gameType) === 0 && ![0, 1].includes(Number(body.move))) throw new Error("Invalid move");
  if (Number(body.gameType) === 1 && ![0, 1, 2].includes(Number(body.move))) throw new Error("Invalid move");
}

const provider = new JsonRpcProvider(RPC_URL);
const relayer = RELAYER_PRIVATE_KEY ? new Wallet(RELAYER_PRIVATE_KEY, provider) : null;
const contract = relayer && CONTRACT_ADDRESS ? new Contract(CONTRACT_ADDRESS, ABI, relayer) : null;
let state = loadState();
let playQueue = Promise.resolve();

async function ensureCommitted() {
  if (!contract || !relayer) throw new Error("Relayer is not configured");
  const onChainCommitted = await contract.serverSeedCommitments(state.currentSeedHash);
  if (onChainCommitted) {
    if (!state.committed) {
      state = { ...state, committed: true };
      saveState(state);
    }
    return;
  }

  log("STEP", "Committing initial server seed", { wallet: relayer.address, step: "commit_seed", style: "step" });
  const tx = await contract.commitServerSeed(state.currentSeedHash);
  log("INFO", `Commit tx submitted ${tx.hash}`, { wallet: relayer.address, step: "commit_seed" });
  await tx.wait();
  state = { ...state, committed: true };
  saveState(state);
  log("OK", "Initial server seed committed", { wallet: relayer.address, step: "commit_seed", style: "success" });
}

async function handlePlay(body) {
  if (!contract || !relayer) throw new Error("Relayer server is missing VITE_GAME_CONTRACT_ADDRESS or RELAYER_PRIVATE_KEY");
  validatePlayRequest(body);
  await ensureCommitted();

  const nextSeed = randomSeed();
  const nextSeedHash = seedHash(nextSeed);
  const betAmount = parseEther(String(body.betAmount));

  log("STEP", "Submitting relayed play", {
    profileId: body.player,
    wallet: relayer.address,
    step: Number(body.gameType) === 0 ? "coin_flip" : "rps",
    style: "step",
  });

  const tx = await contract.playRelayed({
    player: body.player,
    gameType: Number(body.gameType),
    playerMove: Number(body.move),
    betAmount,
    playerSeed: body.playerSeed,
    sessionAllowance: parseEther(String(body.sessionAllowance)),
    sessionExpiresAt: BigInt(body.sessionExpiresAt),
    sessionNonce: BigInt(body.sessionNonce),
    sessionSignature: body.sessionSignature,
    serverSeed: state.currentSeed,
    nextServerSeedHash: nextSeedHash,
  });

  log("INFO", `Play tx submitted ${tx.hash}`, { profileId: body.player, wallet: relayer.address, step: "submit_play" });
  const receipt = await tx.wait();
  const round = parseRound(contract, receipt);
  const activeSessionHash = await contract.sessionHash(
    body.player,
    relayer.address,
    parseEther(String(body.sessionAllowance)),
    BigInt(body.sessionExpiresAt),
    BigInt(body.sessionNonce),
  );
  const [gameBalance, spent] = await Promise.all([
    contract.playerBalances(body.player, { blockTag: receipt.blockNumber }),
    contract.sessionSpent(activeSessionHash, { blockTag: receipt.blockNumber }),
  ]);

  state = {
    currentSeed: nextSeed,
    currentSeedHash: nextSeedHash,
    committed: true,
    rounds: Number(state.rounds || 0) + 1,
  };
  saveState(state);
  log("OK", `Round ${round.roundId} settled`, { profileId: body.player, wallet: relayer.address, step: "settled", style: "success" });
  return {
    round,
    account: {
      gameBalance: formatEther(gameBalance),
      sessionSpent: formatEther(spent),
    },
  };
}

createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    jsonResponse(res, 204, {});
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/api/health") {
      const relayerAddress = relayer?.address || "";
      const trusted = contract && relayerAddress ? await contract.trustedRelayers(relayerAddress) : false;
      let seedCommitted = contract ? await contract.serverSeedCommitments(state.currentSeedHash) : false;
      let seedCommitError = "";

      if (trusted && !seedCommitted) {
        try {
          await ensureCommitted();
          seedCommitted = contract ? await contract.serverSeedCommitments(state.currentSeedHash) : false;
        } catch (error) {
          seedCommitError = error instanceof Error ? error.message : String(error);
          logError(seedCommitError, { step: "commit_seed_healthcheck", wallet: relayer?.address });
        }
      }

      if (seedCommitted !== state.committed) {
        state = { ...state, committed: seedCommitted };
        saveState(state);
      }
      jsonResponse(res, 200, {
        ok: Boolean(contract && relayer),
        contractAddress: CONTRACT_ADDRESS,
        relayerAddress,
        trusted,
        currentSeedHash: state.currentSeedHash,
        seedCommitted,
        seedCommitError,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/play") {
      const body = await readBody(req);
      const resultPromise = playQueue.then(() => handlePlay(body));
      playQueue = resultPromise.catch(() => {});
      const result = await resultPromise;
      jsonResponse(res, 200, { ok: true, round: result.round, account: result.account });
      return;
    }

    jsonResponse(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(message, { step: req.url || "request", wallet: relayer?.address });
    jsonResponse(res, 500, { ok: false, error: message });
  }
}).listen(PORT, () => {
  log("INFO", "Simple Playground relayer starting", { step: "startup" });
  log("INFO", `RPC=${RPC_URL}`, { step: "startup" });
  log("INFO", `Contract=${CONTRACT_ADDRESS || "missing"}`, { step: "startup" });
  log("INFO", `Relayer=${relayer?.address || "missing"}`, { wallet: relayer?.address, step: "startup" });
  log("INFO", `Port=${PORT}`, { step: "startup" });
  log("INFO", `Seed hash=${state.currentSeedHash} committed=${state.committed}`, { step: "startup" });
});
