import "dotenv/config";
import { hash } from "bcrypt";
import { Role, KycStatus, StakePlanType } from "@cryptvest/shared";
import { prisma } from "../src/client";

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ?? "admin@cryptvest.example";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "Admin123!";

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log("Admin user already exists");
  } else {
    const user = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await hash(adminPassword, 12),
        emailVerified: true,
        kycStatus: KycStatus.APPROVED,
        role: Role.ADMIN,
      },
    });

    console.log("Created admin user:", user.id);
    console.log("Email:", adminEmail);
    console.log("Password:", adminPassword);
  }

  const stakePlans = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Flexible Starter",
      type: StakePlanType.FLEXIBLE,
      termDays: null,
      dailyRatePercent: 0.35,
      earlyExitPenaltyPercent: null,
      active: true,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Growth Lock",
      type: StakePlanType.LOCKED,
      termDays: 30,
      dailyRatePercent: 0.65,
      earlyExitPenaltyPercent: 3,
      active: true,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Premium Lock",
      type: StakePlanType.LOCKED,
      termDays: 90,
      dailyRatePercent: 0.95,
      earlyExitPenaltyPercent: 5,
      active: true,
    },
  ];

  for (const plan of stakePlans) {
    await prisma.stakePlan.upsert({
      where: { id: plan.id },
      create: plan,
      update: {
        name: plan.name,
        type: plan.type,
        termDays: plan.termDays,
        dailyRatePercent: plan.dailyRatePercent,
        earlyExitPenaltyPercent: plan.earlyExitPenaltyPercent,
        active: plan.active,
      },
    });
  }

  console.log(`Seeded ${stakePlans.length} staking plans`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
