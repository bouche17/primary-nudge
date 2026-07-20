import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listChildren from "./tools/list-children";
import listUpcoming from "./tools/list-upcoming";
import listRecurringReminders from "./tools/list-recurring-reminders";

// Build the OAuth issuer from the project ref (Vite inlines this at build time).
// Never derive it from SUPABASE_URL: on Lovable Cloud that's the .lovable.cloud
// proxy, and mcp-js rejects tokens whose issuer doesn't match discovery.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "monty-mcp",
  title: "Monty",
  version: "0.1.0",
  instructions:
    "Tools for Monty, the WhatsApp assistant for UK primary-school parents. " +
    "Use list_children to see the signed-in parent's children, list_upcoming_notes " +
    "for saved reminders from forwarded school messages, and list_recurring_reminders " +
    "for weekly things like PE kit or swimming.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listChildren, listUpcoming, listRecurringReminders],
});
