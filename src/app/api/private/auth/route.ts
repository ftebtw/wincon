import { NextResponse } from "next/server";

import {
  getBettingAdminCookieName,
  getBettingAdminPassword,
  isBettingAccessEnabled,
} from "@/lib/betting/auth";

export async function POST(request: Request) {
  if (!isBettingAccessEnabled()) {
    return NextResponse.json(
      { error: "Betting admin password is not configured." },
      { status: 503 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";

  let password = "";
  let nextPath = "/private/betting";

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      password?: string;
      next?: string;
    };
    password = body.password?.trim() ?? "";
    nextPath = body.next?.trim() || nextPath;
  } else {
    const form = await request.formData();
    password = String(form.get("password") ?? "").trim();
    nextPath = String(form.get("next") ?? "").trim() || nextPath;
  }

  if (password !== getBettingAdminPassword()) {
    return NextResponse.json({ error: "Invalid password." }, { status: 401 });
  }

  if (!nextPath.startsWith("/")) {
    nextPath = "/private/betting";
  }

  const response = NextResponse.json({ ok: true, next: nextPath });
  response.cookies.set({
    name: getBettingAdminCookieName(),
    value: "1",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: getBettingAdminCookieName(),
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

