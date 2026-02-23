import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

// Cache admin status per user to avoid re-querying on every mount
const adminCache = new Map<string, boolean>();

export const useAdmin = () => {
  const { user, loading: authLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean>(() => {
    if (user && adminCache.has(user.id)) return adminCache.get(user.id)!;
    return false;
  });
  const [loading, setLoading] = useState<boolean>(() => {
    // If auth is still loading, we're loading too
    if (authLoading) return true;
    // If we have a cached result, we're not loading
    if (user && adminCache.has(user.id)) return false;
    // If no user, we're not loading (just not admin)
    if (!user) return false;
    // Otherwise we need to query
    return true;
  });

  useEffect(() => {
    // Wait for auth to finish loading
    if (authLoading) {
      setLoading(true);
      return;
    }

    if (!user) {
      setIsAdmin(false);
      setLoading(false);
      return;
    }

    // Use cached value if available
    if (adminCache.has(user.id)) {
      setIsAdmin(adminCache.get(user.id)!);
      setLoading(false);
      return;
    }

    setLoading(true);
    supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          console.error("Error checking admin role:", error);
        }
        const result = !!data;
        adminCache.set(user.id, result);
        setIsAdmin(result);
        setLoading(false);
      });
  }, [user, authLoading]);

  return { isAdmin, loading };
};
