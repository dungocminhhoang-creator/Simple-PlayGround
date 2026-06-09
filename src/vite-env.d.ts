/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIMPLE_CHAIN_ID?: string;
  readonly VITE_SIMPLE_RPC_URL?: string;
  readonly VITE_GAME_CONTRACT_ADDRESS?: string;
  readonly VITE_RELAYER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
