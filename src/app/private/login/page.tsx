"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function PrivateLoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/private/betting";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch("/api/private/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        password,
        next: nextPath,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      next?: string;
    };

    if (!response.ok) {
      setError(payload.error ?? "Unable to authenticate.");
      setLoading(false);
      return;
    }

    router.replace(payload.next ?? nextPath);
    router.refresh();
  };

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Private Betting Access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter the private admin password. This section is hidden and not indexed.
          </p>

          <form className="space-y-3" onSubmit={onSubmit}>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Admin password"
              autoComplete="current-password"
              required
            />
            {error ? <p className="text-sm text-[#f87171]">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Checking..." : "Enter"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

