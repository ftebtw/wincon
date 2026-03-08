import {
  Coins,
  Eye,
  Flag,
  Hammer,
  ShieldAlert,
  Skull,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface PatternAlertProps {
  pattern: {
    pattern_name: string;
    frequency: string;
    description: string;
    root_cause: string;
    specific_fix: string;
    priority: "high" | "medium" | "low";
  };
  type: string;
}

function TypeIcon({ type }: { type: string }) {
  const normalized = type.toLowerCase();

  if (normalized.includes("death")) {
    return <Skull className="size-4 text-primary" />;
  }
  if (normalized.includes("vision")) {
    return <Eye className="size-4 text-primary" />;
  }
  if (normalized.includes("cs")) {
    return <Coins className="size-4 text-primary" />;
  }
  if (normalized.includes("build")) {
    return <Hammer className="size-4 text-primary" />;
  }
  if (normalized.includes("objective")) {
    return <Flag className="size-4 text-primary" />;
  }

  return <ShieldAlert className="size-4 text-primary" />;
}

function priorityClasses(priority: PatternAlertProps["pattern"]["priority"]) {
  if (priority === "high") {
    return {
      border: "border-l-[#ef4444]",
      badge: "bg-[#ef4444] text-white",
    };
  }
  if (priority === "medium") {
    return {
      border: "border-l-[#f59e0b]",
      badge: "bg-[#f59e0b] text-black",
    };
  }

  return {
    border: "border-l-[#10b981]",
    badge: "bg-[#10b981] text-black",
  };
}

export function PatternAlert({ pattern, type }: PatternAlertProps) {
  const style = priorityClasses(pattern.priority);

  return (
    <Card className={cn("border-border/70 border-l-4 bg-card/90", style.border)}>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TypeIcon type={type} />
            <CardTitle className="text-base">{pattern.pattern_name}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{pattern.frequency}</Badge>
            <Badge className={style.badge}>{pattern.priority.toUpperCase()}</Badge>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{pattern.description}</p>
      </CardHeader>
      <CardContent>
        <details className="rounded-md border border-border/60 bg-background/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Show Root Cause and Fix
          </summary>
          <div className="mt-3 space-y-3 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Root Cause
              </p>
              <p className="mt-1 text-muted-foreground">{pattern.root_cause}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Specific Fix
              </p>
              <p className="mt-1 text-foreground">{pattern.specific_fix}</p>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
