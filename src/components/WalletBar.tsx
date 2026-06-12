import { CircleDollarSign, LogOut, PlugZap, RefreshCcw, Settings, ShieldAlert, Wallet } from "lucide-react";
import { WalletState } from "../lib/wallet";
import { GAME_CONTRACT_ADDRESS, SIMPLE_CHAIN_ID, shortAddress } from "../lib/simpleChain";

type WalletBarProps = {
  wallet: WalletState;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onAdmin: () => void;
  isAdmin: boolean;
  busy: boolean;
};

export function WalletBar({ wallet, isAdmin, onConnect, onDisconnect, onRefresh, onAdmin, busy }: WalletBarProps) {
  const connected = Boolean(wallet.address);

  return (
    <header className="topbar">
      <div className="network-pill">
        <CircleDollarSign size={17} />
        <span>Simple Chain</span>
        <strong>SRW</strong>
      </div>
      <div className="topbar-actions-shell">
        <div className="topbar-actions">
          {isAdmin && (
            <button className="icon-button" onClick={onAdmin} title="Admin settings" type="button">
              <Settings size={18} />
            </button>
          )}
          <button className="icon-button" disabled={!connected || busy} onClick={onRefresh} title="Refresh wallet" type="button">
            <RefreshCcw size={18} />
          </button>
          {connected && (
            <button className="icon-button icon-button--danger" disabled={busy} onClick={onDisconnect} title="Log out wallet" type="button">
              <LogOut size={18} />
            </button>
          )}
          <button className="wallet-button" disabled={busy} onClick={onConnect} type="button">
            {connected ? <Wallet size={18} /> : <PlugZap size={18} />}
            <span>{connected ? shortAddress(wallet.address) : "Connect Wallet"}</span>
            {connected && <b>{Number(wallet.balance).toFixed(3)} SRW</b>}
          </button>
        </div>
        <div className="wallet-safety-warning">
          <ShieldAlert size={21} />
          <span>
            <b>Security notice</b>
            Do not use your main wallet. Use a separate play wallet with limited SRW.
          </span>
        </div>
      </div>
      <div className="config-strip">
        <span>Chain ID {SIMPLE_CHAIN_ID}</span>
        <span>{GAME_CONTRACT_ADDRESS ? shortAddress(GAME_CONTRACT_ADDRESS) : "Contract not configured"}</span>
      </div>
    </header>
  );
}
