import { NextResponse } from "next/server";

import { parseRegion, REGION_COOKIE_NAME } from "@/lib/regions";

type RegionRequestBody = {
  region?: string;
};

export async function POST(request: Request) {
  let payload: RegionRequestBody = {};
  try {
    payload = (await request.json()) as RegionRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const region = parseRegion(payload.region);
  if (!region) {
    return NextResponse.json({ error: "Invalid region." }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true, region });
  response.cookies.set(REGION_COOKIE_NAME, region, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });

  return response;
}
