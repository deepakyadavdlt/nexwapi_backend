import { prisma } from "./prisma.js";

export async function notify({ audience = "client", companyId = null, userId = null, title, body = "", href = "" }) {
  try {
    if (audience === "admin" && !userId) {
      const admins = await prisma.user.findMany({
        where: { role: { in: ["SUPER_ADMIN"] } },
        select: { id: true },
      });
      if (!admins.length) {
        await prisma.notification.create({ data: { audience: "admin", title, body, href } });
        return;
      }
      await prisma.notification.createMany({
        data: admins.map((a) => ({ audience: "admin", userId: a.id, title, body, href })),
      });
      return;
    }
    await prisma.notification.create({
      data: { audience, companyId, userId, title, body, href },
    });
  } catch (e) {
    console.warn("[notify]", e.message);
  }
}
