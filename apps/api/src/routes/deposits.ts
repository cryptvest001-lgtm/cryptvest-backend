import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "@cryptvest/db";
import { Asset, Network } from "@cryptvest/shared";
import { generateBtcAddress, generateEthAddress } from "../lib/blockchain";
import type { AuthRequest } from "../middleware/auth";

export const depositsRouter = Router();

const getAddressSchema = z.object({
  asset: z.nativeEnum(Asset),
  network: z.nativeEnum(Network),
});

depositsRouter.post("/address", async (req: AuthRequest, res: Response) => {
  const parse = getAddressSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { asset, network } = parse.data;

  const validCombos: Record<Asset, Network[]> = {
    [Asset.BTC]: [Network.BTC],
    [Asset.USDT]: [Network.ERC20],
  };
  if (!validCombos[asset].includes(network)) {
    return res.status(400).json({ error: "Unsupported asset/network combination" });
  }

  const existing = await prisma.depositAddress.findUnique({
    where: { userId_asset_network: { userId: req.user!.id, asset, network } },
  });
  if (existing) {
    return res.json({ address: existing.address, asset, network });
  }

  let address: string;
  if (asset === Asset.BTC && network === Network.BTC) {
    address = await generateBtcAddress(req.user!.id);
  } else {
    const eth = await generateEthAddress();
    address = eth.address;
  }

  const record = await prisma.depositAddress.create({
    data: { userId: req.user!.id, asset, network, address },
  });

  return res.json({ address: record.address, asset, network });
});

depositsRouter.get("/addresses", async (req: AuthRequest, res: Response) => {
  const addresses = await prisma.depositAddress.findMany({
    where: { userId: req.user!.id },
  });
  return res.json({ addresses });
});

depositsRouter.get("/history", async (req: AuthRequest, res: Response) => {
  const deposits = await prisma.deposit.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return res.json({ deposits });
});

depositsRouter.get("/balances", async (req: AuthRequest, res: Response) => {
  const balances = await prisma.userBalance.findMany({
    where: { userId: req.user!.id },
  });
  return res.json({ balances });
});
