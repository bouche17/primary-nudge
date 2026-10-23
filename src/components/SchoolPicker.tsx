import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, CheckCircle2 } from "lucide-react";
import { repeatedNames, schoolOneLine, schoolResultLabel } from "../../supabase/functions/_shared/schoolLabel.ts";

export interface PickedSchool {
  id: string;
  name: string;
  postcode: string;
  address: string | null;
  town: string | null;
  local_authority: string | null;
  urn: string;
}

/** Search by school name, town or postcode → pick → "Is this X's school?" confirm. URN stays the real identifier. */
const SchoolPicker = ({ childName, onConfirm, onCancel }: { childName?: string; onConfirm: (s: PickedSchool) => void; onCancel?: () => void }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedSchool[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<PickedSchool | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      setSearching(true);
      const { data } = await supabase.rpc("search_schools", { _q: q, _limit: 20 });
      if (live) { setResults((data as PickedSchool[]) ?? []); setSearching(false); }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const whose = childName?.trim() ? `${childName.trim()}'s` : "your child's";

  if (picked) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-secondary p-4">
          <p className="text-sm text-muted-foreground mb-1">Is this {whose} school?</p>
          <p className="font-semibold text-foreground">{schoolOneLine(picked)}</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button onClick={() => onConfirm(picked)} className="flex-1 rounded-full font-cta font-bold">
            <CheckCircle2 className="w-4 h-4 mr-2" /> Yes, that's right
          </Button>
          <Button variant="outline" onClick={() => setPicked(null)} className="flex-1 rounded-full font-cta font-semibold">
            Choose a different school
          </Button>
        </div>
      </div>
    );
  }

  const repeated = repeatedNames(results);
  return (
    <div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. St Joseph's Sale, or M33 3AF" className="pl-10" autoFocus aria-label="Search for a school" />
      </div>
      <p className="text-xs text-muted-foreground mt-2">Search by school name, town or postcode.</p>
      {searching && <p className="text-xs text-muted-foreground mt-2">Searching…</p>}
      {results.length > 0 && (
        <div className="mt-3 space-y-1 max-h-72 overflow-y-auto">
          {results.map((s) => {
            const l = schoolResultLabel(s, repeated);
            return (
              <button key={s.id} onClick={() => setPicked(s)} className="w-full text-left p-3 rounded-xl hover:bg-secondary transition-colors">
                <p className="font-semibold text-sm text-foreground">{l.primary}</p>
                <p className="text-xs text-muted-foreground">{l.secondary}</p>
              </button>
            );
          })}
        </div>
      )}
      {query.trim().length >= 2 && !searching && results.length === 0 && (
        <p className="text-sm text-muted-foreground mt-3">No schools found. Try the town or postcode.</p>
      )}
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel} className="mt-3 w-full text-muted-foreground">Cancel</Button>
      )}
    </div>
  );
};

export default SchoolPicker;
