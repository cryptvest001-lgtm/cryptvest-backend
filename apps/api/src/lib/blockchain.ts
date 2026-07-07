import { ethers } from "ethers";
import { config } from "../config";

const BLOCKCYPHER_BASE = "https://api.blockcypher.com/v1";
const USDT_ERC20_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

export async function generateBtcAddress(userId: string): Promise<string> {
  if (!config.blockCypherToken) {
    return `tb1q_mock_${userId.slice(0, 8)}`;
  }
  const res = await fetch(
    `${BLOCKCYPHER_BASE}/${config.blockCypherCoin}/addrs?token=${config.blockCypherToken}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  const data = await res.json() as { address: string };
  return data.address;
}

export async function getBtcAddressBalance(address: string): Promise<{ confirmed: bigint; unconfirmed: bigint }> {
  if (!config.blockCypherToken) {
    return { confirmed: 0n, unconfirmed: 0n };
  }
  const res = await fetch(
    `${BLOCKCYPHER_BASE}/${config.blockCypherCoin}/addrs/${address}/balance?token=${config.blockCypherToken}`
  );
  const data = await res.json() as { balance?: number; unconfirmed_balance?: number };
  return {
    confirmed: BigInt(data.balance ?? 0),
    unconfirmed: BigInt(data.unconfirmed_balance ?? 0),
  };
}

export interface BtcTx {
  hash: string;
  confirmations: number;
  outputs: { addresses: string[]; value: number }[];
}

export async function getBtcAddressTxs(address: string): Promise<BtcTx[]> {
  if (!config.blockCypherToken) return [];
  const res = await fetch(
    `${BLOCKCYPHER_BASE}/${config.blockCypherCoin}/addrs/${address}/full?token=${config.blockCypherToken}&limit=50`
  );
  const data = await res.json() as { txs?: BtcTx[] };
  return data.txs ?? [];
}

export async function getEthProvider(): Promise<ethers.JsonRpcProvider | null> {
  if (!config.ethereumRpcUrl) return null;
  return new ethers.JsonRpcProvider(config.ethereumRpcUrl);
}

export async function generateEthAddress(): Promise<{ address: string; privateKey: string }> {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export interface UsdtTransfer {
  txHash: string;
  from: string;
  to: string;
  amount: bigint;
  blockNumber: number;
}

export async function getUsdtTransfersToAddress(
  address: string,
  fromBlock: number
): Promise<UsdtTransfer[]> {
  const provider = await getEthProvider();
  if (!provider) return [];

  const contract = new ethers.Contract(USDT_ERC20_ADDRESS, ERC20_ABI, provider);
  const filter = contract.filters.Transfer(null, address);
  const events = await contract.queryFilter(filter, fromBlock, "latest");

  return events.map((e) => {
    const log = e as ethers.EventLog;
    return {
      txHash: log.transactionHash,
      from: log.args[0] as string,
      to: log.args[1] as string,
      amount: BigInt(log.args[2].toString()),
      blockNumber: log.blockNumber,
    };
  });
}
