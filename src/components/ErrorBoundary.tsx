"use client";

import type { ReactNode } from "react";
import { Component } from "react";

import { ErrorCard } from "@/components/ErrorCard";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
  title?: string;
  description?: string;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
    };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: unknown) {
    console.error("[ErrorBoundary] Caught render error:", error);
  }

  private reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <ErrorCard
        title={this.props.title ?? "Something went wrong."}
        description={this.props.description ?? "Please try refreshing."}
        onRetry={this.reset}
      />
    );
  }
}
