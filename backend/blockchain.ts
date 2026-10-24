import { Contract, Interface, JsonRpcProvider, getAddress, isAddress, keccak256, parseEther } from "ethers";

const escrowAbi = [
  "function createRental(string equipmentId,string equipmentName,address renter,uint256 rentalFee,uint256 deposit,uint256 startTime,uint256 endTime) returns (uint256 rentalId)",
  "function getRental(uint256 rentalId) view returns (tuple(uint256 id,string equipmentId,string equipmentName,address owner,address renter,uint256 rentalFee,uint256 deposit,uint256 startTime,uint256 endTime,uint8 status))",
  "event RentalCreated(uint256 indexed rentalId,address indexed owner,address indexed renter)",
];

export type ExpectedRental = {
  bookingId: number;
  rentalId: string;
  transactionHash: string;
  chainId: number;
  contractAddress: string;
  ownerAddress: string;
  renterAddress: string;
  equipmentId: string;
  equipmentName: string;
  rentalFee: string;
  deposit: string;
  startTime: string;
  endTime: string;
};

export type VerifiedRental = {
  rentalId: string;
  transactionHash: string;
  chainId: number;
  blockNumber: number;
  blockHash: string;
  eventName: "RentalCreated";
};

export type OnchainRentalStatus = "CREATED" | "FUNDED" | "ACTIVE" | "RETURNED" | "REFUNDED" | "DISPUTED" | "RESOLVED";

export type OnchainRentalSnapshot = {
  rentalId: string;
  status: OnchainRentalStatus;
  blockNumber: number;
  blockHash: string;
};

export type RentalVerifier = (expected: ExpectedRental) => Promise<VerifiedRental>;

export type BlockchainProvider = {
  getNetwork: () => Promise<{ chainId: bigint }>;
  getTransaction: (transactionHash: string) => Promise<{ to: string | null; from: string | null; data: string; value: bigint } | null>;
  getTransactionReceipt: (transactionHash: string) => Promise<{ status: number | null; blockNumber: number; blockHash: string | null; logs: readonly { address: string; topics: readonly string[]; data: string }[] } | null>;
  getBlockNumber: () => Promise<number>;
  getBlock: (blockNumber: number) => Promise<{ hash: string | null } | null>;
  getCode: (address: string) => Promise<string>;
};

export type ContractInspectionStatus = "NOT_CONFIGURED" | "INVALID_ADDRESS" | "RPC_UNAVAILABLE" | "WRONG_CHAIN" | "MISSING_BYTECODE" | "BYTECODE_MISMATCH" | "OK";

export type ContractInspection = {
  status: ContractInspectionStatus;
  expectedChainId: number;
  actualChainId: number | null;
  address: string | null;
  latestBlock: number | null;
  bytecodePresent: boolean;
  bytecodeBytes: number;
  bytecodeHash: string | null;
  expectedBytecodeHash: string | null;
  message: string;
};

export type BlockchainProviderFactory = (rpcUrl: string) => BlockchainProvider;

function requiredAddress(value: string, name: string): string {
  if (!isAddress(value)) throw new Error(`${name}_invalid`);
  return getAddress(value);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function createRentalVerifier(options: { rpcUrl?: string; chainId?: number; contractAddress?: string; providerFactory?: BlockchainProviderFactory } = {}): RentalVerifier {
  const rpcUrl = options.rpcUrl || process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
  const expectedChainId = options.chainId || Number(process.env.BLOCKCHAIN_CHAIN_ID || 31337);
  const configuredAddress = options.contractAddress || process.env.RENTAL_ESCROW_ADDRESS || "";
  const timeoutMs = Math.max(1000, Number(process.env.BLOCKCHAIN_RPC_TIMEOUT_MS || 10000));
  const providerFactory: BlockchainProviderFactory = options.providerFactory || ((url) => new JsonRpcProvider(url) as unknown as BlockchainProvider);
  return async (expected) => {
    return withTimeout(async () => {
      if (!configuredAddress) throw new Error("blockchain_not_configured");
      const contractAddress = requiredAddress(configuredAddress, "contract_address");
      if (expected.chainId !== expectedChainId) throw new Error("wrong_chain");
      if (!/^0x[a-fA-F0-9]{64}$/.test(expected.transactionHash)) throw new Error("invalid_transaction_hash");
       const provider = providerFactory(rpcUrl);
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(expectedChainId)) throw new Error("wrong_chain");
      const transaction = await provider.getTransaction(expected.transactionHash);
      if (!transaction) throw new Error("transaction_not_found");
      if (!transaction.to || !sameAddress(transaction.to, contractAddress)) throw new Error("wrong_contract");
      const receipt = await provider.getTransactionReceipt(expected.transactionHash);
      if (!receipt) throw new Error("receipt_not_found");
      if (receipt.status !== 1) throw new Error("transaction_reverted");
      const confirmations = Number(process.env.BLOCKCHAIN_CONFIRMATIONS || 2);
      const latestBlock = await provider.getBlockNumber();
      if (latestBlock < receipt.blockNumber + confirmations - 1) throw new Error("insufficient_confirmations");
      const canonicalBlock = await provider.getBlock(receipt.blockNumber);
       if (!canonicalBlock || !receipt.blockHash || canonicalBlock.hash !== receipt.blockHash) throw new Error("transaction_reorged");
      if (!transaction.from || !sameAddress(transaction.from, expected.ownerAddress)) throw new Error("unexpected_transaction_sender");

      const iface = new Interface(escrowAbi);
      let decoded;
      try {
        decoded = iface.parseTransaction({ data: transaction.data, value: transaction.value });
      } catch {
        throw new Error("unexpected_transaction_call");
      }
      if (!decoded || decoded.name !== "createRental") throw new Error("unexpected_transaction_call");
      const [equipmentId, equipmentName, renter, rentalFee, deposit, startTime, endTime] = decoded.args;
      if (String(equipmentId) !== expected.equipmentId || String(equipmentName) !== expected.equipmentName) throw new Error("unexpected_equipment");
      if (!sameAddress(String(renter), expected.renterAddress)) throw new Error("unexpected_renter");
      if (BigInt(rentalFee) !== parseEther(expected.rentalFee) || BigInt(deposit) !== parseEther(expected.deposit)) throw new Error("unexpected_amounts");
      if (BigInt(startTime) !== BigInt(Math.floor(new Date(expected.startTime).getTime() / 1000)) || BigInt(endTime) !== BigInt(Math.floor(new Date(expected.endTime).getTime() / 1000))) throw new Error("unexpected_rental_period");
      if (!String(equipmentId).trim()) throw new Error("invalid_equipment");

      const event = receipt.logs.map((log) => {
        if (!log.address || !sameAddress(log.address, contractAddress)) return null;
        try { return iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { return null; }
      }).find((parsed) => parsed?.name === "RentalCreated");
      if (!event) throw new Error("rental_created_event_missing");
      if (String(event.args.rentalId) !== expected.rentalId || !sameAddress(String(event.args.owner), expected.ownerAddress) || !sameAddress(String(event.args.renter), expected.renterAddress)) throw new Error("rental_created_event_mismatch");

       const contract = new Contract(contractAddress, escrowAbi, provider as unknown as JsonRpcProvider);
      const rental = await contract.getRental(expected.rentalId) as { id: bigint; owner: string; renter: string; rentalFee: bigint; deposit: bigint; startTime: bigint; endTime: bigint; status: bigint };
      if (rental.id !== BigInt(expected.rentalId) || !sameAddress(rental.owner, expected.ownerAddress) || !sameAddress(rental.renter, expected.renterAddress) || rental.rentalFee !== parseEther(expected.rentalFee) || rental.deposit !== parseEther(expected.deposit) || rental.startTime !== BigInt(Math.floor(new Date(expected.startTime).getTime() / 1000)) || rental.endTime !== BigInt(Math.floor(new Date(expected.endTime).getTime() / 1000)) || rental.status !== 0n) throw new Error("rental_state_mismatch");
       return { rentalId: expected.rentalId, transactionHash: expected.transactionHash, chainId: expectedChainId, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, eventName: "RentalCreated" };
    }, timeoutMs);
  };
}

export async function readRentalSnapshot(expected: ExpectedRental, options: { providerFactory?: BlockchainProviderFactory } = {}): Promise<OnchainRentalSnapshot> {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
  const expectedChainId = Number(process.env.BLOCKCHAIN_CHAIN_ID || 31337);
  const configuredAddress = process.env.RENTAL_ESCROW_ADDRESS || "";
  const timeoutMs = Math.max(1000, Number(process.env.BLOCKCHAIN_RPC_TIMEOUT_MS || 10000));
  return withTimeout(async () => {
    if (!configuredAddress) throw new Error("blockchain_not_configured");
    const contractAddress = requiredAddress(configuredAddress, "contract_address");
    if (expected.chainId !== expectedChainId) throw new Error("wrong_chain");
    const provider = options.providerFactory?.(rpcUrl) || new JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(expectedChainId)) throw new Error("wrong_chain");
    const receipt = await provider.getTransactionReceipt(expected.transactionHash);
    if (!receipt) throw new Error("receipt_not_found");
    if (receipt.status !== 1) throw new Error("transaction_reverted");
    const confirmations = Number(process.env.BLOCKCHAIN_CONFIRMATIONS || 2);
    const latestBlock = await provider.getBlockNumber();
    if (latestBlock < receipt.blockNumber + confirmations - 1) throw new Error("insufficient_confirmations");
    const canonicalBlock = await provider.getBlock(receipt.blockNumber);
     if (!canonicalBlock || !receipt.blockHash || canonicalBlock.hash !== receipt.blockHash) throw new Error("transaction_reorged");
    const transaction = await provider.getTransaction(expected.transactionHash);
    if (!transaction) throw new Error("transaction_not_found");
    if (!transaction.to || !sameAddress(transaction.to, contractAddress)) throw new Error("wrong_contract");
    if (!transaction.from || !sameAddress(transaction.from, expected.ownerAddress)) throw new Error("unexpected_transaction_sender");
    const iface = new Interface(escrowAbi);
    let decoded;
    try {
      decoded = iface.parseTransaction({ data: transaction.data, value: transaction.value });
    } catch {
      throw new Error("unexpected_transaction_call");
    }
    if (!decoded || decoded.name !== "createRental") throw new Error("unexpected_transaction_call");
    const [equipmentId, equipmentName, renter, rentalFee, deposit, startSeconds, endSeconds] = decoded.args;
    if (String(equipmentId) !== expected.equipmentId || String(equipmentName) !== expected.equipmentName || !sameAddress(String(renter), expected.renterAddress) || BigInt(rentalFee) !== parseEther(expected.rentalFee) || BigInt(deposit) !== parseEther(expected.deposit) || BigInt(startSeconds) !== BigInt(Math.floor(new Date(expected.startTime).getTime() / 1000)) || BigInt(endSeconds) !== BigInt(Math.floor(new Date(expected.endTime).getTime() / 1000))) throw new Error("rental_state_mismatch");
    const event = receipt.logs.map((log) => {
      if (!log.address || !sameAddress(log.address, contractAddress)) return null;
      try { return iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { return null; }
    }).find((parsed) => parsed?.name === "RentalCreated");
    if (!event || String(event.args.rentalId) !== expected.rentalId || !sameAddress(String(event.args.owner), expected.ownerAddress) || !sameAddress(String(event.args.renter), expected.renterAddress)) throw new Error("rental_created_event_mismatch");
    const contract = new Contract(contractAddress, escrowAbi, provider as unknown as JsonRpcProvider);
    const rental = await contract.getRental(expected.rentalId) as { id: bigint; equipmentId: string; equipmentName: string; owner: string; renter: string; rentalFee: bigint; deposit: bigint; startTime: bigint; endTime: bigint; status: bigint };
    const startTime = BigInt(Math.floor(new Date(expected.startTime).getTime() / 1000));
    const endTime = BigInt(Math.floor(new Date(expected.endTime).getTime() / 1000));
    if (rental.id !== BigInt(expected.rentalId) || rental.equipmentId !== expected.equipmentId || rental.equipmentName !== expected.equipmentName || !sameAddress(rental.owner, expected.ownerAddress) || !sameAddress(rental.renter, expected.renterAddress) || rental.rentalFee !== parseEther(expected.rentalFee) || rental.deposit !== parseEther(expected.deposit) || rental.startTime !== startTime || rental.endTime !== endTime) throw new Error("rental_state_mismatch");
    const statuses: OnchainRentalStatus[] = ["CREATED", "FUNDED", "ACTIVE", "RETURNED", "REFUNDED", "DISPUTED", "RESOLVED"];
    const status = statuses[Number(rental.status)];
    if (!status) throw new Error("rental_state_mismatch");
     if (!receipt.blockHash) throw new Error("transaction_reorged");
     return { rentalId: expected.rentalId, status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
  }, timeoutMs);
}

export async function inspectRentalEscrow(options: {
  rpcUrl?: string;
  chainId?: number;
  contractAddress?: string;
  expectedRuntimeBytecode?: string;
  expectedImmutableReferences?: Record<string, Array<{ start: number; length: number }>>;
  providerFactory?: BlockchainProviderFactory;
} = {}): Promise<ContractInspection> {
  const rpcUrl = options.rpcUrl || process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545";
  const expectedChainId = options.chainId || Number(process.env.BLOCKCHAIN_CHAIN_ID || 31337);
  const configuredAddress = options.contractAddress || process.env.RENTAL_ESCROW_ADDRESS || "";
  const expectedBytecodeHash = options.expectedRuntimeBytecode && options.expectedRuntimeBytecode !== "0x" ? keccak256(options.expectedRuntimeBytecode) : null;
  const empty = (status: ContractInspectionStatus, message: string, address: string | null = null): ContractInspection => ({
    status,
    expectedChainId,
    actualChainId: null,
    address,
    latestBlock: null,
    bytecodePresent: false,
    bytecodeBytes: 0,
    bytecodeHash: null,
    expectedBytecodeHash,
    message,
  });

  if (!configuredAddress) return empty("NOT_CONFIGURED", "RENTAL_ESCROW_ADDRESS is not configured");
  if (!isAddress(configuredAddress)) return empty("INVALID_ADDRESS", "RENTAL_ESCROW_ADDRESS is not a valid address", configuredAddress);
  const address = getAddress(configuredAddress);
  const provider = options.providerFactory?.(rpcUrl) || new JsonRpcProvider(rpcUrl);
  let actualChainId: number;
  let latestBlock: number;
  let bytecode: string;
  try {
    actualChainId = Number((await provider.getNetwork()).chainId);
    latestBlock = await provider.getBlockNumber();
    bytecode = await provider.getCode(address);
  } catch (error) {
    return { ...empty("RPC_UNAVAILABLE", "Unable to inspect the configured chain or contract", address), message: safeErrorMessage(error) };
  }
  if (actualChainId !== expectedChainId) {
    return { ...empty("WRONG_CHAIN", `Configured chain ${expectedChainId} does not match connected chain ${actualChainId}`, address), actualChainId, latestBlock };
  }
  const bytecodePresent = bytecode !== "0x";
  const bytecodeBytes = bytecodePresent ? Math.max(0, (bytecode.length - 2) / 2) : 0;
  const bytecodeHash = bytecodePresent ? keccak256(bytecode) : null;
  if (!bytecodePresent) {
    return { ...empty("MISSING_BYTECODE", "No contract bytecode exists at the configured address", address), actualChainId, latestBlock };
  }
  const normalizedBytecode = normalizeImmutableBytes(bytecode, options.expectedImmutableReferences);
  const normalizedExpectedBytecode = options.expectedRuntimeBytecode ? normalizeImmutableBytes(options.expectedRuntimeBytecode, options.expectedImmutableReferences) : null;
  if (normalizedExpectedBytecode && normalizedBytecode !== normalizedExpectedBytecode) {
    return { status: "BYTECODE_MISMATCH", expectedChainId, actualChainId, address, latestBlock, bytecodePresent, bytecodeBytes, bytecodeHash, expectedBytecodeHash, message: "Bytecode exists, but it does not match the compiled RentalEscrow artifact" };
  }
  return { status: "OK", expectedChainId, actualChainId, address, latestBlock, bytecodePresent, bytecodeBytes, bytecodeHash, expectedBytecodeHash, message: "Configured RentalEscrow bytecode is present on the expected chain; artifact comparison ignores constructor immutables" };
}

function normalizeImmutableBytes(bytecode: string, references: Record<string, Array<{ start: number; length: number }>> | undefined): string {
  if (!references || bytecode === "0x") return bytecode;
  const bytes = bytecode.slice(2).split("");
  for (const ranges of Object.values(references)) {
    for (const range of ranges) {
      const start = range.start * 2;
      const end = start + range.length * 2;
      for (let index = start; index < end && index < bytes.length; index++) bytes[index] = "0";
    }
  }
  return `0x${bytes.join("")}`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown RPC error";
  return message.replace(/https?:\/\/[^\s)]+/g, "<rpc>");
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("rpc_timeout")), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "rpc_timeout") throw error;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
