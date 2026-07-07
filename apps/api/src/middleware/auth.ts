import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "@cryptvest/db";
import { Role, KycStatus } from "@cryptvest/shared";
import { config } from "../config";

export interface AuthRequest extends Request {
  user?: { id: string; role: string };
}

function getToken(req: Request) {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as { sub: string; role: string };
    req.user = { id: decoded.sub, role: decoded.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireAdminAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, config.jwtAdminSecret) as { sub: string; role: string };
    if (decoded.role !== Role.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.user = { id: decoded.sub, role: decoded.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid admin token" });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== Role.ADMIN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

export async function requireKyc(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { kycStatus: true },
  });

  if (user?.kycStatus !== KycStatus.APPROVED) {
    return res.status(403).json({ error: "KYC approval required" });
  }

  next();
}
