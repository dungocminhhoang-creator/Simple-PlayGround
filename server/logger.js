import { createHash } from "node:crypto";

const styles = {
  time: "\x1b[2m",
  info: "\x1b[36m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[1;31m",
  step: "\x1b[1;34m",
  wallet: "\x1b[95m",
  worker: "\x1b[2m",
  debug: "\x1b[2m",
  reset: "\x1b[0m",
};

const profileColors = ["\x1b[36m", "\x1b[32m", "\x1b[33m", "\x1b[35m", "\x1b[34m", "\x1b[96m", "\x1b[92m", "\x1b[93m", "\x1b[95m", "\x1b[94m"];
const profileColorCache = new Map();

function colorProfile(profileId) {
  if (!profileId) return "";
  if (!profileColorCache.has(profileId)) {
    const digest = createHash("md5").update(profileId).digest("hex");
    const index = Number.parseInt(digest.slice(0, 8), 16) % profileColors.length;
    profileColorCache.set(profileId, profileColors[index]);
  }
  return profileColorCache.get(profileId);
}

function shortWallet(wallet) {
  if (!wallet) return "";
  return wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;
}

export function log(level, message, options = {}) {
  const {
    profileId,
    profileName,
    wallet,
    workerId = "relayer",
    step,
    style = "info",
  } = options;
  const ts = new Date().toISOString();
  const parts = [
    `${styles.time}${ts}${styles.reset}`,
    `${styles[style] ?? styles.info}[${level}]${styles.reset}`,
  ];

  if (workerId) parts.push(`${styles.worker}[T:${workerId}]${styles.reset}`);
  const profileLabel = profileName || profileId;
  if (profileLabel) parts.push(`${colorProfile(String(profileLabel))}[P:${profileLabel}]${styles.reset}`);
  if (wallet) parts.push(`${styles.wallet}[W:${shortWallet(wallet)}]${styles.reset}`);
  if (step) parts.push(`${styles.step}[STEP:${step}]${styles.reset}`);
  parts.push(message);
  process.stdout.write(`${parts.join(" ")}\n`);
}

export function logError(message, options = {}) {
  log("ERROR", message, { ...options, style: "error" });
}
