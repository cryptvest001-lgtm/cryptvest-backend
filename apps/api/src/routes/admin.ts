import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "@cryptvest/db";
import { Asset, KycStatus, Network, DepositStatus } from "@cryptvest/shared";
import { audit } from "../lib/audit";
import {
  sendKycDecisionEmail,
  sendCustomEmail,
  sendDepositCreditedEmail,
} from "../lib/email";
import { getBtcAddressBalance, getEthProvider } from "../lib/blockchain";
import { ethers } from "ethers";
import { config } from "../config";
import { requireAdminAuth, type AuthRequest } from "../middleware/auth";

const USDT_ABI = ["function balanceOf(address) view returns (uint256)"];

export const adminRouter = Router();
adminRouter.use(requireAdminAuth);

adminRouter.get("/users", async (_req: AuthRequest, res: Response) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
      kycStatus: true,
      emailVerified: true,
      isBanned: true,
      isRestricted: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return res.json({ users });
});

adminRouter.get("/reports", async (_req: AuthRequest, res: Response) => {
  const [
    userCount,
    totalDeposited,
    totalStaked,
    totalWithdrawn,
    pendingWithdrawals,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.deposit.aggregate({
      where: { status: "CONFIRMED" },
      _sum: { amount: true },
    }),
    prisma.userBalance.aggregate({ _sum: { staked: true } }),
    prisma.withdrawalRequest.aggregate({
      where: { status: "PAID" },
      _sum: { amount: true },
    }),
    prisma.withdrawalRequest.count({ where: { status: "PENDING" } }),
  ]);

  return res.json({
    userCount,
    totalDeposited: totalDeposited._sum.amount ?? 0,
    totalStaked: totalStaked._sum.staked ?? 0,
    totalWithdrawn: totalWithdrawn._sum.amount ?? 0,
    pendingWithdrawals,
  });
});

adminRouter.get("/wallets", async (_req: AuthRequest, res: Response) => {
  type AddrRow = { address: string; network: string; userId: string };
  const addresses: AddrRow[] = await prisma.depositAddress.findMany({
    select: { address: true, network: true, userId: true },
  });

  const btcAddresses = addresses.filter(
    (a: AddrRow) => a.network === Network.BTC,
  );
  const ethAddresses = addresses.filter(
    (a: AddrRow) => a.network === Network.ERC20,
  );

  const btcResults = await Promise.all(
    btcAddresses.map(async (a: AddrRow) => {
      const bal = await getBtcAddressBalance(a.address).catch(() => ({
        confirmed: 0n,
        unconfirmed: 0n,
      }));
      return {
        address: a.address,
        network: Network.BTC,
        userId: a.userId,
        confirmedSats: bal.confirmed.toString(),
        unconfirmedSats: bal.unconfirmed.toString(),
        confirmedBtc: (Number(bal.confirmed) / 1e8).toFixed(8),
      };
    }),
  );

  const provider = await getEthProvider();
  const ethResults = await Promise.all(
    ethAddresses.map(async (a: AddrRow) => {
      let ethBal = "0";
      let usdtBal = "0";
      if (provider) {
        const [rawEth, rawUsdt] = await Promise.all([
          provider.getBalance(a.address).catch(() => 0n),
          new ethers.Contract(config.usdtContractAddress, USDT_ABI, provider)
            .balanceOf(a.address)
            .catch(() => 0n),
        ]);
        ethBal = ethers.formatEther(rawEth);
        usdtBal = (Number(rawUsdt) / 1e6).toFixed(6);
      }
      return {
        address: a.address,
        network: Network.ERC20,
        userId: a.userId,
        ethBal,
        usdtBal,
      };
    }),
  );

  return res.json({ btc: btcResults, erc20: ethResults });
});

const kycDecisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
});

adminRouter.get("/kyc/queue", async (req: AuthRequest, res: Response) => {
  const submissions = await prisma.kycSubmission.findMany({
    where: { status: KycStatus.PENDING },
    include: { user: { select: { id: true, email: true, kycStatus: true } } },
    orderBy: { createdAt: "asc" },
  });

  return res.json({ submissions });
});

adminRouter.post(
  "/kyc/:id/decision",
  async (req: AuthRequest, res: Response) => {
    const parse = kycDecisionSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const { status, reason } = parse.data;
    const submissionId = req.params.id;
    const submission = await prisma.kycSubmission.findUnique({
      where: { id: submissionId },
    });
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    if (submission.status !== KycStatus.PENDING) {
      return res.status(409).json({ error: "Submission already decided" });
    }

    const kycStatus =
      status === "APPROVED" ? KycStatus.APPROVED : KycStatus.REJECTED;

    await prisma.$transaction([
      prisma.kycSubmission.update({
        where: { id: submission.id },
        data: {
          status: kycStatus,
          decisionReason: reason,
          reviewedBy: req.user?.id,
          reviewedAt: new Date(),
        },
      }),
      prisma.user.update({
        where: { id: submission.userId },
        data: { kycStatus },
      }),
    ]);

    await audit({
      actorId: req.user?.id,
      action: "KYC_DECISION",
      targetType: "KycSubmission",
      targetId: submission.id,
      metadata: { status, reason },
    });

    const user = await prisma.user.findUnique({
      where: { id: submission.userId },
      select: { email: true },
    });
    if (user) {
      await sendKycDecisionEmail(user.email, status, reason).catch((e) =>
        console.error("[email] kyc decision:", e),
      );
    }

    return res.json({ success: true, status: kycStatus });
  },
);

const userActionSchema = z.object({
  action: z.enum(["BAN", "UNBAN", "RESTRICT", "UNRESTRICT", "DELETE"]),
});

const sendEmailSchema = z.object({
  subject: z.string().min(1),
  message: z.string().min(1),
});

adminRouter.post(
  "/users/:id/action",
  async (req: AuthRequest, res: Response) => {
    const parse = userActionSchema.safeParse(req.body);
    if (!parse.success)
      return res.status(400).json({ error: "Invalid action" });

    const userId = req.params.id;
    const { action } = parse.data;

    if (action === "DELETE") {
      await prisma.user.delete({ where: { id: userId } });
      await audit({
        actorId: req.user?.id,
        action: "USER_DELETED",
        targetType: "User",
        targetId: userId,
      });
      return res.json({ success: true });
    }

    const updateData: any = {};
    if (action === "BAN") updateData.isBanned = true;
    if (action === "UNBAN") updateData.isBanned = false;
    if (action === "RESTRICT") updateData.isRestricted = true;
    if (action === "UNRESTRICT") updateData.isRestricted = false;

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    await audit({
      actorId: req.user?.id,
      action: `USER_${action}`,
      targetType: "User",
      targetId: userId,
    });

    return res.json({ success: true, user });
  },
);

adminRouter.post(
  "/users/:id/send-email",
  async (req: AuthRequest, res: Response) => {
    const parse = sendEmailSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "Invalid input" });

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: "User not found" });

    await sendCustomEmail(user.email, parse.data.subject, parse.data.message);

    await audit({
      actorId: req.user?.id,
      action: "ADMIN_EMAIL_SENT",
      targetType: "User",
      targetId: user.id,
      metadata: { subject: parse.data.subject },
    });

    return res.json({ success: true });
  },
);

// --- Balance Fund / Debit ---

const balanceAdjustSchema = z.object({
  asset: z.nativeEnum(Asset),
  amount: z.number().positive(),
  type: z.enum(["CREDIT", "DEBIT"]),
  reason: z.string().optional(),
});

adminRouter.post(
  "/users/:id/balance",
  async (req: AuthRequest, res: Response) => {
    const parse = balanceAdjustSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "Invalid input" });

    const { asset, amount, type, reason } = parse.data;
    const userId = req.params.id;

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    if (type === "DEBIT") {
      const balance = await prisma.userBalance.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      if (!balance || Number(balance.available) < amount) {
        return res
          .status(400)
          .json({ error: "Insufficient available balance to debit" });
      }
    }

    await prisma.$transaction([
      prisma.userBalance.upsert({
        where: { userId_asset: { userId, asset } },
        create: { userId, asset, available: type === "CREDIT" ? amount : 0 },
        update: {
          available:
            type === "CREDIT" ? { increment: amount } : { decrement: amount },
        },
      }),
      prisma.balanceLedgerEntry.create({
        data: {
          userId,
          asset,
          amount,
          entryType: type === "CREDIT" ? "CREDIT" : "DEBIT",
          sourceType: type === "CREDIT" ? "ADMIN_CREDIT" : "ADMIN_DEBIT",
          sourceId: req.user?.id,
        },
      }),
    ]);

    await audit({
      actorId: req.user?.id,
      action: `ADMIN_BALANCE_${type}`,
      targetType: "User",
      targetId: userId,
      metadata: { asset, amount, reason },
    });

    return res.json({ success: true });
  },
);

// --- Deposit Address Assignment ---

const depositAddressSchema = z.object({
  email: z.string().email(),
  asset: z.nativeEnum(Asset),
  network: z.nativeEnum(Network),
  address: z.string().min(4),
});

adminRouter.post(
  "/deposit-address",
  async (req: AuthRequest, res: Response) => {
    const parse = depositAddressSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "Invalid input" });

    const { email, asset, network, address } = parse.data;

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    const depositAddress = await prisma.depositAddress.upsert({
      where: {
        userId_asset_network: { userId: targetUser.id, asset, network },
      },
      create: { userId: targetUser.id, asset, network, address },
      update: { address },
    });

    await audit({
      actorId: req.user?.id,
      action: "ADMIN_DEPOSIT_ADDRESS_SET",
      targetType: "DepositAddress",
      targetId: depositAddress.id,
      metadata: { email, asset, network, address },
    });

    return res.status(201).json({ depositAddress });
  },
);

// --- Manual Deposits ---

const manualDepositSchema = z.object({
  email: z.string().email(),
  asset: z.nativeEnum(Asset),
  network: z.nativeEnum(Network),
  amount: z.number().positive(),
  txHash: z.string().optional(),
});

adminRouter.get("/deposits", async (req: AuthRequest, res: Response) => {
  const status = req.query.status as string | undefined;
  const where = status ? { status: status as DepositStatus } : {};
  const deposits = await prisma.deposit.findMany({
    where,
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return res.json({ deposits });
});

adminRouter.post(
  "/deposits/manual",
  async (req: AuthRequest, res: Response) => {
    const parse = manualDepositSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "Invalid input" });

    const { email, asset, network, amount, txHash } = parse.data;

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    let depositAddress = await prisma.depositAddress.findUnique({
      where: {
        userId_asset_network: { userId: targetUser.id, asset, network },
      },
    });

    if (!depositAddress) {
      depositAddress = await prisma.depositAddress.create({
        data: {
          userId: targetUser.id,
          asset,
          network,
          address: `ADMIN-MANUAL-${Date.now()}`,
        },
      });
    }

    const deposit = await prisma.deposit.create({
      data: {
        userId: targetUser.id,
        depositAddressId: depositAddress.id,
        asset,
        network,
        amount,
        txHash: txHash ?? `MANUAL-${Date.now()}`,
        confirmations: 1,
        status: DepositStatus.PENDING,
      },
    });

    await audit({
      actorId: req.user?.id,
      action: "DEPOSIT_MANUAL_CREATED",
      targetType: "Deposit",
      targetId: deposit.id,
      metadata: { email, asset, amount },
    });

    return res.status(201).json({ deposit });
  },
);

adminRouter.post(
  "/deposits/:id/confirm",
  async (req: AuthRequest, res: Response) => {
    const deposit = await prisma.deposit.findUnique({
      where: { id: req.params.id },
    });
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });
    if (deposit.status === DepositStatus.CONFIRMED) {
      return res.status(409).json({ error: "Deposit already confirmed" });
    }

    await prisma.$transaction([
      prisma.deposit.update({
        where: { id: deposit.id },
        data: { status: DepositStatus.CONFIRMED, creditedAt: new Date() },
      }),
      prisma.userBalance.upsert({
        where: {
          userId_asset: { userId: deposit.userId, asset: deposit.asset },
        },
        create: {
          userId: deposit.userId,
          asset: deposit.asset,
          available: deposit.amount,
        },
        update: { available: { increment: deposit.amount } },
      }),
      prisma.balanceLedgerEntry.create({
        data: {
          userId: deposit.userId,
          asset: deposit.asset,
          amount: deposit.amount,
          entryType: "CREDIT",
          sourceType: "DEPOSIT_MANUAL_CONFIRM",
          sourceId: deposit.id,
        },
      }),
    ]);

    await audit({
      actorId: req.user?.id,
      action: "DEPOSIT_CONFIRMED",
      targetType: "Deposit",
      targetId: deposit.id,
    });

    const depositUser = await prisma.user.findUnique({
      where: { id: deposit.userId },
      select: { email: true },
    });
    if (depositUser) {
      await sendDepositCreditedEmail(
        depositUser.email,
        Number(deposit.amount),
        deposit.asset,
      ).catch((e) => console.error("[email] manual deposit confirm:", e));
    }

    return res.json({ success: true });
  },
);
