import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Starting GIAS school data import...");

    // Use the DfE GIAS JSON data (archived but still hosted on GitHub Pages)
    const jsonUrl = "https://dfe-digital.github.io/gias-data/schools.json";

    console.log("Fetching JSON from GIAS data...");
    const response = await fetch(jsonUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch JSON: ${response.status}`);
    }

    const allSchools = await response.json();
    console.log(`Got ${allSchools.length} total schools`);

    // Filter for primary phase schools that are open
    // Fields: urn, name, phase, status, address, postcode, local_authority_code, local_authority_name
    const primarySchools = allSchools.filter((s: any) => {
      const phase = (s.phase_of_education || "").toLowerCase();
      const status = (s.status || "").toLowerCase();
      return phase === "primary" && status === "open";
    });

    console.log(`Found ${primarySchools.length} open primary schools`);

    if (primarySchools.length === 0) {
      // Debug: log sample data
      console.log("Sample school:", JSON.stringify(allSchools[0]));
      
      // Try broader matching
      const phases = new Set(allSchools.map((s: any) => s.phase));
      console.log("Available phases:", [...phases]);
      
      throw new Error("No primary schools found. Check phase field values.");
    }

    // Clear existing schools
    console.log("Clearing existing schools...");
    await supabase.from("schools").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    // Insert in batches
    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < primarySchools.length; i += BATCH_SIZE) {
      const batch = primarySchools.slice(i, i + BATCH_SIZE).map((s: any) => {
        const addressParts = [s.address_1, s.address_2, s.address_3].filter(Boolean);
        return {
          name: s.name,
          postcode: s.postcode || "",
          urn: String(s.urn),
          address: addressParts.join(", ") || null,
          local_authority: s.local_authority || null,
        };
      });

      const { error } = await supabase.from("schools").upsert(batch, {
        onConflict: "urn",
      });

      if (error) {
        console.error(`Batch error at ${i}:`, error.message);
      } else {
        inserted += batch.length;
      }

      // Log progress
      if ((i / BATCH_SIZE) % 10 === 0) {
        console.log(`Progress: ${inserted}/${primarySchools.length}`);
      }
    }

    console.log(`Import complete. Inserted ${inserted} primary schools.`);

    return new Response(
      JSON.stringify({
        success: true,
        total_schools: allSchools.length,
        primary_schools_found: primarySchools.length,
        inserted,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Import error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
