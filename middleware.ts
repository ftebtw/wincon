import { NextResponse, type NextRequest } from "next/server";

const BETTING_COOKIE_NAME = "wincon_betting_admin";

function isBettingAccessEnabled(): boolean {
  return (process.env.BETTING_ADMIN_PASSWORD ?? "").length > 0;
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPrivatePage = pathname.startsWith("/private");
  const isPrivateApi = pathname.startsWith("/api/private");

  if (!isBettingAccessEnabled()) {
    if (isPrivateApi) {
      return NextResponse.json({ error: "Private betting is not configured." }, { status: 503 });
    }

    if (isPrivatePage) {
      return NextResponse.redirect(new URL("/", request.url));
    }

    return NextResponse.next();
  }

  if (!isPrivatePage && !isPrivateApi) {
    return NextResponse.next();
  }

  const allowedWithoutCookie =
    pathname === "/private/login" || pathname === "/api/private/auth";

  const hasCookie = request.cookies.get(BETTING_COOKIE_NAME)?.value === "1";

  if (allowedWithoutCookie || hasCookie) {
    return NextResponse.next();
  }

  if (isPrivateApi) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/private/login";
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/private/:path*", "/api/private/:path*"],
};
