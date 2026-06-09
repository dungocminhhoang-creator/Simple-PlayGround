import { BrowserProvider, formatEther } from "ethers";
import { SIMPLE_CHAIN_HEX, SIMPLE_CHAIN_PARAMS } from "./simpleChain";

declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
      on?(event: string, callback: (...args: unknown[]) => void): void;
      removeListener?(event: string, callback: (...args: unknown[]) => void): void;
    };
  }
}

export type WalletState = {
  provider: BrowserProvider | null;
  address: string;
  balance: string;
  chainId: string;
};

export async function ensureSimpleChain() {
  if (!window.ethereum) {
    throw new Error("Wallet extension not found");
  }

  const current = await window.ethereum.request<string>({ method: "eth_chainId" });
  if (current?.toLowerCase() === SIMPLE_CHAIN_HEX.toLowerCase()) {
    return;
  }

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SIMPLE_CHAIN_HEX }],
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
    if (code !== 4902) {
      throw error;
    }

    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [SIMPLE_CHAIN_PARAMS],
    });
  }
}

export async function connectWallet(): Promise<WalletState> {
  if (!window.ethereum) {
    throw new Error("Install MetaMask, Rabby, or another EVM wallet first.");
  }

  await ensureSimpleChain();
  const provider = new BrowserProvider(window.ethereum);
  const [address] = await window.ethereum.request<string[]>({ method: "eth_requestAccounts" });
  const chainId = await window.ethereum.request<string>({ method: "eth_chainId" });
  const balance = formatEther(await provider.getBalance(address));

  return { provider, address, balance, chainId };
}

export async function getAuthorizedWallet(): Promise<WalletState | null> {
  if (!window.ethereum) {
    return null;
  }

  const accounts = await window.ethereum.request<string[]>({ method: "eth_accounts" });
  const [address] = accounts;
  if (!address) {
    return null;
  }

  await ensureSimpleChain();
  const provider = new BrowserProvider(window.ethereum);
  const chainId = await window.ethereum.request<string>({ method: "eth_chainId" });
  const balance = formatEther(await provider.getBalance(address));

  return { provider, address, balance, chainId };
}
