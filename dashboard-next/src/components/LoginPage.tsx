import * as React from "react";
import { Lock } from "lucide-react";
import { login } from "@/lib/auth";
import type { DBUser } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function LoginPage({ onLogin }: { onLogin: (user: DBUser) => void }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-grid flex items-center justify-center p-6">
      <Card className="glass w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2 text-cyan-300">
            <Lock className="h-5 w-5" />
            <CardTitle>MAE Dashboard Login</CardTitle>
          </div>
          <CardDescription>Sign in to view sessions and steer agents.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <Input placeholder="Username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            <Input placeholder="Password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            {error ? <p className="text-sm text-red-300">{error}</p> : null}
            <Button className="w-full" type="submit" disabled={loading || !username.trim() || !password}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
