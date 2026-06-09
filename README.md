# Simple Playground

Simple Playground is a Simple Chain gaming dApp for SRW native-token wagers.

## Run

```bash
npm install
npm run dev
```

Run the backend relayer in a second terminal:

```bash
npm run relayer
```

## Configure

Copy `.env.example` to `.env` and set `VITE_GAME_CONTRACT_ADDRESS` after deploying `contracts/SimplePlayground.sol`.

The frontend uses Simple Chain testnet defaults:

- Chain ID: `1913`
- RPC: `https://rpc-c.simplechain.com`
- Native currency: `SRW`

Required production-style relayer settings:

```env
VITE_SIMPLE_CHAIN_ID=1913
VITE_SIMPLE_RPC_URL=https://rpc-c.simplechain.com
VITE_GAME_CONTRACT_ADDRESS=0xYourDeployedContract
VITE_RELAYER_URL=http://localhost:8787
RELAYER_PORT=8787
RELAYER_PRIVATE_KEY=0xYourDedicatedRelayerPrivateKey
```

## Player Flow

The current app uses an internal player balance plus a backend relayer:

1. Player connects an EVM wallet.
2. Player deposits SRW into the contract with `depositPlayer()`.
3. Player signs an EIP-712 relayer session for a limited allowance and 24-hour expiry.
4. Rounds are submitted by the backend relayer, so the wallet does not pop up on every play.
5. Winnings are credited back to the player's internal game balance.
6. Player can withdraw game balance back to their wallet with `withdrawPlayer()`.

Admin pool liquidity is separate from player balances. The owner can only withdraw pool liquidity, not player deposits.

## Relayer Setup

After deploying the latest `contracts/SimplePlayground.sol`:

1. Set `VITE_GAME_CONTRACT_ADDRESS` in `.env`.
2. Set `RELAYER_PRIVATE_KEY` to a dedicated relayer wallet private key.
3. Start `npm run relayer`.
4. Connect the owner wallet in the web app.
5. Open Pool Admin and click `Trust Relayer`.
6. Make sure the relayer wallet has SRW for gas.
7. The relayer commits its first server seed automatically when the first play request arrives.

The relayer uses rolling commit/reveal randomness:

- It reveals the previously committed server seed during a play transaction.
- It commits the next server seed in the same transaction.
- The player also supplies a random player seed per round.

## Contract Notes

The included Solidity contract stores native SRW in the pool, charges configurable entry and win fees, exposes admin settings, verifies player-signed relayer sessions, and uses commit/reveal randomness.

After this relayer upgrade, redeploy `contracts/SimplePlayground.sol`. Older deployed contract addresses are not ABI-compatible with the current frontend.
