-- Pin search_path on trigger functions (Supabase advisor: function_search_path_mutable).
alter function public.audit_log_immutable() set search_path = '';
alter function public.touch_updated_at() set search_path = '';
