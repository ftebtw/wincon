import type { NextRequest } from "next/server";

const COOKIE_NAME = "wincon_betting_admin";

export function getBettingAdminCookieName(): string {
  return COOKIE_NAME;
}

export function getBettingAdminPassword(): string {
  const raw = process.env.BETTING_ADMIN_PASSWORD ?? "";
  const trimmed = raw.trim();

  if (trimmed.length >= 2) {
    const startsWithDouble = trimmed.startsWith("\"") && trimmed.endsWith("\"");
    const startsWithSingle = trimmed.startsWith("'") && trimmed.endsWith("'");
    if (startsWithDouble || startsWithSingle) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
}

export function isBettingAccessEnabled(): boolean {
  return getBettingAdminPassword().length > 0;
}

export function isAuthorizedBettingRequest(request: NextRequest | Request): boolean {
  const headerPassword = request.headers.get("x-admin-password");
  if (headerPassword && headerPassword === getBettingAdminPassword()) {
    return true;
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const target = `${COOKIE_NAME}=1`;
  return cookieHeader.split(";").some((chunk) => chunk.trim() === target);
}

