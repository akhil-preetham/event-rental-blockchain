import { BrowserProvider, JsonRpcSigner } from "ethers";

type EthereumProvider = NonNullable<Window["ethereum"]>;

function isEthereumProvider(value: Window["ethereum"]): value is EthereumProvider {
  return Boolean(value && typeof value.request === "function");
}

export function requireEthereum(): EthereumProvider {
  if (!isEthereumProvider(window.ethereum)) {
    throw new Error("MetaMask is not installed.");
  }
  return window.ethereum;
}

export async function connectWallet(): Promise<{
  provider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
  chainId: bigint;
}> {
  const ethereum = requireEthereum();
  try {
    await ethereum.request({ method: "eth_requestAccounts" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 4001) throw new Error("wallet_permission_rejected");
    throw error;
  }

  const provider = new BrowserProvider(ethereum);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();

  return {
    provider,
    signer,
    address: await signer.getAddress(),
    chainId: network.chainId,
  };
}

export async function restoreWallet(): Promise<{
  provider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
  chainId: bigint;
} | null> {
  if (!isEthereumProvider(window.ethereum)) return null;
  const ethereum = window.ethereum;
  const accounts = await ethereum.request({ method: "eth_accounts" }) as string[];
  if (!accounts.length) return null;
  const provider = new BrowserProvider(ethereum);
  const signer = await provider.getSigner(accounts[0]);
  const network = await provider.getNetwork();
  return { provider, signer, address: accounts[0], chainId: network.chainId };
}

export async function switchToHardhatLocal(): Promise<void> {
  const ethereum = requireEthereum();
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 4902) {
      await ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x7a69", chainName: "Hardhat Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["http://127.0.0.1:8545"] }] });
      return;
    }
    throw error;
  }
}
