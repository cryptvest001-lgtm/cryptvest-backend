import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "@cryptvest/db";
import { TicketStatus, ChatRole } from "@cryptvest/shared";
import {
  requireAuth,
  requireAdminAuth,
  type AuthRequest,
} from "../middleware/auth";

export const supportRouter = Router();
export const adminSupportRouter = Router();

const ticketSchema = z.object({
  subject: z.string().min(1),
  message: z.string().min(1),
  priority: z.string().optional(),
});

const replySchema = z.object({
  text: z.string().min(1),
});

// --- User Routes ---

supportRouter.use(requireAuth);

supportRouter.get("/tickets", async (req: AuthRequest, res: Response) => {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: req.user!.id },
    orderBy: { updatedAt: "desc" },
  });
  return res.json({ tickets });
});

supportRouter.post("/tickets", async (req: AuthRequest, res: Response) => {
  const parse = ticketSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid input" });

  const ticket = await prisma.supportTicket.create({
    data: {
      userId: req.user!.id,
      subject: parse.data.subject,
      priority: parse.data.priority ?? "LOW",
      messages: {
        create: {
          userId: req.user!.id,
          text: parse.data.message,
        },
      },
    },
  });

  return res.status(201).json({ ticket });
});

supportRouter.get("/tickets/:id", async (req: AuthRequest, res: Response) => {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!ticket || ticket.userId !== req.user!.id) {
    return res.status(404).json({ error: "Ticket not found" });
  }

  return res.json({ ticket });
});

supportRouter.post(
  "/tickets/:id/reply",
  async (req: AuthRequest, res: Response) => {
    const parse = replySchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "Invalid input" });

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
    });
    if (!ticket || ticket.userId !== req.user!.id)
      return res.status(404).json({ error: "Ticket not found" });

    const message = await prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        userId: req.user!.id,
        text: parse.data.text,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: "OPEN", updatedAt: new Date() },
    });

    return res.json({ message });
  },
);

// --- Chat Routes ---

supportRouter.get("/chat", async (req: AuthRequest, res: Response) => {
  const messages = await prisma.chatMessage.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return res.json({ messages });
});

supportRouter.post("/chat", async (req: AuthRequest, res: Response) => {
  const parse = replySchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid input" });

  const message = await prisma.chatMessage.create({
    data: {
      userId: req.user!.id,
      role: "USER",
      text: parse.data.text,
    },
  });

  return res.json({ message });
});

// --- Admin Routes ---

adminSupportRouter.use(requireAdminAuth);

adminSupportRouter.get("/tickets", async (_req: AuthRequest, res: Response) => {
  const tickets = await prisma.supportTicket.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return res.json({ tickets });
});

adminSupportRouter.post(
  "/tickets/:id/reply",
  async (req: AuthRequest, res: Response) => {
    const parse = replySchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "Invalid input" });

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
    });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const message = await prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        userId: req.user!.id,
        text: parse.data.text,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: "PENDING", updatedAt: new Date() },
    });

    return res.json({ message });
  },
);

adminSupportRouter.get(
  "/chat/queues",
  async (_req: AuthRequest, res: Response) => {
    // Get users who have sent messages, ordered by most recent message
    const queues = await prisma.user.findMany({
      where: { chatMessages: { some: {} } },
      select: {
        id: true,
        email: true,
        chatMessages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { lastSeenAt: "desc" },
    });

    return res.json({ queues });
  },
);

adminSupportRouter.get(
  "/chat/:userId",
  async (req: AuthRequest, res: Response) => {
    const messages = await prisma.chatMessage.findMany({
      where: { userId: req.params.userId },
      orderBy: { createdAt: "asc" },
    });

    // Mark as read
    await prisma.chatMessage.updateMany({
      where: { userId: req.params.userId, role: "USER", isRead: false },
      data: { isRead: true },
    });

    return res.json({ messages });
  },
);

adminSupportRouter.post(
  "/chat/:userId",
  async (req: AuthRequest, res: Response) => {
    const parse = replySchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: "Invalid input" });

    const message = await prisma.chatMessage.create({
      data: {
        userId: req.params.userId,
        role: "ADMIN",
        text: parse.data.text,
      },
    });

    return res.json({ message });
  },
);
