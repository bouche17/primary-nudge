import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Sparkles,
  ArrowLeft,
  Plus,
  Trash2,
  Save,
  GripVertical,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { Json } from "@/integrations/supabase/types";

interface BotFlowOption {
  keyword: string;
  label: string;
  next_step: string;
}

interface BotFlow {
  id: string;
  step_name: string;
  message_template: string;
  options: BotFlowOption[];
  next_step: string | null;
  sort_order: number;
  created_at: string;
}

function parseOptions(raw: Json | null): BotFlowOption[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw as unknown as BotFlowOption[];
}

const BotFlows = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [flows, setFlows] = useState<BotFlow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate("/login");
  }, [user, loading, navigate]);

  const fetchFlows = async () => {
    const { data, error } = await supabase
      .from("bot_flows")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) {
      toast({ title: "Error loading flows", description: error.message, variant: "destructive" });
      return;
    }
    setFlows(
      (data || []).map((f) => ({
        ...f,
        options: parseOptions(f.options),
      }))
    );
  };

  useEffect(() => {
    if (user) fetchFlows();
  }, [user]);

  const updateField = (id: string, field: keyof BotFlow, value: unknown) => {
    setFlows((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value } : f))
    );
  };

  const updateOption = (flowId: string, optIdx: number, field: keyof BotFlowOption, value: string) => {
    setFlows((prev) =>
      prev.map((f) => {
        if (f.id !== flowId) return f;
        const newOpts = [...f.options];
        newOpts[optIdx] = { ...newOpts[optIdx], [field]: value };
        return { ...f, options: newOpts };
      })
    );
  };

  const addOption = (flowId: string) => {
    setFlows((prev) =>
      prev.map((f) => {
        if (f.id !== flowId) return f;
        return { ...f, options: [...f.options, { keyword: "", label: "", next_step: "" }] };
      })
    );
  };

  const removeOption = (flowId: string, optIdx: number) => {
    setFlows((prev) =>
      prev.map((f) => {
        if (f.id !== flowId) return f;
        return { ...f, options: f.options.filter((_, i) => i !== optIdx) };
      })
    );
  };

  const saveFlow = async (flow: BotFlow) => {
    setSaving(flow.id);
    const { error } = await supabase
      .from("bot_flows")
      .update({
        step_name: flow.step_name,
        message_template: flow.message_template,
        options: flow.options as unknown as Json,
        next_step: flow.next_step || null,
        sort_order: flow.sort_order,
      })
      .eq("id", flow.id);
    setSaving(null);
    if (error) {
      toast({ title: "Error saving", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Step saved ✓" });
    }
  };

  const addFlow = async () => {
    const maxOrder = flows.reduce((max, f) => Math.max(max, f.sort_order), 0);
    const { data, error } = await supabase
      .from("bot_flows")
      .insert({
        step_name: "new_step",
        message_template: "Enter your message here...",
        sort_order: maxOrder + 1,
      })
      .select()
      .single();
    if (error) {
      toast({ title: "Error adding step", description: error.message, variant: "destructive" });
      return;
    }
    const newFlow: BotFlow = { ...data, options: parseOptions(data.options) };
    setFlows((prev) => [...prev, newFlow]);
    setExpandedId(newFlow.id);
  };

  const deleteFlow = async (id: string) => {
    const { error } = await supabase.from("bot_flows").delete().eq("id", id);
    if (error) {
      toast({ title: "Error deleting", description: error.message, variant: "destructive" });
      return;
    }
    setFlows((prev) => prev.filter((f) => f.id !== id));
    toast({ title: "Step deleted" });
  };

  if (loading) return null;

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-heading font-black text-lg text-foreground">Monty</span>
        </div>
        <Link to="/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" /> Dashboard
          </Button>
        </Link>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display font-black text-foreground mb-1">Bot Flow Editor</h1>
            <p className="text-muted-foreground text-sm">Manage Monty's conversation steps.</p>
          </div>
          <Button onClick={addFlow} className="rounded-full font-cta font-semibold">
            <Plus className="w-4 h-4 mr-2" /> Add Step
          </Button>
        </div>

        <div className="space-y-3">
          {flows.map((flow) => {
            const isExpanded = expandedId === flow.id;
            return (
              <div
                key={flow.id}
                className="bg-card rounded-2xl border border-border overflow-hidden"
              >
                {/* Header */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : flow.id)}
                  className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <GripVertical className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="font-heading font-bold text-foreground">{flow.step_name}</p>
                      <p className="text-xs text-muted-foreground truncate max-w-md">
                        {flow.message_template.slice(0, 80)}…
                      </p>
                    </div>
                  </div>
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>

                {/* Expanded editor */}
                {isExpanded && (
                  <div className="px-5 pb-5 space-y-4 border-t border-border pt-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs font-semibold text-muted-foreground mb-1 block">
                          Step Name
                        </label>
                        <Input
                          value={flow.step_name}
                          onChange={(e) => updateField(flow.id, "step_name", e.target.value)}
                          className="font-mono text-sm"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-muted-foreground mb-1 block">
                          Default Next Step
                        </label>
                        <Input
                          value={flow.next_step || ""}
                          onChange={(e) => updateField(flow.id, "next_step", e.target.value)}
                          placeholder="(none)"
                          className="font-mono text-sm"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-semibold text-muted-foreground mb-1 block">
                        Message Template
                      </label>
                      <Textarea
                        value={flow.message_template}
                        onChange={(e) => updateField(flow.id, "message_template", e.target.value)}
                        rows={5}
                        className="text-sm"
                      />
                    </div>

                    {/* Options */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-semibold text-muted-foreground">
                          Options ({flow.options.length})
                        </label>
                        <Button variant="ghost" size="sm" onClick={() => addOption(flow.id)}>
                          <Plus className="w-3 h-3 mr-1" /> Add
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {flow.options.map((opt, i) => (
                          <div key={i} className="flex items-center gap-2 bg-muted/50 rounded-xl p-3">
                            <Input
                              value={opt.keyword}
                              onChange={(e) => updateOption(flow.id, i, "keyword", e.target.value)}
                              placeholder="Keyword"
                              className="w-20 text-xs font-mono"
                            />
                            <Input
                              value={opt.label}
                              onChange={(e) => updateOption(flow.id, i, "label", e.target.value)}
                              placeholder="Label"
                              className="flex-1 text-xs"
                            />
                            <Input
                              value={opt.next_step}
                              onChange={(e) => updateOption(flow.id, i, "next_step", e.target.value)}
                              placeholder="Next step"
                              className="w-32 text-xs font-mono"
                            />
                            <button
                              onClick={() => removeOption(flow.id, i)}
                              className="text-muted-foreground hover:text-destructive transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-between pt-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteFlow(flow.id)}
                        className="rounded-full"
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete Step
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveFlow(flow)}
                        disabled={saving === flow.id}
                        className="rounded-full font-cta font-semibold"
                      >
                        <Save className="w-3.5 h-3.5 mr-1" />
                        {saving === flow.id ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {flows.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-sm">No bot flow steps yet. Click "Add Step" to get started.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default BotFlows;
