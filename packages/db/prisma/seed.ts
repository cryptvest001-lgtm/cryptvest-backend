import "dotenv/config";
import { hash } from "bcrypt";
import { Role, KycStatus } from "@cryptvest/shared";
import { prisma } from "../src/client";

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ?? "admin@cryptvest.example";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "Admin123!";

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log("Admin user already exists");
    return;
  }

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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
