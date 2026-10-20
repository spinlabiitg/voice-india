/* Backend settings. Leave SUPABASE_URL empty to run the page as a mock-up (nothing is uploaded).
   Both values below are PUBLIC by design (they are visible in any web page that uses them):
     - SUPABASE_URL:      Project Settings -> API -> Project URL
     - SUPABASE_ANON_KEY: Project Settings -> API Keys -> the "anon" / "publishable" key
   NEVER put the service_role / secret key here or anywhere in site/. */
window.LYV_CONFIG = {
  SUPABASE_URL: "https://vholrkoygikucmveytsb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_IVqbJUxlYNAHTYqWK_qUVA_3qcUiQEp",
  // Cloudflare Turnstile site key (public). Empty = no bot check. The matching SECRET key goes only
  // into Supabase -> Authentication -> Attack Protection -> CAPTCHA, never here.
  TURNSTILE_SITE_KEY: "",
  // shown to contributors for questions
  CONTACT_EMAIL: "neerajs@iitg.ac.in",
  APP_VERSION: "0.2-pilot",
};
