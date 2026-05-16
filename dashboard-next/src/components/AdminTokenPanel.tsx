import * as React from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { ApiTokenMeta, CreateApiTokenResponse, DBUser } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function AdminTokenPanel({ currentUser }: { currentUser: DBUser }) {
  const [tokens, setTokens] = React.useState<ApiTokenMeta[]>([]);
  const [users, setUsers] = React.useState<DBUser[]>([]);
  const [userId, setUserId] = React.useState(0);
  const [name, setName] = React.useState("Dashboard token");
  const [created, setCreated] = React.useState<CreateApiTokenResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTokens, nextUsers] = await Promise.all([api.adminTokens(), api.users()]);
      setTokens(nextTokens);
      setUsers(nextUsers);
      setUserId((current) => current || nextUsers[0]?.id || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin data");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  if (currentUser.role !== "admin") {
    return <Card className="glass"><CardContent className="p-6 text-red-300">Admin access required.</CardContent></Card>;
  }

  async function createToken() {
    setCreated(null);
    setError(null);
    try {
      const result = await api.createAdminToken(userId, name.trim());
      setCreated(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    }
  }

  async function revoke(id: number) {
    setError(null);
    try {
      await api.revokeAdminToken(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke token");
    }
  }

  return (
    <div className="min-h-screen bg-grid p-6 space-y-4">
      <Card className="glass">
        <CardHeader>
          <div className="flex items-center gap-2 text-cyan-300">
            <KeyRound className="h-5 w-5" />
            <CardTitle>API Tokens</CardTitle>
          </div>
          <CardDescription>Create and revoke API tokens. New token values are shown once.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <select className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" value={userId} onChange={(event) => setUserId(Number(event.target.value))}>
              {users.map((user) => <option key={user.id} value={user.id}>{user.display_name} ({user.username})</option>)}
            </select>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Token name" />
            <Button onClick={createToken} disabled={!userId || !name.trim()}>Create token</Button>
          </div>
          {created ? (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-semibold text-amber-200">Copy this token now. It will not be shown again.</p>
              <code className="mt-2 block break-all text-amber-100">{created.token}</code>
            </div>
          ) : null}
          {error ? <p className="text-sm text-red-300">{error}</p> : null}
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
        </CardContent>
      </Card>

      <Card className="glass">
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500 border-b border-zinc-800">
              <tr><th className="p-3">User</th><th>Name</th><th>Token</th><th>Created</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id} className="border-b border-zinc-900">
                  <td className="p-3">{token.username}</td>
                  <td>{token.name}</td>
                  <td><code>{token.token_prefix}…{token.last4}</code></td>
                  <td>{new Date(token.created_at).toLocaleString()}</td>
                  <td>{token.revoked_at ? "revoked" : "active"}</td>
                  <td className="p-3 text-right">{token.revoked_at ? null : <Button size="sm" variant="outline" onClick={() => revoke(token.id)}>Revoke</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
