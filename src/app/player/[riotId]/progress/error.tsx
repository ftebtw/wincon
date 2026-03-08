"use client";

import { useEffect } from "react";

import { ErrorCard } from "@/components/ErrorCard";

type PlayerProgressErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function PlayerProgressError({ error, reset }: PlayerProgressErrorProps) {
  useEffect(() => {
    console.error("[PlayerProgressPage] Render error:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <ErrorCard
        title="Unable To Load Progress"
        description="Something went wrong. Please try refreshing."
        onRetry={reset}
      />
    </div>
  );
}
