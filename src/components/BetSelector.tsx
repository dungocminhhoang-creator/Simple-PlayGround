import { ChangeEvent } from "react";

type BetSelectorProps = {
  bet: string;
  setBet: (bet: string) => void;
};

const presets = ["0.1", "1"];

export function BetSelector({ bet, setBet }: BetSelectorProps) {
  const isCustom = !presets.includes(bet);

  function updateCustom(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value.replace(",", ".");
    if (/^\d*\.?\d{0,6}$/.test(next)) {
      setBet(next);
    }
  }

  return (
    <div className="bet-selector">
      <span className="field-label">Bet Amount</span>
      <div className="bet-row">
        {presets.map((value) => (
          <button
            className={bet === value ? "chip chip--active" : "chip"}
            key={value}
            onClick={() => setBet(value)}
            type="button"
          >
            {value} SRW
          </button>
        ))}
        <label className={isCustom ? "custom-bet custom-bet--active" : "custom-bet"}>
          <span>Custom</span>
          <input
            inputMode="decimal"
            min="0"
            onChange={updateCustom}
            placeholder="0.25"
            type="text"
            value={isCustom ? bet : ""}
          />
          <b>SRW</b>
        </label>
      </div>
    </div>
  );
}
