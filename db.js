// Supabase client. The only place credentials are read.

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const rawUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!rawUrl || !serviceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

// .env may hold either a full URL or just the project ref.
const url = rawUrl.startsWith('http')
  ? rawUrl
  : `https://${rawUrl}.supabase.co`;

// Service key: bypasses RLS, so every query must scope user_id itself.
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;
