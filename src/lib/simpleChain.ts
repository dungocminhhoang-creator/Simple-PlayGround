export const SIMPLE_CHAIN_ID = Number(import.meta.env.VITE_SIMPLE_CHAIN_ID ?? "1913");
export const SIMPLE_CHAIN_HEX = `0x${SIMPLE_CHAIN_ID.toString(16)}`;
export const SIMPLE_RPC_URL = import.meta.env.VITE_SIMPLE_RPC_URL ?? "https://rpc-c.simplechain.com";
export const GAME_CONTRACT_ADDRESS = import.meta.env.VITE_GAME_CONTRACT_ADDRESS ?? "";
export const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? "http://localhost:8787";

export const SIMPLE_CHAIN_PARAMS = {
  chainId: SIMPLE_CHAIN_HEX,
  chainName: "Simple Chain Testnet",
  nativeCurrency: {
    name: "SRW",
    symbol: "SRW",
    decimals: 18,
  },
  rpcUrls: [SIMPLE_RPC_URL],
  blockExplorerUrls: [],
};

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
