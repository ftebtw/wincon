"use client";

import { useEffect } from "react";

import { ErrorCard } from "@/components/ErrorCard";

type MatchErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function MatchError({ error, reset }: MatchErrorProps) {
  useEffect(() => {
    console.error("[MatchPage] Render error:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <ErrorCard
        title="Match Analysis Unavailable"
        description="Something went wrong. Please try refreshing."
        onRetry={reset}
      />
    </div>
  );
}
