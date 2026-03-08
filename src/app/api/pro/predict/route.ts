import { NextResponse } from "next/server";

import { ProMatchPredictor } from "@/lib/pro-match-predictor";

interface PredictBody {
  team1?: string;
  team2?: string;
  league?: string;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as PredictBody;

  const team1 = body.team1?.trim();
  const team2 = body.team2?.trim();
  const league = body.league?.trim() ?? "LCK";

  if (!team1 || !team2) {
    return NextResponse.json(
      { error: "team1 and team2 are required." },
      { status: 400 },
    );
  }

  const predictor = new ProMatchPredictor();
  const prediction = await predictor.predictMatch(team1, team2, league);

  return NextResponse.json(prediction);
}