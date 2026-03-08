import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MatchupGuideClient } from "@/components/MatchupGuideClient";
import { parseMatchupId } from "@/lib/matchup-id";

type MatchupPageProps = {
  params: Promise<{
    matchupId: string;
  }>;
};

export default async function MatchupGuidePage({ params }: MatchupPageProps) {
  const { matchupId } = await params;
  const parsed = parseMatchupId(matchupId);

  if (!parsed) {
    notFound();
  }

  return <MatchupGuideClient matchupId={matchupId} />;
}

export async function generateMetadata({ params }: MatchupPageProps): Promise<Metadata> {
  const { matchupId } = await params;
  const parsed = parseMatchupId(matchupId);

  if (!parsed) {
    return {
      title: "Matchup Guide - WinCon.gg",
      description: "Lane matchup guide and coaching insights on WinCon.gg.",
    };
  }

  return {
    title: `${parsed.champion} vs ${parsed.enemy} ${parsed.role} Lane Guide - WinCon.gg`,
    description: `${parsed.champion} ${parsed.role} vs ${parsed.enemy} ${parsed.enemyRole} matchup guide with ability trade windows and gameplan tips on WinCon.gg.`,
  };
}
