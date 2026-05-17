import type { DBUser } from "./types";
import { api } from "./api";

export interface AuthState {
  user: DBUser | null;
  loading: boolean;
  error: string | null;
}

export async function login(username: string, password: string): Promise<DBUser> {
  const result = await api.login(username, password);
  return result.user;
}

export async function logout(): Promise<void> {
  await api.logout();
}

export async function loadCurrentUser(): Promise<DBUser | null> {
  try {
    const result = await api.me();
    return result.user;
  } catch {
    return null;
  }
}
