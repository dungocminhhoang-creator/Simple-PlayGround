import { CircleDollarSign, PlugZap, RefreshCcw, Settings, Wallet } from "lucide-react";
import { WalletState } from "../lib/wallet";
import { GAME_CONTRACT_ADDRESS, SIMPLE_CHAIN_ID, shortAddress } from "../lib/simpleChain";

type WalletBarProps = {
  wallet: WalletState;
  onConnect: () => void;
  onRefresh: () => void;
  onAdmin: () => void;
  isAdmin: boolean;
  relayerOnline: boolean;
  busy: boolean;
};

export function WalletBar({ wallet, isAdmin, relayerOnline, onConnect, onRefresh, onAdmin, busy }: WalletBarProps) {
  const connected = Boolean(wallet.address);

  return (
    <header className="topbar">
      <div className="network-pill">
        <CircleDollarSign size={17} />
        <span>Simple Chain</span>
        <strong>SRW</strong>
      </div>
      <div className="topbar-actions">
        {isAdmin && (
          <button className="icon-button" onClick={onAdmin} title="Admin settings" type="button">
            <Settings size={18} />
          </button>
        )}
        <button className="icon-button" disabled={!connected || busy} onClick={onRefresh} title="Refresh wallet" type="button">
          <RefreshCcw size={18} />
        </button>
        <button className="wallet-button" disabled={busy} onClick={onConnect} type="button">
          {connected ? <Wallet size={18} /> : <PlugZap size={18} />}
          <span>{connected ? shortAddress(wallet.address) : "Connect Wallet"}</span>
          {connected && <b>{Number(wallet.balance).toFixed(3)} SRW</b>}
        </button>
      </div>
      <div className="config-strip">
        <span>Chain ID {SIMPLE_CHAIN_ID}</span>
        <span className={relayerOnline ? "relayer-chip relayer-chip--online" : "relayer-chip relayer-chip--offline"}>
          <i />
          {relayerOnline ? "Relayer online" : "Relayer offline"}
        </span>
        <span>{GAME_CONTRACT_ADDRESS ? shortAddress(GAME_CONTRACT_ADDRESS) : "Contract not configured"}</span>
      </div>
    </header>
  );
}
