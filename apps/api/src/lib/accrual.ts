import cron from "node-cron";
import { prisma, Prisma } from "@cryptvest/db";
import { StakeStatus } from "@cryptvest/shared";
import { audit } from "./audit";

async function runDailyAccrual() {
  const activeStakes = await prisma.stake.findMany({
    where: { status: StakeStatus.ACTIVE },
    include: { stakePlan: true },
  });

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const stake of activeStakes) {
    try {
      const alreadyAccruedToday = await prisma.earningsLedgerEntry.findFirst({
        where: {
          stakeId: stake.id,
          date: { gte: today },
        },
      });
      if (alreadyAccruedToday) continue;

      const dailyRate = Number(stake.stakePlan.dailyRatePercent) / 100;
      const earnings = Number(stake.principal) * dailyRate;

      const now = new Date();
      const isMatured = stake.maturityDate !== null && now >= stake.maturityDate;

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.earningsLedgerEntry.create({
          data: { stakeId: stake.id, date: now, amount: earnings },
        });

        await tx.stake.update({
          where: { id: stake.id },
          data: {
            accruedEarnings: { increment: earnings },
            status: isMatured ? StakeStatus.MATURED : StakeStatus.ACTIVE,
          },
        });

        await tx.balanceLedgerEntry.create({
          data: {
            userId: stake.userId,
            asset: stake.asset,
            amount: earnings,
            entryType: "CREDIT",
            sourceType: "EARNINGS",
            sourceId: stake.id,
          },
        });
      });
    } catch (err) {
      console.error(`Accrual error for stake ${stake.id}:`, err);
    }
  }

  await audit({
    action: "DAILY_ACCRUAL_RUN",
    targetType: "System",
    metadata: { count: activeStakes.length, date: today.toISOString() },
  });

  console.log(`[cron] accrual done for ${activeStakes.length} stakes`);
}

export function startAccrualCron() {
  cron.schedule("0 0 * * *", async () => {
    console.log("[cron] running daily accrual");
    await runDailyAccrual();
  });
}
