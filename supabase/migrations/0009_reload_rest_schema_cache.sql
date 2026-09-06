-- MundusX migration 0009: ask Supabase PostgREST to reload schema after policy-column repairs.

notify pgrst, 'reload schema';
