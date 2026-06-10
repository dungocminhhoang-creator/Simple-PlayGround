import { BrowserProvider, formatEther } from "ethers";
import { SIMPLE_CHAIN_HEX, SIMPLE_CHAIN_PARAMS } from "./simpleChain";

type EvmInjectedProvider = {
  request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
  on?(event: string, callback: (...args: unknown[]) => void): void;
  removeListener?(event: string, callback: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: EvmInjectedProvider & { providers?: EvmInjectedProvider[] };
    okxwallet?: EvmInjectedProvider;
  }
}

export type WalletState = {
  provider: BrowserProvider | null;
  address: string;
  balance: string;
  chainId: string;
};

export function getInjectedProvider(): EvmInjectedProvider | null {
  if (window.okxwallet?.request) {
    return window.okxwallet;
  }

  const providers = window.ethereum?.providers;
  const firstProvider = providers?.find((provider) => provider?.request);
  if (firstProvider) {
    return firstProvider;
  }

  return window.ethereum?.request ? window.ethereum : null;
}

async function waitForInjectedProvider() {
  const existing = getInjectedProvider();
  if (existing) return existing;

  await new Promise((resolve) => window.setTimeout(resolve, 500));
  return getInjectedProvider();
}

export async function ensureSimpleChain(provider = getInjectedProvider()) {
  if (!provider) {
    throw new Error("Install or enable an EVM wallet such as OKX Wallet, MetaMask, or Rabby first.");
  }

  const current = await provider.request<string>({ method: "eth_chainId" });
  if (current?.toLowerCase() === SIMPLE_CHAIN_HEX.toLowerCase()) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SIMPLE_CHAIN_HEX }],
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
    if (code !== 4902) {
      throw error;
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [SIMPLE_CHAIN_PARAMS],
    });
  }
}

export async function connectWallet(): Promise<WalletState> {
  const injectedProvider = await waitForInjectedProvider();
  if (!injectedProvider) {
    throw new Error("Install or enable an EVM wallet such as OKX Wallet, MetaMask, or Rabby first.");
  }

  await ensureSimpleChain(injectedProvider);
  const provider = new BrowserProvider(injectedProvider);
  const [address] = await injectedProvider.request<string[]>({ method: "eth_requestAccounts" });
  const chainId = await injectedProvider.request<string>({ method: "eth_chainId" });
  const balance = formatEther(await provider.getBalance(address));

  return { provider, address, balance, chainId };
}

export async function getAuthorizedWallet(): Promise<WalletState | null> {
  const injectedProvider = await waitForInjectedProvider();
  if (!injectedProvider) {
    return null;
  }

  const accounts = await injectedProvider.request<string[]>({ method: "eth_accounts" });
  const [address] = accounts;
  if (!address) {
    return null;
  }

  await ensureSimpleChain(injectedProvider);
  const provider = new BrowserProvider(injectedProvider);
  const chainId = await injectedProvider.request<string>({ method: "eth_chainId" });
  const balance = formatEther(await provider.getBalance(address));

  return { provider, address, balance, chainId };
}
