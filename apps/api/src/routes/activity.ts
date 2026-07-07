import { Router, type Response } from "express";
import { prisma } from "@cryptvest/db";
import type { AuthRequest } from "../middleware/auth";

export const activityRouter = Router();

activityRouter.get("/", async (req: AuthRequest, res: Response) => {
  const [deposits, withdrawals, stakes, earnings] = await Promise.all([
    prisma.deposit.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.withdrawalRequest.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.stake.findMany({
      where: { userId: req.user!.id },
      include: { stakePlan: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.earningsLedgerEntry.findMany({
      where: { stake: { userId: req.user!.id } },
      orderBy: { date: "desc" },
      take: 20,
    }),
  ]);

  return res.json({ deposits, withdrawals, stakes, earnings });
});
