"use client";

import { useEffect } from "react";

import { ErrorCard } from "@/components/ErrorCard";

type LiveGameErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function LiveGameError({ error, reset }: LiveGameErrorProps) {
  useEffect(() => {
    console.error("[LiveGamePage] Render error:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <ErrorCard
        title="Live Scout Unavailable"
        description="Something went wrong. Please try refreshing."
        onRetry={reset}
      />
    </div>
  );
}
