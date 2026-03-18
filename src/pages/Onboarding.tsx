import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, Search, Plus, Trash2, ArrowRight, CheckCircle2, MessageCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { isValidPhone, normalizePhone } from "@/lib/phone";

interface School {
  id: string;
  name: string;
  postcode: string;
  address: string | null;
  local_authority: string | null;
}

interface ChildEntry {
  first_name: string;
  year_group: string;
  school_id: string;
  school_name: string;
}

const YEAR_GROUPS = [
  "Nursery",
  "Reception",
  "Year 1",
  "Year 2",
  "Year 3",
  "Year 4",
  "Year 5",
  "Year 6",
];

const Onboarding = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [step, setStep] = useState<"phone" | "school" | "children" | "done">("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [savingPhone, setSavingPhone] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [schools, setSchools] = useState<School[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);

  const [children, setChildren] = useState<ChildEntry[]>([]);
  const [currentChild, setCurrentChild] = useState<Partial<ChildEntry>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/login");
    }
  }, [user, authLoading, navigate]);

  // Check if user already has children (already onboarded) or already has phone
  useEffect(() => {
    if (!user) return;
    const fromDashboard = new URLSearchParams(window.location.search).get("add") === "true";
    
    // Check profile for existing phone number
    supabase
      .from("profiles")
      .select("phone_number")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data: profile }) => {
        if (profile?.phone_number) {
          // Already has phone, skip to school step
          setPhoneNumber(profile.phone_number);
          if (step === "phone") setStep("school");
        }
      });

    if (!fromDashboard) {
      supabase
        .from("children")
        .select("id")
        .eq("parent_id", user.id)
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) {
            navigate("/dashboard");
          }
        });
    }
  }, [user, navigate]);

  const searchSchools = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSchools([]);
      return;
    }
    setSearching(true);
    const { data } = await supabase
      .from("schools")
      .select("id, name, postcode, address, local_authority")
      .or(`name.ilike.%${query}%,postcode.ilike.%${query}%`)
      .limit(10);
    setSchools(data || []);
    setSearching(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => searchSchools(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchSchools]);

  const savePhone = async () => {
    if (!phoneNumber.trim()) {
      toast({ title: "Phone number required", description: "Please enter your WhatsApp number so Monty can send you reminders.", variant: "destructive" });
      return;
    }
    if (!isValidPhone(phoneNumber)) {
      toast({ title: "Invalid phone number", description: "Please enter a valid international number starting with + (e.g. +44 7700 900000).", variant: "destructive" });
      return;
    }
    if (!user) return;

    setSavingPhone(true);
    const normalized = normalizePhone(phoneNumber);

    // Upsert profile with phone number
    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing) {
      await supabase.from("profiles").update({ phone_number: normalized }).eq("user_id", user.id);
    } else {
      await supabase.from("profiles").insert({ user_id: user.id, phone_number: normalized });
    }

    setSavingPhone(false);
    setStep("school");
  };

  const selectSchool = (school: School) => {
    setSelectedSchool(school);
    setCurrentChild((prev) => ({ ...prev, school_id: school.id, school_name: school.name }));
    setStep("children");
  };

  const addChild = () => {
    if (!currentChild.first_name?.trim() || !currentChild.year_group || !currentChild.school_id) {
      toast({ title: "Please fill in all fields", variant: "destructive" });
      return;
    }
    setChildren((prev) => [...prev, currentChild as ChildEntry]);
    setCurrentChild({ school_id: selectedSchool?.id, school_name: selectedSchool?.name });
  };

  const removeChild = (index: number) => {
    setChildren((prev) => prev.filter((_, i) => i !== index));
  };

  const addChildAtDifferentSchool = () => {
    setSelectedSchool(null);
    setCurrentChild({});
    setSearchQuery("");
    setSchools([]);
    setStep("school");
  };

  const finishOnboarding = async () => {
    // Auto-add current child if form is filled
    let allChildren = [...children];
    if (currentChild.first_name?.trim() && currentChild.year_group && currentChild.school_id) {
      allChildren = [...allChildren, currentChild as ChildEntry];
    }

    if (allChildren.length === 0) {
      toast({ title: "Add at least one child", variant: "destructive" });
      return;
    }
    if (!user) return;

    setSaving(true);
    const { error } = await supabase.from("children").insert(
      allChildren.map((child) => ({
        parent_id: user.id,
        school_id: child.school_id,
        first_name: child.first_name.trim(),
        year_group: child.year_group,
      }))
    );

    if (error) {
      toast({ title: "Error saving", description: error.message, variant: "destructive" });
      setSaving(false);
      return;
    }

    // Record consent
    await supabase.from("consent_records").insert({
      user_id: user.id,
      consent_type: "signup",
    });

    setStep("done");
    setSaving(false);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Sparkles className="w-8 h-8 text-primary animate-pulse-soft" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center mx-auto mb-4">
            <Sparkles className="w-5 h-5 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-display font-black text-foreground">
            {step === "done" ? "You're all set!" : "Set up your reminders"}
          </h1>
          {step !== "done" && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <div className={`w-3 h-3 rounded-full ${step === "phone" ? "bg-primary" : "bg-primary/30"}`} />
              <div className={`w-3 h-3 rounded-full ${step === "school" ? "bg-primary" : "bg-primary/30"}`} />
              <div className={`w-3 h-3 rounded-full ${step === "children" ? "bg-primary" : "bg-primary/30"}`} />
            </div>
          )}
        </div>

        <AnimatePresence mode="wait">
          {/* Step 1: WhatsApp number */}
          {step === "phone" && (
            <motion.div
              key="phone"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-card rounded-2xl p-6 border border-border shadow-sm"
            >
              <div className="flex items-center gap-2 mb-1">
                <MessageCircle className="w-5 h-5 text-primary" />
                <h2 className="font-heading font-bold text-lg text-foreground">Your WhatsApp number</h2>
              </div>
              <p className="text-muted-foreground text-sm mb-5">
                Monty will send your reminders here. We'll only use it for school updates — nothing else!
              </p>

              <div className="space-y-2">
                <Label htmlFor="phone">Phone number</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+44 7700 900000"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Enter your number in international format, e.g. +44 7700 900000
                </p>
              </div>

              <Button
                onClick={savePhone}
                disabled={savingPhone}
                className="w-full rounded-full font-cta font-bold mt-5"
              >
                {savingPhone ? "Saving…" : "Continue"}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </motion.div>
          )}

          {/* Step 2: Find school */}
          {step === "school" && (
            <motion.div
              key="school"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-card rounded-2xl p-6 border border-border shadow-sm"
            >
              <h2 className="font-heading font-bold text-lg text-foreground mb-1">Find your school</h2>
              <p className="text-muted-foreground text-sm mb-4">Search by school name or postcode</p>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="e.g. St Mary's or SW1A 1AA"
                  className="pl-10"
                  autoFocus
                />
              </div>

              {searching && <p className="text-xs text-muted-foreground mt-2">Searching…</p>}

              {schools.length > 0 && (
                <div className="mt-3 space-y-1 max-h-64 overflow-y-auto">
                  {schools.map((school) => (
                    <button
                      key={school.id}
                      onClick={() => selectSchool(school)}
                      className="w-full text-left p-3 rounded-xl hover:bg-secondary transition-colors"
                    >
                      <p className="font-semibold text-sm text-foreground">{school.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {school.postcode}
                        {school.local_authority && ` · ${school.local_authority}`}
                      </p>
                    </button>
                  ))}
                </div>
              )}

              {searchQuery.length >= 2 && !searching && schools.length === 0 && (
                <p className="text-sm text-muted-foreground mt-3">No schools found. Try a different search.</p>
              )}
            </motion.div>
          )}

          {/* Step 2: Add children */}
          {step === "children" && (
            <motion.div
              key="children"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-card rounded-2xl p-6 border border-border shadow-sm"
            >
              <h2 className="font-heading font-bold text-lg text-foreground mb-1">Add your children</h2>
              <p className="text-muted-foreground text-sm mb-4">
                At <strong>{selectedSchool?.name}</strong>
              </p>

              {/* Existing children list */}
              {children.length > 0 && (
                <div className="space-y-2 mb-4">
                  {children.map((child, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between bg-secondary rounded-xl px-4 py-3"
                    >
                      <div>
                        <p className="font-semibold text-sm text-foreground">{child.first_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {child.year_group} · {child.school_name}
                        </p>
                      </div>
                      <button onClick={() => removeChild(i)} className="text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add child form */}
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>First name</Label>
                  <Input
                    value={currentChild.first_name || ""}
                    onChange={(e) => setCurrentChild((prev) => ({ ...prev, first_name: e.target.value }))}
                    placeholder="e.g. Ella"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Year group</Label>
                  <Select
                    value={currentChild.year_group || ""}
                    onValueChange={(value) => setCurrentChild((prev) => ({ ...prev, year_group: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select year group" />
                    </SelectTrigger>
                    <SelectContent>
                      {YEAR_GROUPS.map((yg) => (
                        <SelectItem key={yg} value={yg}>{yg}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addChild}
                    className="flex-1 rounded-full font-cta font-semibold"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add child
                  </Button>
                </div>
              </div>

              <div className="border-t border-border mt-5 pt-4 space-y-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addChildAtDifferentSchool}
                  className="w-full text-muted-foreground font-heading"
                >
                  Add a child at a different school
                </Button>
                <Button
                  onClick={finishOnboarding}
                  disabled={children.length === 0 || saving}
                  className="w-full rounded-full font-cta font-bold"
                >
                  {saving ? "Saving…" : "Finish setup"}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            </motion.div>
          )}

          {/* Done */}
          {step === "done" && (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-card rounded-2xl p-8 border border-border shadow-sm text-center"
            >
              <CheckCircle2 className="w-12 h-12 text-primary mx-auto mb-4" />
              <h2 className="font-heading font-bold text-xl text-foreground mb-2">You're all set!</h2>
              <p className="text-muted-foreground text-sm mb-6">
                Monty will send you reminders about what's happening at school. You can manage your children and settings anytime.
              </p>
              <Button
                onClick={() => navigate("/dashboard")}
                className="rounded-full font-cta font-bold px-8"
              >
                Go to dashboard
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default Onboarding;
