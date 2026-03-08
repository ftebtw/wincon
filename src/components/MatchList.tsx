import { MatchCard } from "@/components/MatchCard";
import type { MatchSummary } from "@/lib/types/player";

type MatchListProps = {
  matches: MatchSummary[];
  playerPuuid: string;
};

export function MatchList({ matches, playerPuuid }: MatchListProps) {
  if (matches.length === 0) {
    return <p className="text-sm text-muted-foreground">No matches found.</p>;
  }

  return (
    <div className="space-y-3">
      {matches.map((match) => (
        <MatchCard key={match.matchId} match={match} playerPuuid={playerPuuid} />
      ))}
    </div>
  );
}
