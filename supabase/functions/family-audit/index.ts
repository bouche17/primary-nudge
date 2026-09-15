import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return json({ error: "Forbidden" }, 403);

    const [profilesRes, linksRes, childrenRes, remindersRes, notesRes, schoolsRes] = await Promise.all([
      admin.from("profiles").select("user_id, phone_number, created_at"),
      admin.from("linked_accounts").select("primary_user_id, linked_user_id, status, accepted_at"),
      admin.from("children").select("id, parent_id, first_name, year_group, school_id"),
      admin
        .from("child_reminders")
        .select("id, child_id, parent_id, title, emoji, day_of_week, reminder_time, active"),
      admin
        .from("parent_notes")
        .select("id, phone_number, child_name, summary, extracted_dates, created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      admin.from("schools").select("id, name"),
    ]);

    const profiles = profilesRes.data ?? [];
    const links = (linksRes.data ?? []).filter((l) => l.status === "accepted");
    const children = childrenRes.data ?? [];
    const reminders = remindersRes.data ?? [];
    const notes = notesRes.data ?? [];
    const schoolNames = new Map((schoolsRes.data ?? []).map((s) => [s.id, s.name]));

    // Union-find over accepted links
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let root = parent.get(x)!;
      if (root !== x) {
        root = find(root);
        parent.set(x, root);
      }
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const p of profiles) find(p.user_id);
    for (const l of links) union(l.primary_user_id, l.linked_user_id);

    const groups = new Map<string, string[]>();
    for (const p of profiles) {
      const root = find(p.user_id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(p.user_id);
    }

    const profileByUser = new Map(profiles.map((p) => [p.user_id, p]));
    const linkByPair = new Map(
      links.map((l) => [`${l.primary_user_id}|${l.linked_user_id}`, l]),
    );

    const families = Array.from(groups.entries()).map(([root, userIds]) => {
      const memberPhones = userIds
        .map((id) => profileByUser.get(id)?.phone_number)
        .filter((p): p is string => !!p);

      const familyChildren = children.filter((c) => userIds.includes(c.parent_id));
      const childIds = familyChildren.map((c) => c.id);

      return {
        id: root,
        members: userIds.map((id) => {
          const isPrimary = links.some((l) => l.primary_user_id === id);
          const linkedAs = links.find(
            (l) => l.linked_user_id === id && userIds.includes(l.primary_user_id),
          );
          return {
            user_id: id,
            phone_number: profileByUser.get(id)?.phone_number ?? null,
            role: linkedAs ? "partner" : isPrimary ? "primary" : "solo",
            accepted_at: linkedAs?.accepted_at ?? null,
            // Phones this member's actions would notify
            notifies: memberPhones.filter((p) => p !== profileByUser.get(id)?.phone_number),
          };
        }),
        children: familyChildren.map((c) => ({
          id: c.id,
          first_name: c.first_name,
          year_group: c.year_group,
          owner_user_id: c.parent_id,
          school_name: schoolNames.get(c.school_id) ?? null,
        })),
        reminders: reminders
          .filter((r) => childIds.includes(r.child_id))
          .map((r) => ({
            id: r.id,
            title: r.title,
            emoji: r.emoji,
            day_of_week: r.day_of_week,
            reminder_time: r.reminder_time,
            active: r.active,
            child_name: familyChildren.find((c) => c.id === r.child_id)?.first_name ?? "Unknown",
          })),
        notes: notes
          .filter((n) => memberPhones.includes(n.phone_number))
          .slice(0, 25)
          .map((n) => ({
            id: n.id,
            child_name: n.child_name,
            summary: n.summary,
            phone_number: n.phone_number,
            dates: Array.isArray(n.extracted_dates)
              ? (n.extracted_dates as Array<Record<string, unknown>>)
                  .map((d) => String(d?.date ?? ""))
                  .filter(Boolean)
              : [],
            created_at: n.created_at,
          })),
      };
    });

    // Families with a linked partner first, then bigger families
    families.sort((a, b) => b.members.length - a.members.length);

    const templates = {
      partner_reminder: !!Deno.env.get("TWILIO_PARTNER_REMINDER_TEMPLATE_SID"),
      partner_note: !!Deno.env.get("TWILIO_PARTNER_NOTE_TEMPLATE_SID"),
      partner_lunch: !!Deno.env.get("TWILIO_PARTNER_LUNCH_TEMPLATE_SID"),
    };

    return json({ families, templates, generated_at: new Date().toISOString() });
  } catch (error) {
    console.error("family-audit error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
