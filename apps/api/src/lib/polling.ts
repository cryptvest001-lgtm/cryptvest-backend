import cron from "node-cron";
import { prisma } from "@cryptvest/db";
import { Asset, Network, DepositStatus } from "@cryptvest/shared";
import { getBtcAddressTxs, getUsdtTransfersToAddress, getEthProvider } from "./blockchain";
import { audit } from "./audit";
import { sendDepositCreditedEmail } from "./email";

const BTC_CONFIRMATIONS_REQUIRED = 1;

async function pollBtc() {
  const addresses = await prisma.depositAddress.findMany({
    where: { network: Network.BTC },
  });

  for (const addr of addresses) {
    try {
      const txs = await getBtcAddressTxs(addr.address);
      for (const tx of txs) {
        const existing = await prisma.deposit.findFirst({ where: { txHash: tx.hash } });
        const satoshis = tx.outputs
          .filter((o) => o.addresses?.includes(addr.address))
          .reduce((sum, o) => sum + o.value, 0);
        if (satoshis <= 0) continue;

        const amountBtc = satoshis / 1e8;

        if (!existing) {
          const deposit = await prisma.deposit.create({
            data: {
              userId: addr.userId,
              depositAddressId: addr.id,
              asset: Asset.BTC,
              network: Network.BTC,
              amount: amountBtc,
              txHash: tx.hash,
              confirmations: tx.confirmations,
              status: tx.confirmations >= BTC_CONFIRMATIONS_REQUIRED ? DepositStatus.CONFIRMED : DepositStatus.PENDING,
            },
          });

          if (tx.confirmations >= BTC_CONFIRMATIONS_REQUIRED) {
            await creditDeposit(deposit.id, addr.userId, Asset.BTC, amountBtc);
          }
        } else if (
          existing.status === DepositStatus.PENDING &&
          tx.confirmations >= BTC_CONFIRMATIONS_REQUIRED
        ) {
          await prisma.deposit.update({
            where: { id: existing.id },
            data: { confirmations: tx.confirmations, status: DepositStatus.CONFIRMED, creditedAt: new Date() },
          });
          await creditDeposit(existing.id, addr.userId, Asset.BTC, amountBtc);
        } else {
          await prisma.deposit.update({
            where: { id: existing.id },
            data: { confirmations: tx.confirmations },
          });
        }
      }
    } catch (err) {
      console.error(`BTC poll error for ${addr.address}:`, err);
    }
  }
}

async function pollUsdt() {
  const provider = await getEthProvider();
  if (!provider) return;

  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 2000);

  const addresses = await prisma.depositAddress.findMany({
    where: { network: Network.ERC20 },
  });

  for (const addr of addresses) {
    try {
      const transfers = await getUsdtTransfersToAddress(addr.address, fromBlock);
      for (const t of transfers) {
        const existing = await prisma.deposit.findFirst({ where: { txHash: t.txHash } });
        if (existing) continue;

        const amountUsdt = Number(t.amount) / 1e6;

        const deposit = await prisma.deposit.create({
          data: {
            userId: addr.userId,
            depositAddressId: addr.id,
            asset: Asset.USDT,
            network: Network.ERC20,
            amount: amountUsdt,
            txHash: t.txHash,
            confirmations: 1,
            status: DepositStatus.CONFIRMED,
            creditedAt: new Date(),
          },
        });

        await creditDeposit(deposit.id, addr.userId, Asset.USDT, amountUsdt);
      }
    } catch (err) {
      console.error(`USDT poll error for ${addr.address}:`, err);
    }
  }
}

async function creditDeposit(
  depositId: string,
  userId: string,
  asset: Asset,
  amount: number
) {
  await prisma.$transaction([
    prisma.userBalance.upsert({
      where: { userId_asset: { userId, asset } },
      create: { userId, asset, available: amount },
      update: { available: { increment: amount } },
    }),
    prisma.balanceLedgerEntry.create({
      data: { userId, asset, amount, entryType: "CREDIT", sourceType: "DEPOSIT", sourceId: depositId },
    }),
    prisma.deposit.update({
      where: { id: depositId },
      data: { creditedAt: new Date(), status: DepositStatus.CONFIRMED },
    }),
  ]);

  await audit({
    action: "DEPOSIT_CREDITED",
    targetType: "Deposit",
    targetId: depositId,
    metadata: { userId, asset, amount: amount.toString() },
  });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (user) {
    await sendDepositCreditedEmail(user.email, amount, asset).catch((e) =>
      console.error("[email] deposit credited:", e)
    );
  }
}

export function startPollingCrons() {
  cron.schedule("*/2 * * * *", async () => {
    console.log("[cron] polling BTC deposits");
    await pollBtc();
  });

  cron.schedule("*/3 * * * *", async () => {
    console.log("[cron] polling USDT deposits");
    await pollUsdt();
  });
}
