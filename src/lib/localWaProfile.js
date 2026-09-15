import fs from "fs";
import path from "path";

const FILE = path.resolve("data/wa-profiles.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function getLocalWaProfile(companyId) {
  if (!companyId) return {};
  return readAll()[companyId] || {};
}

export function saveLocalWaProfile(companyId, fields) {
  if (!companyId) return {};
  const all = readAll();
  all[companyId] = { ...(all[companyId] || {}), ...fields, updatedAt: Date.now() };
  writeAll(all);
  return all[companyId];
}
