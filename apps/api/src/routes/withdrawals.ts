import { Router, type Response } from "express";
import { z } from "zod";
import { prisma, Prisma } from "@cryptvest/db";
import { Asset, WithdrawalStatus, WithdrawalSourceType } from "@cryptvest/shared";
import { audit } from "../lib/audit";
import { sendWithdrawalStatusEmail } from "../lib/email";
import { requireAdminAuth, type AuthRequest } from "../middleware/auth";

export const withdrawalsRouter = Router();
export const adminWithdrawalsRouter = Router();

adminWithdrawalsRouter.use(requireAdminAuth);

const MIN_WITHDRAWAL_AMOUNT = 50000;

const requestSchema = z.object({
  asset: z.nativeEnum(Asset),
  amount: z.number().min(MIN_WITHDRAWAL_AMOUNT),
  sourceType: z.nativeEnum(WithdrawalSourceType),
  destinationAddress: z.string().min(10),
});

const decisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
  txHash: z.string().optional(),
});

withdrawalsRouter.post("/request", async (req: AuthRequest, res: Response) => {
  const parse = requestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { asset, amount, sourceType } = parse.data;
  const userId = req.user!.id;

  const balance = await prisma.userBalance.findUnique({
    where: { userId_asset: { userId, asset } },
  });

  if (!balance) {
    return res.status(400).json({ error: "No balance for this asset" });
  }

  if (sourceType === WithdrawalSourceType.PRINCIPAL) {
    if (Number(balance.available) < amount) {
      return res.status(400).json({ error: "Insufficient available balance" });
    }
  } else {
    const totalEarnings = await prisma.stake.aggregate({
      where: { userId, asset },
      _sum: { accruedEarnings: true },
    });
    const earned = Number(totalEarnings._sum.accruedEarnings ?? 0);
    if (earned < amount) {
      return res.status(400).json({ error: "Insufficient earnings balance" });
    }
  }

  const request = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (sourceType === WithdrawalSourceType.PRINCIPAL) {
      await tx.userBalance.update({
        where: { userId_asset: { userId, asset } },
        data: { available: { decrement: amount } },
      });
    }

    await tx.balanceLedgerEntry.create({
      data: { userId, asset, amount, entryType: "DEBIT", sourceType: "WITHDRAWAL_REQUEST" },
    });

    return tx.withdrawalRequest.create({
      data: { userId, asset, amount, sourceType, status: WithdrawalStatus.PENDING },
    });
  });

  await audit({
    actorId: userId,
    action: "WITHDRAWAL_REQUESTED",
    targetType: "WithdrawalRequest",
    targetId: request.id,
    metadata: { asset, amount, sourceType },
  });

  return res.status(201).json({ request });
});

withdrawalsRouter.get("/my", async (req: AuthRequest, res: Response) => {
  const requests = await prisma.withdrawalRequest.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return res.json({ requests });
});

adminWithdrawalsRouter.get("/", async (_req, res: Response) => {
  const requests = await prisma.withdrawalRequest.findMany({
    where: { status: WithdrawalStatus.PENDING },
    include: { user: { select: { id: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return res.json({ requests });
});

adminWithdrawalsRouter.post("/:id/decision", async (req: AuthRequest, res: Response) => {
  const parse = decisionSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { status, reason, txHash } = parse.data;
  const request = await prisma.withdrawalRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== WithdrawalStatus.PENDING) {
    return res.status(409).json({ error: "Request already decided" });
  }

  const finalStatus = status === "APPROVED" ? WithdrawalStatus.APPROVED : WithdrawalStatus.REJECTED;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.withdrawalRequest.update({
      where: { id: request.id },
      data: {
        status: finalStatus,
        reason,
        txHash: txHash ?? null,
        reviewedBy: req.user?.id,
        reviewedAt: new Date(),
      },
    });

    if (status === "REJECTED") {
      if (request.sourceType === WithdrawalSourceType.PRINCIPAL) {
        await tx.userBalance.update({
          where: { userId_asset: { userId: request.userId, asset: request.asset } },
          data: { available: { increment: Number(request.amount) } },
        });
      }
      await tx.balanceLedgerEntry.create({
        data: {
          userId: request.userId,
          asset: request.asset,
          amount: Number(request.amount),
          entryType: "CREDIT",
          sourceType: "WITHDRAWAL_REFUND",
          sourceId: request.id,
        },
      });
    }
  });

  await audit({
    actorId: req.user?.id,
    action: "WITHDRAWAL_DECISION",
    targetType: "WithdrawalRequest",
    targetId: request.id,
    metadata: { status, reason, txHash },
  });

  const user = await prisma.user.findUnique({ where: { id: request.userId }, select: { email: true } });
  if (user) {
    await sendWithdrawalStatusEmail(
      user.email,
      status as "APPROVED" | "REJECTED",
      Number(request.amount),
      request.asset,
      null,
      reason,
    ).catch((e) => console.error("[email] withdrawal decision:", e));
  }

  return res.json({ success: true, status: finalStatus });
});

adminWithdrawalsRouter.post("/:id/paid", async (req: AuthRequest, res: Response) => {
  const { txHash } = z.object({ txHash: z.string().min(1) }).parse(req.body);

  const request = await prisma.withdrawalRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== WithdrawalStatus.APPROVED) {
    return res.status(409).json({ error: "Request must be approved first" });
  }

  await prisma.withdrawalRequest.update({
    where: { id: request.id },
    data: { status: WithdrawalStatus.PAID, txHash },
  });

  await audit({
    actorId: req.user?.id,
    action: "WITHDRAWAL_PAID",
    targetType: "WithdrawalRequest",
    targetId: request.id,
    metadata: { txHash },
  });

  const user = await prisma.user.findUnique({ where: { id: request.userId }, select: { email: true } });
  if (user) {
    await sendWithdrawalStatusEmail(
      user.email,
      "PAID",
      Number(request.amount),
      request.asset,
      txHash,
    ).catch((e) => console.error("[email] withdrawal paid:", e));
  }

  return res.json({ success: true });
});
