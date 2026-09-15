// data/seed.js — populate Postgres with demo data.  Run:  npm run prisma:seed
import "dotenv/config";
import { prisma } from "../lib/prisma.js";

const now = Date.now();
const min = 60 * 1000;
const hour = 60 * min;
const at = (msAgo) => new Date(now - msAgo);
const colors = ["#25D366", "#128C7E", "#34B7F1", "#7C3AED", "#F59E0B", "#EF4444"];

async function main() {
  console.log("Seeding database…");

  // Clean slate (order matters due to FK).
  await prisma.message.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.template.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.automation.deleteMany();
  await prisma.user.deleteMany();

  await prisma.automation.createMany({
    data: [
      { name: "Welcome greeting", keyword: "hi", matchType: "contains", reply: "Hi! Welcome to Nexwapi. How can we help you today?" },
      { name: "Pricing enquiry", keyword: "price", matchType: "contains", reply: "Thanks for your interest! See our plans: https://nexwapi.com/pricing" },
      { name: "Fallback reply", keyword: "", matchType: "any", reply: "Thanks for your message! Our team will get back to you shortly." },
    ],
  });

  await prisma.user.create({
    data: {
      name: "Aman",
      email: process.env.DEMO_EMAIL || "admin@nexwapi.com",
      company: "Nexwapi",
      role: "Owner",
    },
  });

  const contactSeed = [
    { name: "Riya Sharma", phone: "919812345001", tags: ["lead", "vip"], optedIn: true, createdAt: at(5 * hour) },
    { name: "Arjun Mehta", phone: "919812345002", tags: ["customer"], optedIn: true, createdAt: at(9 * hour) },
    { name: "Sneha Patel", phone: "919812345003", tags: ["lead"], optedIn: true, createdAt: at(26 * hour) },
    { name: "Vikram Singh", phone: "919812345004", tags: ["customer", "vip"], optedIn: true, createdAt: at(2 * 24 * hour) },
    { name: "Neha Gupta", phone: "919812345005", tags: ["support"], optedIn: false, createdAt: at(3 * 24 * hour) },
    { name: "Rahul Verma", phone: "919812345006", tags: ["lead"], optedIn: true, createdAt: at(4 * 24 * hour) },
  ];

  const contacts = [];
  for (let i = 0; i < contactSeed.length; i++) {
    contacts.push(await prisma.contact.create({ data: { ...contactSeed[i], color: colors[i % colors.length] } }));
  }
  const [c1, c2, c3, c4, , c6] = contacts;

  const messages = [
    { contactId: c1.id, direction: "in", type: "text", text: "Hi, is the premium plan available?", status: "read", at: at(42 * min) },
    { contactId: c1.id, direction: "out", type: "text", text: "Hi Riya! Yes, the premium plan is available. Want me to share the details?", status: "read", at: at(38 * min) },
    { contactId: c1.id, direction: "in", type: "text", text: "Yes please 🙏", status: "read", at: at(30 * min) },
    { contactId: c2.id, direction: "in", type: "text", text: "My order hasn't arrived yet.", status: "read", at: at(3 * hour) },
    { contactId: c2.id, direction: "out", type: "text", text: "Sorry about that Arjun, let me check the status for you.", status: "delivered", at: at(2.8 * hour) },
    { contactId: c3.id, direction: "in", type: "text", text: "Do you offer a free trial?", status: "delivered", at: at(50 * min) },
    { contactId: c4.id, direction: "out", type: "template", text: "Your verification code is 4821. It is valid for 10 minutes.", status: "read", at: at(5 * hour) },
    { contactId: c4.id, direction: "in", type: "text", text: "Thanks, received!", status: "read", at: at(4.9 * hour) },
    { contactId: c6.id, direction: "in", type: "text", text: "Interested in a demo this week.", status: "read", at: at(20 * hour) },
  ];
  await prisma.message.createMany({ data: messages });

  await prisma.template.createMany({
    data: [
      { name: "otp_login", category: "Authentication", language: "en", status: "approved", body: "Your verification code is {{1}}. It is valid for 10 minutes.", createdAt: at(12 * 24 * hour) },
      { name: "order_update", category: "Utility", language: "en", status: "approved", body: "Hi {{1}}, your order {{2}} has been {{3}}. Track it anytime here.", createdAt: at(9 * 24 * hour) },
      { name: "welcome_offer", category: "Marketing", language: "en", status: "approved", body: "Welcome to Nexwapi, {{1}}! 🎉 Use code {{2}} for 20% off your first purchase.", createdAt: at(7 * 24 * hour) },
      { name: "appointment_reminder", category: "Utility", language: "en", status: "pending", body: "Reminder: your appointment is on {{1}} at {{2}}. Reply YES to confirm.", createdAt: at(1 * 24 * hour) },
    ],
  });

  await prisma.campaign.createMany({
    data: [
      { name: "Diwali Mega Sale", template: "welcome_offer", audience: "All customers", recipients: 4820, sent: 4820, delivered: 4710, read: 3980, replied: 612, status: "completed", createdAt: at(6 * 24 * hour) },
      { name: "Cart Abandonment Nudge", template: "order_update", audience: "Leads · cart", recipients: 1240, sent: 1240, delivered: 1201, read: 905, replied: 233, status: "completed", createdAt: at(3 * 24 * hour) },
      { name: "Weekend Flash Drop", template: "welcome_offer", audience: "VIP customers", recipients: 860, status: "scheduled", createdAt: at(2 * hour) },
      { name: "Feedback Request", template: "order_update", audience: "Recent buyers", recipients: 2100, sent: 1050, delivered: 1010, read: 640, replied: 88, status: "running", createdAt: at(40 * min) },
    ],
  });

  console.log("✅ Seed complete:", contacts.length, "contacts,", messages.length, "messages.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
