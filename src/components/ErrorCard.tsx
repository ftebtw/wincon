"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ErrorCardProps = {
  title?: string;
  description?: string;
  statusCode?: number;
  retryAfterSeconds?: number | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

function defaultTitle(statusCode?: number): string {
  if (statusCode === 404) {
    return "We couldn't find that summoner.";
  }
  if (statusCode === 429) {
    return "We're fetching data too fast.";
  }
  if (statusCode === 503) {
    return "Riot's servers are having issues.";
  }
  return "Something went wrong.";
}

function defaultDescription(statusCode?: number): string {
  if (statusCode === 404) {
    return "Double-check the Riot ID and region.";
  }
  if (statusCode === 429) {
    return "Retrying shortly.";
  }
  if (statusCode === 503) {
    return "Please try again in a few minutes.";
  }
  return "Please try refreshing.";
}

export function ErrorCard({
  title,
  description,
  statusCode,
  retryAfterSeconds,
  onRetry,
  retryLabel = "Retry",
  className,
}: ErrorCardProps) {
  const [countdown, setCountdown] = useState<number | null>(
    typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? retryAfterSeconds : null,
  );

  useEffect(() => {
    if (typeof retryAfterSeconds !== "number" || retryAfterSeconds <= 0) {
      const timer = window.setTimeout(() => {
        setCountdown(null);
      }, 0);

      return () => {
        window.clearTimeout(timer);
      };
    }

    const timer = window.setTimeout(() => {
      setCountdown(retryAfterSeconds);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [retryAfterSeconds]);

  useEffect(() => {
    if (countdown === null || countdown <= 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCountdown((previous) => {
        if (previous === null) {
          return null;
        }

        return previous - 1;
      });
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [countdown]);

  useEffect(() => {
    if (countdown !== 0 || !onRetry) {
      return;
    }

    onRetry();
  }, [countdown, onRetry]);

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center gap-3">
        <AlertTriangle className="size-5 text-[#ef4444]" />
        <CardTitle>{title ?? defaultTitle(statusCode)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>{description ?? defaultDescription(statusCode)}</p>
        {statusCode === 429 && countdown !== null && countdown > 0 ? (
          <p className="text-[#f59e0b]">Retrying in {countdown}s...</p>
        ) : null}
        {onRetry ? (
          <Button onClick={onRetry} variant="outline" size="sm">
            <RotateCw className="mr-2 size-4" />
            {retryLabel}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
