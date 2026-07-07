import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma, Prisma } from "@cryptvest/db";
import { KycStatus, Role } from "@cryptvest/shared";
import { audit } from "../lib/audit";
import type { AuthRequest } from "../middleware/auth";

export const kycRouter = Router();
export const kycWebhookRouter = Router();

const submitSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  documentType: z.enum(["PASSPORT", "DRIVERS_LICENSE", "ID_CARD"]),
  documentNumber: z.string().min(1),
});

const webhookSchema = z.object({
  providerReference: z.string(),
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().optional(),
});

kycRouter.post("/submit", async (req: AuthRequest, res) => {
  if (!req.user || req.user.role !== Role.USER) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parse = submitSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.kycStatus === KycStatus.APPROVED) {
    return res.status(409).json({ error: "KYC already approved" });
  }

  const providerReference = `kyc-${randomBytes(8).toString("hex")}`;
  const submission = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({
      where: { id: user.id },
      data: { kycStatus: KycStatus.PENDING },
    });

    return tx.kycSubmission.create({
      data: {
        userId: user.id,
        status: KycStatus.PENDING,
        providerReference,
        payload: parse.data,
      },
    });
  });

  // In a real integration, this is where the payload is forwarded to the provider.
  await audit({
    actorId: user.id,
    action: "KYC_SUBMIT",
    targetType: "KycSubmission",
    targetId: submission.id,
    metadata: { providerReference },
  });

  return res.status(201).json({
    id: submission.id,
    providerReference: submission.providerReference,
    status: submission.status,
  });
});

kycWebhookRouter.post("/", async (req, res) => {
  const parse = webhookSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { providerReference, status, reason } = parse.data;
  const submission = await prisma.kycSubmission.findUnique({
    where: { providerReference },
  });
  if (!submission) {
    return res.status(404).json({ error: "Submission not found" });
  }

  const kycStatus = status === "APPROVED" ? KycStatus.APPROVED : KycStatus.REJECTED;

  await prisma.$transaction([
    prisma.kycSubmission.update({
      where: { id: submission.id },
      data: { status: kycStatus, decisionReason: reason },
    }),
    prisma.user.update({
      where: { id: submission.userId },
      data: { kycStatus },
    }),
  ]);

  await audit({
    action: "KYC_WEBHOOK",
    targetType: "KycSubmission",
    targetId: submission.id,
    metadata: { providerReference, status, reason },
  });

  return res.json({ success: true });
});

