import React from "react";

interface Props { children: React.ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 24, color: "#ff6b6b", background: "#1a1a2e",
          fontFamily: "monospace", fontSize: 13, whiteSpace: "pre-wrap",
          height: "100vh", overflow: "auto"
        }}>
          <h2 style={{ color: "#ff4444", marginBottom: 12 }}>React Error</h2>
          <p><strong>{this.state.error.message}</strong></p>
          <pre style={{ marginTop: 12, color: "#999", fontSize: 11 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16, padding: "8px 16px", background: "#333",
              color: "#fff", border: "1px solid #555", borderRadius: 4, cursor: "pointer"
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
