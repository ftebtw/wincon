import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";

import { Footer } from "@/components/Footer";
import { SearchBar } from "@/components/SearchBar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { db, schema } from "@/lib/db";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "WinCon.gg - AI-Powered League of Legends Coaching",
    template: "%s - WinCon.gg",
  },
  description:
    "Get AI coaching that tells you exactly what went wrong in your League of Legends games and how to fix it. Win probability analysis, pattern detection, and loading screen scouting.",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#3b82f6",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let hasPBEChanges = false;
  if (process.env.DATABASE_URL) {
    try {
      const rows = await db
        .select({ id: schema.pbeDiffs.id })
        .from(schema.pbeDiffs)
        .where(eq(schema.pbeDiffs.isLatest, true))
        .limit(1);
      hasPBEChanges = rows.length > 0;
    } catch {
      hasPBEChanges = false;
    }
  }

  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TooltipProvider>
          <div className="flex min-h-screen flex-col">
            <header className="border-b border-border/60 bg-background/90 backdrop-blur">
              <div className="mx-auto grid w-full max-w-7xl grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Link
                    href="/"
                    className="whitespace-nowrap text-lg font-semibold tracking-tight text-primary"
                  >
                    WinCon.gg
                  </Link>
                  <Link
                    href="/champions"
                    className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
                  >
                    Champions
                  </Link>
                  <Link
                    href="/pro"
                    className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
                  >
                    Pro
                  </Link>
                  {hasPBEChanges ? (
                    <Link
                      href="/pbe"
                      className="hidden items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
                    >
                      PBE
                      <span className="size-1.5 rounded-full bg-[#ef4444]" />
                    </Link>
                  ) : null}
                </div>

                <SearchBar compact className="mx-auto w-full max-w-xl" />

                <div className="flex items-center justify-self-end gap-2 sm:hidden">
                  <Link
                    href="/champions"
                    className="inline-flex rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground"
                  >
                    Champs
                  </Link>
                  <Link
                    href="/pro"
                    className="inline-flex rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground"
                  >
                    Pro
                  </Link>
                  {hasPBEChanges ? (
                    <Link
                      href="/pbe"
                      className="inline-flex rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground"
                    >
                      PBE
                    </Link>
                  ) : null}
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="justify-self-end">
                      NA
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem>NA</DropdownMenuItem>
                    <DropdownMenuItem>EUW</DropdownMenuItem>
                    <DropdownMenuItem>EUNE</DropdownMenuItem>
                    <DropdownMenuItem>KR</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>

            <main className="flex-1">{children}</main>

            <Footer />
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
