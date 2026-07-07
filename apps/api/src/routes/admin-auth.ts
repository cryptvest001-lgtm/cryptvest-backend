import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "@cryptvest/db";
import { Role } from "@cryptvest/shared";
import { config } from "../config";

export const adminAuthRouter = Router();

const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

adminAuthRouter.post("/login", async (req, res) => {
  const parse = adminLoginSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { email, password } = parse.data;
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.role !== Role.ADMIN || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtAdminSecret, {
    expiresIn: "1d",
  });

  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  });
});
