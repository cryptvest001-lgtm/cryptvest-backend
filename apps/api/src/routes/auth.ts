import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "@cryptvest/db";
import { Role } from "@cryptvest/shared";
import { config } from "../config";
import { sendVerificationEmail } from "../lib/email";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const verifyEmailSchema = z.object({
  token: z.string(),
});

authRouter.post("/register", async (req, res) => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { email, password } = parse.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "Email already in use" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email, passwordHash, role: Role.USER, emailVerified: false },
  });

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.verificationToken.create({
    data: { email, token, expiresAt },
  });

  try {
    await sendVerificationEmail(email, token);
  } catch (err) {
    console.error("Failed to send verification email", err);
  }

  return res.status(201).json({ id: user.id, email: user.email });
});

authRouter.post("/verify-email", async (req, res) => {
  const parse = verifyEmailSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { token } = parse.data;
  const record = await prisma.verificationToken.findUnique({
    where: { token },
  });
  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { email: record.email },
      data: { emailVerified: true },
    }),
    prisma.verificationToken.delete({ where: { token } }),
  ]);

  return res.json({ success: true });
});

authRouter.post("/login", async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { email, password } = parse.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!user.emailVerified) {
    return res.status(403).json({
      error: "Email not verified. Please verify your email before signing in.",
    });
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: "7d",
  });

  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
      kycStatus: user.kycStatus,
    },
  });
});
