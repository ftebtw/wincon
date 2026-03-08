import { NextResponse } from "next/server";

import { AutoBettor, getAutoBettorConfigFromEnv } from "@/lib/betting/auto-bettor";
import { isAuthorizedBettingRequest } from "@/lib/betting/auth";

export async function POST(request: Request) {
  if (!isAuthorizedBettingRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const autoBettor = new AutoBettor(getAutoBettorConfigFromEnv());
  const result = await autoBettor.scan();

  return NextResponse.json(result);
}

