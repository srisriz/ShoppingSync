"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "./supabase";
import type { Family } from "./types";

const GROUP_KEY = "shoppingsync.group";

export type GroupFamily = Family & { status?: string };

/**
 * The group this page works on.
 *  - A group login: always its own group.
 *  - The super user: the group chosen in the console (?g=<id>, remembered on this
 *    device), plus the list of all groups for the switcher. With no group chosen,
 *    the super user is sent to All groups.
 * Every page query must filter by family.id: the super user can read every group.
 */
export function useFamily(opts: { superHome?: boolean } = {}) {
  const router = useRouter();
  const [family, setFamily] = useState<GroupFamily | null>(null);
  const [isSuper, setIsSuper] = useState(false);
  const [groups, setGroups] = useState<GroupFamily[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: auth } = await supabase.auth.getSession();
      if (!auth.session) {
        router.replace("/login");
        return;
      }
      const { data: admin } = await supabase.rpc("is_admin");
      if (cancelled) return;

      if (admin === true) {
        setIsSuper(true);
        const { data: all } = await supabase.from("families")
          .select("id, name, whatsapp_group_name, status").order("name");
        const list = (all ?? []) as GroupFamily[];
        let wanted = new URLSearchParams(window.location.search).get("g");
        if (!wanted) { try { wanted = localStorage.getItem(GROUP_KEY); } catch { /* storage unavailable */ } }
        const chosen = list.find((g) => g.id === wanted) ?? null;
        if (cancelled) return;
        setGroups(list);
        if (!chosen) {
          if (!opts.superHome) router.replace("/admin");
          setLoading(false);
          return;
        }
        try { localStorage.setItem(GROUP_KEY, chosen.id); } catch { /* storage unavailable */ }
        setFamily(chosen);
        setLoading(false);
        return;
      }

      // Each group login manages exactly one group.
      const { data, error } = await supabase
        .from("families")
        .select("id, name, whatsapp_group_name, status")
        .eq("owner_id", auth.session.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) console.error(error);
      setFamily((data as GroupFamily) ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, opts.superHome]);

  /** Super user: switch to another group. */
  function selectGroup(id: string) {
    try { localStorage.setItem(GROUP_KEY, id); } catch { /* storage unavailable */ }
    window.location.href = `${window.location.pathname}?g=${id}`;
  }

  return { family, setFamily, isSuper, groups, selectGroup, loading };
}

export async function signOut() {
  try { localStorage.removeItem(GROUP_KEY); } catch { /* storage unavailable */ }
  await supabase.auth.signOut();
  window.location.href = "/login";
}
