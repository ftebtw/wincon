import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { MatchAnalysisOutput } from "@/lib/types/analysis";
import type { KeyMoment } from "@/lib/win-probability";
import { cn } from "@/lib/utils";

export interface KeyMomentCardProps {
  moment: KeyMoment & { context?: string };
  aiMoment?: MatchAnalysisOutput["key_moments"][number];
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function KeyMomentCard({ moment, aiMoment }: KeyMomentCardProps) {
  const deltaPercent = Math.round(moment.totalDelta * 100);
  const positive = moment.type === "positive";
  const deltaLabel = `${deltaPercent > 0 ? "+" : ""}${deltaPercent}%`;

  return (
    <Card
      id={`moment-${moment.timestamp}`}
      className={cn(
        "border-border/70 bg-card/90 scroll-mt-28 border-l-4",
        positive ? "border-l-[#10b981]" : "border-l-[#ef4444]",
      )}
    >
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge variant="secondary">{formatTimestamp(moment.timestamp)}</Badge>
          <Badge className={cn(positive ? "bg-[#10b981]" : "bg-[#ef4444]")}>{deltaLabel}</Badge>
        </div>
        <p className="text-sm font-semibold text-foreground">{moment.description}</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {moment.context ?? "Context unavailable for this moment."}
        </p>

        {aiMoment ? (
          <div className="space-y-2">
            <div className="rounded-md border border-border/70 bg-background/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                {aiMoment.type === "good_play" ? "Well played" : "Coach Note"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{aiMoment.explanation}</p>
            </div>

            {aiMoment.type === "mistake" && aiMoment.what_to_do_instead ? (
              <div className="rounded-md border border-[#f59e0b]/50 bg-[#f59e0b]/10 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#fbbf24]">
                  Instead, try:
                </p>
                <p className="mt-1 text-sm text-[#fde68a]">{aiMoment.what_to_do_instead}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border/70 bg-background/40 p-3 text-xs text-muted-foreground">
            AI Analysis available with coaching
          </div>
        )}
      </CardContent>
    </Card>
  );
}
