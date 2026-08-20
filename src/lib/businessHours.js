// lib/businessHours.js — working hours helpers for inbox automations

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseTimeToMinutes(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return raw * 60;
  const s = String(raw).trim().toLowerCase();
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (m12) {
    let h = Number(m12[1]);
    const min = Number(m12[2]);
    const ap = m12[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h * 60 + min;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return Number(m24[1]) * 60 + Number(m24[2]);
  const hOnly = s.match(/^(\d{1,2})$/);
  if (hOnly) return Number(hOnly[1]) * 60;
  return null;
}

function slotMatches(slot, day, minutes) {
  const slotDay = slot.day || slot.d;
  if (slotDay !== day) return false;
  const start = parseTimeToMinutes(slot.start ?? slot.startTime ?? slot.from);
  const end = parseTimeToMinutes(slot.end ?? slot.endTime ?? slot.to);
  if (start == null || end == null) return false;
  if (end > start) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function formatWorkingHoursSummary(setting) {
  const slots = Array.isArray(setting?.workingHoursSlots) ? setting.workingHoursSlots : [];
  if (slots.length) {
    const days = [...new Set(slots.map((s) => s.day))];
    const first = slots[0];
    const fmt = (t) => {
      const m = parseTimeToMinutes(t);
      if (m == null) return String(t);
      const h24 = Math.floor(m / 60);
      const min = m % 60;
      const ap = h24 >= 12 ? "pm" : "am";
      const h12 = h24 % 12 || 12;
      return min ? `${h12}:${String(min).padStart(2, "0")}${ap}` : `${h12}${ap}`;
    };
    return `${days.join(", ")} ${fmt(first.start)} to ${fmt(first.end)}`;
  }
  const days = setting?.days || [];
  if (!days.length) return "Not configured";
  const sh = setting.hoursStart ?? 9;
  const eh = setting.hoursEnd ?? 18;
  const fmtH = (h) => {
    const ap = h >= 12 ? "pm" : "am";
    const h12 = h % 12 || 12;
    return `${h12}${ap}`;
  };
  return `${days.join(", ")} ${fmtH(sh)} to ${fmtH(eh)}`;
}

export function isWithinWorkingHours(setting, now = new Date()) {
  if (!setting) return true;
  const day = DAY_NAMES[now.getDay()];
  const minutes = now.getHours() * 60 + now.getMinutes();
  const slots = Array.isArray(setting.workingHoursSlots) ? setting.workingHoursSlots : [];
  if (slots.length) return slots.some((s) => slotMatches(s, day, minutes));
  const days = setting.days || [];
  if (!days.includes(day)) return false;
  const start = (setting.hoursStart ?? 9) * 60;
  const end = (setting.hoursEnd ?? 18) * 60;
  if (end > start) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function defaultWorkingHoursSlots() {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({
    day,
    start: "10:00 am",
    end: "06:00 pm",
  }));
}
