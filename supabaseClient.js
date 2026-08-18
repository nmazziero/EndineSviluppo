import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Variabili Supabase mancanti. Controlla il file .env (VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY)."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

const TABLE = "dashboard_kv";

// Semplice storage chiave/valore su Supabase, stessa forma logica
// del vecchio window.storage.get/set usato nell'artifact Claude.
export async function kvGet(key) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.error("Supabase get error:", error);
    throw error;
  }
  return data ? data.value : null;
}

export async function kvSet(key, value) {
  const { error } = await supabase
    .from(TABLE)
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) {
    console.error("Supabase set error:", error);
    throw error;
  }
  return true;
}
