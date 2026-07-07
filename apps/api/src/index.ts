import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { prisma } from "@cryptvest/db";
import { config } from "./config";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
import { adminAuthRouter } from "./routes/admin-auth";
import { kycRouter, kycWebhookRouter } from "./routes/kyc";
import { adminRouter } from "./routes/admin";
import { depositsRouter } from "./routes/deposits";
import { stakesRouter, adminStakesRouter } from "./routes/stakes";
import { withdrawalsRouter, adminWithdrawalsRouter } from "./routes/withdrawals";
import { activityRouter } from "./routes/activity";
import { requireAuth, requireKyc } from "./middleware/auth";
import { startPollingCrons } from "./lib/polling";
import { startAccrualCron } from "./lib/accrual";

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" }));
app.use(express.json());

app.use("/health", healthRouter);
app.use("/auth", authRouter);
app.use("/admin/auth", adminAuthRouter);
app.use("/kyc/webhook", kycWebhookRouter);
app.use("/kyc", requireAuth, kycRouter);
app.use("/deposits", requireAuth, depositsRouter);
app.use("/stakes", requireAuth, requireKyc, stakesRouter);
app.use("/withdrawals", requireAuth, requireKyc, withdrawalsRouter);
app.use("/activity", requireAuth, activityRouter);
app.use("/admin", adminRouter);
app.use("/admin/stakes", adminStakesRouter);
app.use("/admin/withdrawals", adminWithdrawalsRouter);

startPollingCrons();
startAccrualCron();

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});

async function shutdown() {
  await prisma.$disconnect();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
