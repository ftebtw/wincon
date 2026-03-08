import type { NextRequest } from "next/server";

const COOKIE_NAME = "wincon_betting_admin";

export function getBettingAdminCookieName(): string {
  return COOKIE_NAME;
}

export function getBettingAdminPassword(): string {
  return process.env.BETTING_ADMIN_PASSWORD ?? "";
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

