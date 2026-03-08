import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";

import { SearchBar } from "@/components/SearchBar";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { HomeLiveBanner } from "@/components/HomeLiveBanner";
import { db, schema } from "@/lib/db";
import type { PBEDiffReport } from "@/lib/pbe-diff-engine";

export const metadata: Metadata = {
  title: {
    absolute: "WinCon.gg - AI-Powered League of Legends Coaching",
  },
  description:
    "Get AI coaching that tells you exactly what went wrong in your League of Legends games and how to fix it. Win probability analysis, pattern detection, and loading screen scouting.",
};

const featureCards = [
  {
    title: "Match Analysis",
    description: "Win probability graphs + AI coaching",
  },
  {
    title: "Pattern Detection",
    description: "Find recurring mistakes across games",
  },
  {
    title: "Loading Screen Scout",
    description: "Know your enemies before the game starts",
  },
];

function parsePBERow(diffReport: unknown): { championChanges: number; itemChanges: number } | null {
  if (!diffReport || typeof diffReport !== "object") {
    return null;
  }

  const report = diffReport as PBEDiffReport;
  if (!Array.isArray(report.championChanges) || !Array.isArray(report.itemChanges)) {
    return null;
  }

  return {
    championChanges: report.championChanges.length,
    itemChanges: report.itemChanges.length,
  };
}

export default async function Home() {
  let pbeBanner: { championChanges: number; itemChanges: number; totalChanges: number } | null =
    null;

  if (process.env.DATABASE_URL) {
    try {
      const rows = await db
        .select({
          diffReport: schema.pbeDiffs.diffReport,
          totalChanges: schema.pbeDiffs.totalChanges,
        })
        .from(schema.pbeDiffs)
        .where(eq(schema.pbeDiffs.isLatest, true))
        .limit(1);
      const parsed = rows[0] ? parsePBERow(rows[0].diffReport) : null;
      if (parsed) {
        pbeBanner = {
          championChanges: parsed.championChanges,
          itemChanges: parsed.itemChanges,
          totalChanges: Number(rows[0]?.totalChanges ?? parsed.championChanges + parsed.itemChanges),
        };
      }
    } catch {
      pbeBanner = null;
    }
  }

  return (
    <div className="min-h-[calc(100vh-9rem)]">
      <HomeLiveBanner />

      {pbeBanner ? (
        <section className="mx-auto w-full max-w-6xl px-4 pt-6">
          <Link
            href="/pbe"
            className="block rounded-lg border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-4 py-3 text-sm text-[#fde68a] transition-colors hover:border-[#f59e0b]/70"
          >
            Upcoming Patch Preview: {pbeBanner.championChanges} champion changes,{" "}
            {pbeBanner.itemChanges} item changes ({pbeBanner.totalChanges} total) detected on PBE
            {" "} -&gt; View Preview
          </Link>
        </section>
      ) : null}

      <section className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 pb-20 pt-24 text-center">
        <h1 className="text-5xl font-semibold tracking-tight text-primary sm:text-6xl">
          WinCon.gg
        </h1>
        <p className="mt-5 max-w-3xl text-base text-muted-foreground sm:text-lg">
          AI-powered coaching that tells you exactly what went wrong - and how to
          fix it
        </p>
        <div className="mt-10 w-full max-w-2xl">
          <SearchBar placeholder="Enter Riot ID (e.g., Player#NA1)" />
          <p className="mt-3 text-sm text-muted-foreground">Try: Faker#KR1</p>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-5 px-4 pb-20 md:grid-cols-3">
        {featureCards.map((feature) => (
          <Card
            key={feature.title}
            className="border-border/70 bg-card/90 transition-colors hover:border-primary/70"
          >
            <CardHeader>
              <CardTitle>{feature.title}</CardTitle>
              <CardDescription>{feature.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>
    </div>
  );
}
