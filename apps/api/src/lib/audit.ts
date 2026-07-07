import { prisma } from "@cryptvest/db";

export async function audit({
  actorId,
  action,
  targetType,
  targetId,
  metadata,
}: {
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      actorId,
      action,
      targetType,
      targetId,
      metadata: metadata as never,
    },
  });
}
