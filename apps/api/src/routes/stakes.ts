import { Router, type Response } from "express";
import { z } from "zod";
import { prisma, Prisma } from "@cryptvest/db";
import { Asset, StakeStatus } from "@cryptvest/shared";
import { audit } from "../lib/audit";
import { requireAdminAuth, type AuthRequest } from "../middleware/auth";

export const stakesRouter = Router();
export const adminStakesRouter = Router();

adminStakesRouter.use(requireAdminAuth);

const createPlanSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["FLEXIBLE", "LOCKED"]),
  termDays: z.number().int().positive().optional(),
  dailyRatePercent: z.number().positive(),
  earlyExitPenaltyPercent: z.number().min(0).max(100).optional(),
});

const updatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["FLEXIBLE", "LOCKED"]).optional(),
  termDays: z.number().int().positive().nullable().optional(),
  dailyRatePercent: z.number().positive().optional(),
  earlyExitPenaltyPercent: z.number().min(0).max(100).nullable().optional(),
  active: z.boolean().optional(),
});

const stakeSchema = z.object({
  stakePlanId: z.string().uuid(),
  asset: z.nativeEnum(Asset),
  amount: z.number().positive(),
});

const adminStakeSchema = stakeSchema.extend({
  email: z.string().email(),
  reason: z.string().optional(),
});

async function createStakeForUser(
  tx: Prisma.TransactionClient,
  userId: string,
  stakePlanId: string,
  asset: Asset,
  amount: number,
  sourceType: string,
  sourceId?: string,
) {
  const plan = await tx.stakePlan.findUnique({ where: { id: stakePlanId } });
  if (!plan || !plan.active) {
    throw new Error("Stake plan not found or inactive");
  }

  const balance = await tx.userBalance.findUnique({
    where: { userId_asset: { userId, asset } },
  });

  if (!balance || Number(balance.available) < amount) {
    throw new Error("Insufficient available balance");
  }

  const maturityDate = plan.termDays
    ? new Date(Date.now() + plan.termDays * 24 * 60 * 60 * 1000)
    : null;

  await tx.userBalance.update({
    where: { userId_asset: { userId, asset } },
    data: {
      available: { decrement: amount },
      staked: { increment: amount },
    },
  });

  await tx.balanceLedgerEntry.create({
    data: {
      userId,
      asset,
      amount,
      entryType: "DEBIT",
      sourceType,
      sourceId,
    },
  });

  return tx.stake.create({
    data: {
      userId,
      stakePlanId,
      principal: amount,
      asset,
      maturityDate,
    },
  });
}

stakesRouter.get("/plans", async (_req, res: Response) => {
  const plans = await prisma.stakePlan.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });
  return res.json({ plans });
});

stakesRouter.get("/my", async (req: AuthRequest, res: Response) => {
  const stakes = await prisma.stake.findMany({
    where: { userId: req.user!.id },
    include: { stakePlan: true },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ stakes });
});

stakesRouter.post("/", async (req: AuthRequest, res: Response) => {
  const parse = stakeSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { stakePlanId, asset, amount } = parse.data;

  let stake;
  try {
    stake = await prisma.$transaction((tx: Prisma.TransactionClient) =>
      createStakeForUser(
        tx,
        req.user!.id,
        stakePlanId,
        asset,
        amount,
        "STAKE",
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stake failed";
    if (message === "Stake plan not found or inactive") {
      return res.status(404).json({ error: message });
    }
    if (message === "Insufficient available balance") {
      return res.status(400).json({ error: message });
    }
    throw err;
  }

  await audit({
    actorId: req.user!.id,
    action: "STAKE_CREATED",
    targetType: "Stake",
    targetId: stake.id,
    metadata: { stakePlanId, asset, amount },
  });

  return res.status(201).json({ stake });
});

stakesRouter.post("/:id/unstake", async (req: AuthRequest, res: Response) => {
  const stake = await prisma.stake.findUnique({
    where: { id: req.params.id },
    include: { stakePlan: true },
  });

  if (!stake || stake.userId !== req.user!.id) {
    return res.status(404).json({ error: "Stake not found" });
  }
  if (stake.status !== StakeStatus.ACTIVE) {
    return res.status(409).json({ error: "Stake is not active" });
  }

  const now = new Date();
  const isEarly = stake.maturityDate !== null && now < stake.maturityDate;
  const penaltyRate = isEarly && stake.stakePlan.earlyExitPenaltyPercent
    ? Number(stake.stakePlan.earlyExitPenaltyPercent) / 100
    : 0;

  const principal = Number(stake.principal);
  const earnings = Number(stake.accruedEarnings);
  const penalty = principal * penaltyRate;
  const returnAmount = principal - penalty + earnings;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.stake.update({
      where: { id: stake.id },
      data: { status: StakeStatus.WITHDRAWN, updatedAt: now },
    });

    await tx.userBalance.update({
      where: { userId_asset: { userId: req.user!.id, asset: stake.asset } },
      data: {
        staked: { decrement: principal },
        available: { increment: returnAmount },
      },
    });

    await tx.balanceLedgerEntry.create({
      data: {
        userId: req.user!.id,
        asset: stake.asset,
        amount: returnAmount,
        entryType: "CREDIT",
        sourceType: "STAKE_RETURN",
        sourceId: stake.id,
      },
    });
  });

  await audit({
    actorId: req.user!.id,
    action: "STAKE_UNSTAKED",
    targetType: "Stake",
    targetId: stake.id,
    metadata: { isEarly, penalty, returnAmount },
  });

  return res.json({ success: true, returnAmount, penalty });
});

adminStakesRouter.get("/plans", async (_req, res: Response) => {
  const plans = await prisma.stakePlan.findMany({ orderBy: { createdAt: "asc" } });
  return res.json({ plans });
});

adminStakesRouter.post(
  "/users",
  async (req: AuthRequest, res: Response) => {
    const parse = adminStakeSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const { email, stakePlanId, asset, amount, reason } = parse.data;
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    try {
      const stake = await prisma.$transaction((tx: Prisma.TransactionClient) =>
        createStakeForUser(
          tx,
          user.id,
          stakePlanId,
          asset,
          amount,
          "ADMIN_STAKE",
          req.user?.id,
        ),
      );

      await audit({
        actorId: req.user?.id,
        action: "ADMIN_STAKE_CREATED",
        targetType: "Stake",
        targetId: stake.id,
        metadata: { userId: user.id, email, stakePlanId, asset, amount, reason },
      });

      return res.status(201).json({ stake });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stake";
      if (
        message === "Insufficient available balance" ||
        message === "Stake plan not found or inactive"
      ) {
        return res.status(400).json({ error: message });
      }
      throw err;
    }
  },
);

adminStakesRouter.post("/plans", async (req: AuthRequest, res: Response) => {
  const parse = createPlanSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const plan = await prisma.stakePlan.create({ data: parse.data });

  await audit({
    actorId: req.user?.id,
    action: "STAKE_PLAN_CREATED",
    targetType: "StakePlan",
    targetId: plan.id,
    metadata: parse.data as Record<string, unknown>,
  });

  return res.status(201).json({ plan });
});

adminStakesRouter.post("/plans/:id", async (req: AuthRequest, res: Response) => {
  return adminUpdatePlan(req, res);
});

adminStakesRouter.patch("/plans/:id", async (req: AuthRequest, res: Response) => {
  return adminUpdatePlan(req, res);
});

async function adminUpdatePlan(req: AuthRequest, res: Response) {
  const parse = updatePlanSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const plan = await prisma.stakePlan.findUnique({ where: { id: req.params.id } });
  if (!plan) return res.status(404).json({ error: "Plan not found" });

  const updated = await prisma.stakePlan.update({
    where: { id: plan.id },
    data: parse.data,
  });

  await audit({
    actorId: req.user?.id,
    action: "STAKE_PLAN_UPDATED",
    targetType: "StakePlan",
    targetId: plan.id,
    metadata: parse.data as Record<string, unknown>,
  });

  return res.json({ plan: updated });
}
