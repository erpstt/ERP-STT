export function getSupabaseConfig() {
    const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey } = process.env;
    return url && anonKey ? { url, anonKey } : null;
}
